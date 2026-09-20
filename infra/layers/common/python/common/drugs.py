"""
Shared drug-reference lookup + interaction checking.

This lives in the common layer rather than in src/drug/ because two callers
need the exact same rules:

  - src/drug/app.py   -- the EMT explicitly asks ("check epi + propranolol")
  - src/pcr/status.py -- the PCR pipeline auto-checks whatever medications
                         Bedrock extracted from the voice narration

One implementation means an interaction rule can't silently differ between
"the EMT asked" and "the PCR noticed".

Interactions are checked by two rule layers, and the merge direction
matters:

  1. **Curated pairs** (`contraindicated_with` + `interaction_notes`) --
     hand-authored, clinically phrased, agency-reviewable. These win.
  2. **Drug classes** (`classes` + `contraindicated_classes`) -- MoA/EPC
     class ids refreshed from NLM RxClass by
     `seed_tables.py --refresh-classes`. One rule covers a whole class, so
     vardenafil and avanafil flag against nitrates without anybody adding
     them to a list.

Layer 2 only ever *adds* flags. It must never be allowed to remove a
curated rule, because its coverage is patchy in exactly the places that
matter: RxClass has no contraindication relation at all between
epinephrine and propranolol, so the unopposed-alpha interaction -- this
project's headline cross-check -- exists only in layer 1. Swapping the
curated rules out for class rules would silently delete it.

Name resolution is the hard part, because these names arrive from speech.
Comprehend Medical's RxNorm linking alone is not enough: it maps "narcan"
to the concept *narcan* (the brand), not to "naloxone", and returns no
entities at all for clipped field slang like "epi" or "nitro". So the
table also carries alias rows ({"drug_name": "epi", "alias_of":
"epinephrine"}) and we try, in order: the literal name, then any alias row,
then RxNorm's suggestions. Adding a new nickname is a seed-data change, not
a code change.
"""
import os
from itertools import combinations
import boto3

dynamodb = boto3.resource("dynamodb")
comprehend_medical = boto3.client("comprehendmedical")

DRUG_TABLE = os.environ.get("DRUG_TABLE_NAME", "ems-copilot-drug-reference")
_drug_table = dynamodb.Table(DRUG_TABLE)

MAX_RXNORM_CANDIDATES = 5


def _get_row(key: str):
    return _drug_table.get_item(Key={"drug_name": key}).get("Item")


def _rxnorm_candidates(raw_name: str) -> list[str]:
    """Concept descriptions RxNorm thinks this text refers to, best first.
    Best-effort -- this must never be the reason a lookup fails."""
    try:
        resp = comprehend_medical.infer_rx_norm(Text=raw_name)
    except Exception:  # noqa: BLE001 -- normalization is best-effort
        return []
    scored = []
    for entity in resp.get("Entities", []):
        for concept in entity.get("RxNormConcepts", []):
            if concept.get("Description"):
                scored.append((concept.get("Score", 0), concept["Description"].lower()))
    scored.sort(key=lambda x: x[0], reverse=True)
    seen, out = set(), []
    for _, desc in scored:
        if desc not in seen:
            seen.add(desc)
            out.append(desc)
    return out[:MAX_RXNORM_CANDIDATES]


def resolve_drug(name: str) -> tuple[str, dict | None]:
    """Map a spoken drug name to (canonical_name, record).

    Returns the lowercased input and None when nothing matches, so callers
    can report what the EMT actually said.
    """
    literal = (name or "").strip().lower()
    row = _get_row(literal)
    if row is None:
        for candidate in _rxnorm_candidates(name):
            row = _get_row(candidate)
            if row is not None:
                break
    if row is None:
        return literal, None

    # Alias rows point at the real record.
    alias_target = row.get("alias_of")
    if alias_target:
        canonical = alias_target.strip().lower()
        return canonical, _get_row(canonical)

    return str(row.get("drug_name", literal)).lower(), row


def get_drug(name: str):
    """Fetch one drug record by any known name, alias, or RxNorm synonym."""
    return resolve_drug(name)[1]


def _class_ids(record: dict, key: str) -> dict:
    """{class_id: class entry} for one side of a record's class data."""
    return {
        c["class_id"]: c
        for c in (record.get(key) or [])
        if isinstance(c, dict) and c.get("class_id")
    }


def _curated_flag(record: dict, canonical_other: str) -> dict | None:
    """Layer 1: an explicit, hand-written pair rule."""
    contraindicated = {c.lower() for c in record.get("contraindicated_with", [])}
    if canonical_other not in contraindicated:
        return None
    return {
        "severity": record.get("severity", "CONTRAINDICATED"),
        "note": record.get("interaction_notes", {}).get(
            canonical_other, "Do not co-administer."
        ),
        "basis": "curated_pair",
    }


def _class_flag(record: dict, other_record: dict) -> dict | None:
    """Layer 2: this drug is contraindicated with a class the other is in.

    Reports the class names so the EMT can see *why* it fired, and names
    RxClass as the source -- a class-derived flag and an agency-curated one
    are different levels of authority and should not read identically.
    """
    if not other_record:
        return None
    shared = set(_class_ids(record, "contraindicated_classes")) & set(
        _class_ids(other_record, "classes")
    )
    if not shared:
        return None
    entries = _class_ids(other_record, "classes")
    names = sorted(entries[cid].get("class_name", cid) for cid in shared)
    return {
        "severity": record.get("severity", "CONTRAINDICATED"),
        "note": (
            f"Drug-class contraindication: {', '.join(names)}. "
            "Derived from NLM RxClass (MED-RT) class data, not a curated "
            "agency rule -- verify against your protocol."
        ),
        "basis": "drug_class",
        "matched_classes": [
            {"class_id": cid, "class_name": entries[cid].get("class_name", "")}
            for cid in sorted(shared)
        ],
    }


def check_interactions(drug_names: list[str]) -> list[dict]:
    """Flag contraindicated pairs among the given drugs.

    Checks each pair in BOTH directions and through both rule layers. Real
    reference data routinely records a pair on only one of the two drugs --
    RxClass, for instance, puts the nitrate/PDE5 contraindication on
    nitroglycerin's side as an MoA it must not meet, and records nothing on
    sildenafil's -- so a one-way check would miss it.

    Emits at most one flag per pair, preferring the curated rule: its note
    is written for a medic, the class-derived one is generated.
    """
    resolved = {name: resolve_drug(name) for name in drug_names}

    flags = []
    for a, b in combinations(drug_names, 2):
        canonical_a = resolved[a][0]
        canonical_b = resolved[b][0]
        # The same drug said two ways ("epi" and "epinephrine") is not an
        # interaction with itself.
        if canonical_a == canonical_b:
            continue

        hit = None
        for first, second in ((a, b), (b, a)):
            record = resolved[first][1]
            if not record:
                continue
            found = (_curated_flag(record, resolved[second][0])
                     or _class_flag(record, resolved[second][1]))
            if found:
                # Prefer a curated rule even if the class rule matched the
                # other direction first.
                if hit is None or (hit["basis"] == "drug_class"
                                   and found["basis"] == "curated_pair"):
                    hit = {"drug_a": first, "drug_b": second, **found}
                if hit["basis"] == "curated_pair":
                    break
        if hit:
            flags.append(hit)
    return flags
