"""
RxClass (NLM RxNav) lookup for drug-class membership and class-level
contraindications.

Used only by `seed_tables.py --refresh-classes`, never at request time. The
classes it returns are baked into the seed file and reviewed in a diff
before they reach DynamoDB, so no Lambda ever makes an outbound call and no
patient context ever leaves the account. See `docs/HIPAA_NOTES.md`.

Two things about this API will silently produce wrong clinical output if
you skip them:

1. **`byRxcui` returns classes related by ANY relationship, and the `rela`
   query parameter does not filter them** -- passing `rela=ci_moa` returns
   exactly the same payload as omitting it. The relationship is in each
   returned row's `rela` field, so filtering has to happen here, on the
   client. Without it, nitroglycerin comes back as a member of
   "Phosphodiesterase 5 Inhibitors" (it is related by `ci_moa` -- it is
   *contraindicated with* that class, not a member of it) and a nitrate x
   PDE5 rule matches nitroglycerin against itself.

2. **ATC is the wrong vocabulary for this.** ATC's G04BE ("Drugs used in
   erectile dysfunction") contains alprostadil, a prostaglandin with no
   nitrate interaction, so a rule keyed on ATC false-positives on it. MoA
   and EPC are mechanism-based and separate the two correctly. CHEM is
   excluded for the same reason in the other direction: it is chemical
   structure, so "Pyrimidines" would sweep in unrelated drugs.
"""
import json
import urllib.parse
import urllib.request

RXNAV = "https://rxnav.nlm.nih.gov/REST"
TIMEOUT = 25

# What a drug IS, vs. what it must not be combined with.
MEMBERSHIP_RELAS = frozenset({"has_moa", "has_epc"})
CONTRAINDICATION_RELAS = frozenset({"ci_moa", "ci_epc"})

# Mechanism of Action and Established Pharmacologic Class only. See the
# module docstring for why ATC1-4, CHEM, DISEASE, PE and PK are all out.
CLASS_TYPES = frozenset({"MOA", "EPC"})


def _get(path: str, **params):
    url = f"{RXNAV}/{path}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
        return json.load(resp)


def find_rxcui(drug_name: str):
    """RxCUI for an exact ingredient name, or None."""
    data = _get("rxcui.json", name=drug_name)
    ids = (data.get("idGroup") or {}).get("rxnormId") or []
    return ids[0] if ids else None


def parse_class_rows(rows: list) -> tuple:
    """Split raw `rxclassDrugInfo` rows into (classes, contraindicated).

    Pure -- the offline tests drive this with fixtures. Each side is a list
    of {class_id, class_name, class_type} sorted by id, so re-running the
    refresh produces a stable diff rather than reordered noise.
    """
    member, contra = {}, {}
    for row in rows or []:
        item = row.get("rxclassMinConceptItem") or {}
        class_type = item.get("classType")
        class_id = item.get("classId")
        if class_type not in CLASS_TYPES or not class_id:
            continue
        rela = (row.get("rela") or "").lower()
        entry = {
            "class_id": class_id,
            "class_name": item.get("className", ""),
            "class_type": class_type,
        }
        if rela in MEMBERSHIP_RELAS:
            member[class_id] = entry
        elif rela in CONTRAINDICATION_RELAS:
            contra[class_id] = entry
    key = lambda e: e["class_id"]  # noqa: E731
    return sorted(member.values(), key=key), sorted(contra.values(), key=key)


def classes_for(drug_name: str) -> tuple:
    """(classes, contraindicated_classes) for one ingredient name.

    Returns ([], []) when RxNorm doesn't know the name -- a drug the
    terminology has never heard of is normal for field slang and alias rows,
    and must not fail the whole refresh.
    """
    rxcui = find_rxcui(drug_name)
    if not rxcui:
        return [], []
    data = _get("rxclass/class/byRxcui.json", rxcui=rxcui)
    rows = (data.get("rxclassDrugInfoList") or {}).get("rxclassDrugInfo", [])
    return parse_class_rows(rows)
