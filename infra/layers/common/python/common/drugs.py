"""
Shared drug-reference lookup + interaction checking.

This lives in the common layer rather than in src/drug/ because two callers
need the exact same rules:

  - src/drug/app.py   -- the EMT explicitly asks ("check epi + propranolol")
  - src/pcr/status.py -- the PCR pipeline auto-checks whatever medications
                         Bedrock extracted from the voice narration

One implementation means an interaction rule can't silently differ between
"the EMT asked" and "the PCR noticed".

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


def check_interactions(drug_names: list[str]) -> list[dict]:
    """Flag contraindicated pairs among the given drugs.

    Checks each pair in BOTH directions: the seed data happens to list
    contraindications reciprocally, but real reference data often records
    the pair only on one of the two drugs, and a one-way check would miss
    it. Flags report the names the EMT used; matching happens on canonical
    names.
    """
    resolved = {name: resolve_drug(name) for name in drug_names}

    flags = []
    for a, b in combinations(drug_names, 2):
        for first, second in ((a, b), (b, a)):
            _, record = resolved[first]
            if not record:
                continue
            canonical_second = resolved[second][0]
            contraindicated = {c.lower() for c in record.get("contraindicated_with", [])}
            if canonical_second in contraindicated:
                flags.append({
                    "drug_a": first,
                    "drug_b": second,
                    "severity": record.get("severity", "CONTRAINDICATED"),
                    "note": record.get("interaction_notes", {}).get(
                        canonical_second, "Do not co-administer."
                    ),
                })
                break  # one flag per pair, whichever side recorded it
    return flags
