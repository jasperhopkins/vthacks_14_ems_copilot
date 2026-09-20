"""
Shared drug-reference lookup + interaction checking.

This lives in the common layer rather than in src/drug/ because two callers
need the exact same rules:

  - src/drug/app.py   -- the EMT explicitly asks ("check epi + propranolol")
  - src/pcr/status.py -- the PCR pipeline auto-checks whatever medications
                         Bedrock extracted from the voice narration

One implementation means an interaction rule can't silently differ between
"the EMT asked" and "the PCR noticed".

Interactions are checked by four rule layers, highest authority first.
Every layer only ever *adds* flags; none may remove another's, because each
is blind in places the others see:

  1. **Curated pairs** (`contraindicated_with` + `interaction_notes`) --
     hand-authored, clinically phrased, agency-reviewable.
  2. **Curated classes** (`curated_contraindicated_classes`) -- a
     hand-written rule against a whole drug class, for mechanisms that
     generalise. "Epinephrine must not meet a non-selective beta blocker"
     is one rule covering propranolol, labetalol, nadolol and sotalol,
     keyed on the beta2-antagonist class so that beta-1 selective agents
     like metoprolol correctly do *not* fire.
  3. **FDA labelling** (`label_contraindications`) -- mined extractively
     from openFDA by `seed_tables.py --refresh-labels`. Each row carries
     the verbatim sentence and the DailyMed set id it came from.
  4. **RxClass drug classes** (`classes` + `contraindicated_classes`) --
     MoA/EPC ids from `--refresh-classes`.

Why all four. RxClass has no contraindication relation between epinephrine
and propranolol at all, so the unopposed-alpha cross-check exists only in
layers 1-2. RxClass also records nitrate/PDE5 on nitroglycerin's side only,
leaving sildenafil's own record empty -- so amyl nitrite, a nitrate the EMS
formulary carries, did not flag against any PDE5 inhibitor until the FDA
label supplied the reciprocal direction. And labelling in turn says nothing
about epinephrine and beta blockers in its contraindications section.
Collapsing these into one source would silently drop whichever interactions
that source happens not to cover.

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


def class_names(record: dict) -> set:
    """Class names this drug counts as, for interaction matching.

    Honours `class_exclusions`: a reviewed statement that a class RxClass
    assigns is wrong *for interaction purposes*. RxClass files nitrous
    oxide under the MoA "Nitric Oxide Donors" -- true of the nitrogen
    chemistry, false of the clinical rule, since N2O is not an organic
    nitrate and carries none of the PDE5 interaction that nitroglycerin and
    amyl nitrite do. Without the exclusion, every PDE5 inhibitor's FDA
    labelling flagged against Entonox, telling a medic to withhold
    analgesia from a patient who took Viagra.

    Dropping the class outright is not the fix: amyl nitrite is an organic
    nitrite, genuinely does carry the interaction, and "Nitric Oxide
    Donors" is the only class RxClass gives it.
    """
    excluded = {str(x) for x in (record.get("class_exclusions") or [])}
    return {
        c.get("class_name")
        for c in (record.get("classes") or [])
        if isinstance(c, dict) and c.get("class_name") not in excluded
    }


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
    entries = {cid: e for cid, e in _class_ids(other_record, "classes").items()
               if e.get("class_name") in class_names(other_record)}
    shared = set(_class_ids(record, "contraindicated_classes")) & set(entries)
    if not shared:
        return None
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


def _curated_class_flag(record: dict, other_record: dict) -> dict | None:
    """Layer 2: a hand-written rule against a whole drug class."""
    if not other_record:
        return None
    rules = record.get("curated_contraindicated_classes") or []
    other_classes = class_names(other_record)
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        if rule.get("class_name") in other_classes:
            return {
                "severity": rule.get("severity", "CONTRAINDICATED"),
                "note": rule.get("note", "Do not co-administer."),
                "basis": "curated_class",
                "matched_classes": [{"class_id": rule.get("class_id", ""),
                                     "class_name": rule.get("class_name", "")}],
            }
    return None


def _label_flag(record: dict, other_canonical: str, other_record: dict) -> dict | None:
    """Layer 3: FDA labelling says not to co-administer.

    The note is the label's own sentence rather than a paraphrase of it,
    and carries the DailyMed link, so a medic (or an auditor) can read the
    source rather than trusting this pipeline.
    """
    other_classes = class_names(other_record or {})
    for row in record.get("label_contraindications") or []:
        if not isinstance(row, dict):
            continue
        hit = (
            (row.get("kind") == "drug" and row.get("target") == other_canonical)
            or (row.get("kind") == "class" and row.get("target") in other_classes)
        )
        if not hit:
            continue
        return {
            "severity": row.get("severity", "CONTRAINDICATED"),
            "note": (f"FDA labelling for {record.get('drug_name', 'this drug')}: "
                     f"\u201c{row.get('evidence', '').strip()}\u201d"),
            "basis": "fda_label",
            "source": row.get("source", "FDA drug label"),
            "source_url": row.get("source_url"),
        }
    return None


# Highest authority first. A pair that several layers match is reported once,
# by the earliest -- its note is the one written for a medic.
_LAYER_RANK = {"curated_pair": 0, "curated_class": 1, "fda_label": 2, "drug_class": 3}


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
            canonical_second, record_second = resolved[second]
            found = (_curated_flag(record, canonical_second)
                     or _curated_class_flag(record, record_second)
                     or _label_flag(record, canonical_second, record_second)
                     or _class_flag(record, record_second))
            if found:
                # Keep whichever layer ranks highest, whichever direction
                # matched it first.
                if hit is None or _LAYER_RANK[found["basis"]] < _LAYER_RANK[hit["basis"]]:
                    hit = {"drug_a": first, "drug_b": second, **found}
                if hit["basis"] == "curated_pair":
                    break
        if hit:
            flags.append(hit)
    return flags
