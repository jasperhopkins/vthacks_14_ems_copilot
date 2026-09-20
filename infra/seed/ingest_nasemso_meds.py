#!/usr/bin/env python3
"""
Extract the EMS formulary from Appendix III of the NASEMSO National Model
EMS Clinical Guidelines into drug-reference records.

    python3 infra/seed/ingest_nasemso_meds.py --pdf <the same PDF>

Merges into `drug_reference_seed.json`; makes no AWS calls and calls no
model. Like `ingest_nasemso.py`, extraction is verbatim -- clinical text is
copied, never paraphrased.

Why this source. The drug table held ten drugs, which is too thin for the
class-level and label-derived interaction rules to have anything to work
on: a rule that fires on "any non-selective beta blocker" is worth nothing
when the table knows one. Appendix III is 65 medications chosen *for
prehospital use*, each with an explicit `Contraindications` line, compiled
by the NASEMSO Medical Directors Council from Medscape, the 2020 AHA
guidelines and AACT/EAPCCT position statements. It is the same document
the protocols came from, so the formulary and the protocols agree with each
other.

**Merging never overwrites hand-authored clinical content.** A record's
`contraindicated_with`, `interaction_notes`, `adult_dose` and
`pediatric_dose` are curated fields that an agency's medical director owns;
this script only fills gaps and adds its own namespaced fields. Same
direction of merge as `--refresh-classes`, and for the same reason.

Note the appendix's own caveat, reproduced on every record: contraindications
"which were not pertinent to EMS clinicians were not included". This is a
field reference, not a complete drug monograph.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
DRUG_SEED = HERE / "drug_reference_seed.json"

SOURCE_DOC = "NASEMSO National Model EMS Clinical Guidelines"
SOURCE_VERSION = "3.0 (Rev. March 2022)"
APPENDIX = "Appendix III. Medications"

# Appendix III runs these pages in v3.0. Passed as a range rather than
# discovered, because the surrounding appendices are tables with the same
# page furniture and no entry structure to key off.
FIRST_PAGE, LAST_PAGE = 377, 393

FIELD_NAMES = ["Name", "Class", "Pharmacologic Action", "Indications", "Contraindications"]
# The dash between label and value is em, en or hyphen, with or without
# surrounding spaces, inconsistently through the appendix.
FIELD_RE = re.compile(
    rf"^({'|'.join(re.escape(f) for f in FIELD_NAMES)})\s*[—–-]\s*(.*)$"
)
NOISE = re.compile(
    r"^\s*(NASEMSO|National Model EMS Clinical Guidelines.*|APPENDICES.*|"
    r"III\.\s*Medications\s*\d*|_+\s*(Go To TOC)?|Go To TOC|\d{1,3})\s*$"
)
FOOTER = re.compile(r"^\s*APPENDICES\s{2,}Rev\.")

TRADE_SPLIT = re.compile(r"[,;]| and ")


def pdf_text(pdf: pathlib.Path) -> str:
    if not shutil.which("pdftotext"):
        sys.exit("pdftotext not found -- install poppler-utils and re-run.")
    return subprocess.run(
        ["pdftotext", "-layout", "-f", str(FIRST_PAGE), "-l", str(LAST_PAGE), str(pdf), "-"],
        capture_output=True, text=True, check=True,
    ).stdout


def clean_lines(text: str) -> list:
    out = []
    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip() or NOISE.match(line) or FOOTER.match(line):
            continue
        out.append(line)
    return out


def parse_entries(lines: list) -> list:
    """Split the appendix into {name, fields{}} records.

    An entry opens on a flush-left line whose next content line is the
    `Name` field. That pairing is what separates a drug heading from a
    wrapped continuation of the previous drug's prose, which is also
    flush-left once pdftotext is done with it.
    """
    entries, current, field = [], None, None
    for i, line in enumerate(lines):
        stripped = line.strip()
        m = FIELD_RE.match(stripped)
        if m:
            if current is None:
                continue
            field = m.group(1)
            current["fields"][field] = [m.group(2)] if m.group(2) else []
            continue

        opens = False
        if not line[:1].isspace():
            nxt = lines[i + 1].strip() if i + 1 < len(lines) else ""
            nm = FIELD_RE.match(nxt)
            opens = bool(nm and nm.group(1) == "Name")
        if opens:
            current = {"name": stripped, "fields": {}}
            entries.append(current)
            field = None
        elif current is not None and field is not None:
            current["fields"][field].append(stripped)
    return entries


def _text(parts) -> str:
    return re.sub(r"\s{2,}", " ", " ".join(p.strip() for p in (parts or []) if p.strip())).strip()


def trade_names(raw: str) -> list:
    """Brand names from the `Name` field, for alias rows.

    The field is prose as often as a list ("There are multiple
    over-the-counter medications..."), so anything sentence-shaped is
    dropped rather than seeded as a nickname.
    """
    text = _text([raw])
    if not text or len(text.split()) > 12 and "®" not in text:
        return []
    out = []
    for part in TRADE_SPLIT.split(text):
        cand = part.strip().strip(".").replace("®", "").replace("™", "").strip()
        if not cand or len(cand.split()) > 3:
            continue
        if re.search(r"\b(there|multiple|includes?|including|active|ingredient|"
                     r"other|various|available|such|forms?)\b", cand, re.I):
            continue
        if re.fullmatch(r"[A-Za-z][A-Za-z0-9 '/-]{2,40}", cand):
            out.append(cand.lower())
    return sorted(set(out))


def build_record(entry: dict) -> dict:
    f = entry["fields"]
    # "Ketoralac", "Pralidoxime chloride (2-PAM)" -- keep the parenthetical
    # out of the key but remember it as an alias.
    display = entry["name"].strip()
    base = re.sub(r"\s*\(.*?\)\s*", " ", display).strip()
    indications = _text(f.get("Indications"))
    return {
        "drug_name": base.lower(),
        "display_name": display,
        "class": _text(f.get("Class")) or None,
        "pharmacologic_action": _text(f.get("Pharmacologic Action")) or None,
        "common_uses": [i.strip() for i in re.split(r"[,;]", indications) if i.strip()][:6],
        "indications_text": indications,
        "contraindications_text": _text(f.get("Contraindications")),
        "trade_names": trade_names(_text(f.get("Name"))),
        "source_document": f"{SOURCE_DOC}, {APPENDIX}",
        "source_version": SOURCE_VERSION,
        "notes": (
            f"Formulary entry extracted verbatim from {SOURCE_DOC}, {APPENDIX}, "
            f"version {SOURCE_VERSION}. The appendix states that contraindications "
            "'which were not pertinent to EMS clinicians were not included' -- this "
            "is a field reference, not a complete drug monograph, and is not a "
            "substitute for your agency's own medical-direction-approved formulary."
        ),
    }


# Fields an agency's medical director owns. The appendix never overwrites
# these; see the module docstring.
CURATED_FIELDS = {
    "contraindicated_with", "interaction_notes", "adult_dose", "pediatric_dose",
    "classes", "contraindicated_classes", "severity",
}


def merge(existing: list, extracted: list) -> tuple:
    """Fold extracted records into the seed list. Returns (records, stats)."""
    by_name = {d["drug_name"].lower(): d for d in existing}
    added = updated = 0
    alias_rows = []

    for rec in extracted:
        key = rec["drug_name"]
        target = by_name.get(key)
        if target is None:
            by_name[key] = dict(rec)
            added += 1
            target = by_name[key]
        else:
            if target.get("alias_of"):
                continue      # never let a formulary row clobber an alias row
            for k, v in rec.items():
                if k in CURATED_FIELDS or k == "drug_name":
                    continue
                # Fill gaps and add namespaced fields; leave existing
                # hand-written values (class, common_uses, notes) alone.
                if k in ("class", "common_uses", "notes") and target.get(k):
                    continue
                target[k] = v
            updated += 1

        for trade in rec["trade_names"]:
            if trade in by_name or trade == key:
                continue
            alias_rows.append({
                "drug_name": trade,
                "alias_of": key,
                "notes": f"Alias row: '{trade}' resolves to '{key}'. "
                         f"Trade name from {SOURCE_DOC}, {APPENDIX}.",
            })
            by_name[trade] = alias_rows[-1]

    records = sorted(by_name.values(),
                     key=lambda d: (bool(d.get("alias_of")), d["drug_name"]))
    return records, {"added": added, "updated": updated, "aliases": len(alias_rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=DRUG_SEED)
    args = ap.parse_args()

    entries = parse_entries(clean_lines(pdf_text(args.pdf)))
    extracted = [build_record(e) for e in entries]
    missing = [r["drug_name"] for r in extracted if not r["contraindications_text"]]

    existing = json.loads(args.out.read_text()) if args.out.exists() else []
    records, stats = merge(existing, extracted)
    args.out.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")

    print(f"{len(entries)} appendix entries -> {stats['added']} new drugs, "
          f"{stats['updated']} existing updated, {stats['aliases']} alias rows added")
    print(f"{len(records)} records now in {args.out.name}")
    if missing:
        print(f"\n{len(missing)} entries parsed with no Contraindications field:")
        for m in missing:
            print(f"   {m}")


if __name__ == "__main__":
    main()
