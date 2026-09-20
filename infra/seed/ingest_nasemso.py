#!/usr/bin/env python3
"""
Turn the NASEMSO National Model EMS Clinical Guidelines PDF into protocol
records for the Protocols table.

    python3 infra/seed/ingest_nasemso.py --pdf National-Model-EMS-Clinical-Guidelines_2022.pdf

Writes `nasemso_protocol_seed.json` next to this file. Makes no AWS calls;
seed it afterwards with `seed_tables.py`.

**Extraction is deliberately verbatim.** Clinical text -- inclusion
criteria, assessment, treatment steps -- is copied out of the PDF and never
paraphrased, summarised or passed through a model. A protocol assistant
whose dosages were reworded by an LLM at ingest time would have the same
liability problem as one that free-generates them at request time, just
moved earlier and harder to notice. The only derived field is `synonyms`,
and it comes from the document's own `Aliases` section plus the title.

Requires `pdftotext` (poppler-utils), which is what keeps this dependency-
free on the Python side:  sudo dnf install poppler-utils

The source document is public domain (developed under NHTSA cooperative
agreement 693JJ92050001) and freely redistributable. It is a *model*
guideline set: real deployments replace it with their own
medical-direction-approved protocols. Every record says so.
"""
import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
OUT = HERE / "nasemso_protocol_seed.json"

SOURCE_DOC = "NASEMSO National Model EMS Clinical Guidelines"
SOURCE_VERSION = "3.0 (Rev. March 2022)"

REFERENCE_NOTE = (
    "Verbatim extract from {doc}, version {ver}, page {page}. This is a "
    "NATIONAL MODEL guideline, not an agency protocol -- replace with your "
    "own medical-direction-approved protocols before any real use. "
    "`synonyms` come from the document's own Aliases section and are "
    "retrieval aids for matching how an EMT phrases a query; they are NOT "
    "diagnostic criteria."
)

# Page furniture: running header, the rule above the footer, the TOC link.
NOISE = re.compile(
    r"^\s*(NASEMSO|National Model EMS Clinical Guidelines.*|_+\s*(Go To TOC)?|Go To TOC)\s*$"
)
FOOTER = re.compile(r"^(?P<category>.*?)\s{2,}Rev\.\s+\w+\s+\d{4}\s*$")
TOC_ENTRY = re.compile(r"^(?P<indent>\s*)(?P<title>.+?)\s*\.{3,}\s*(?P<page>\d+)\s*$")
STEP_START = re.compile(r"^\s*\d+\.\s+\S")

# Section headings inside a guideline. The document is not consistent about
# these -- "Treatment and Interventions" also appears as "Treatments and
# Interventions", "Assessment, Treatment, and Interventions", "Immediate
# Treatment and Interventions" and four other spellings across 71
# guidelines. Matching exact strings silently produced protocols with no
# treatment steps at all, including opioid overdose and chest pain, so
# headings are normalized by pattern instead.
SECTION_PATTERNS = [
    (r"^aliases$", "Aliases"),
    (r"^patient care goals$", "Patient Care Goals"),
    (r"^patient presentation$", "Patient Presentation"),
    (r"^inclusion(/exclusion)?\s*criteria$", "Inclusion Criteria"),
    (r"^exclusion\s*criteria$", "Exclusion Criteria"),
    (r"^patient management$", "Patient Management"),
    # Any Treatment/Interventions spelling, with or without a leading
    # Assessment, a qualifier, or trailing punctuation.
    (r"^(immediate\s+|secondary\s+)?(assessment,?\s*)?treatments?,?\s*and\s*"
     r"(troubleshooting\s+)?interventions?\b.*$", "Treatment and Interventions"),
    (r"^assessment$", "Assessment"),
    (r"^patient safety considerations$", "Patient Safety Considerations"),
    (r"^notes/educational pearls$", "Notes/Educational Pearls"),
    (r"^key considerations$", "Key Considerations"),
    (r"^pertinent assessment findings$", "Pertinent Assessment Findings"),
    (r"^quality improvement$", "Quality Improvement"),
    (r"^references$", "References"),
]
_SECTION_RES = [(re.compile(p), name) for p, name in SECTION_PATTERNS]

# Lines that open a guideline right after its title.
OPENERS = ("aliases", "patient care goals")


def normalize_heading(line: str):
    """Canonical section name for a heading line, or None."""
    s = line.strip().lower().rstrip(":")
    if not s or len(s) > 70:
        return None
    for rx, name in _SECTION_RES:
        if rx.match(s):
            return name
    return None


# Appendices are reference tables (drug lists, burn charts), not protocols.
SKIP_CATEGORIES = {"appendices", "introduction", "purpose and notes"}


def pdf_pages(pdf_path: pathlib.Path) -> list:
    """Page texts, layout preserved. Layout matters: indentation is the only
    thing distinguishing a section heading from a numbered step."""
    if not shutil.which("pdftotext"):
        sys.exit("pdftotext not found -- install poppler-utils and re-run.")
    text = subprocess.run(
        ["pdftotext", "-layout", str(pdf_path), "-"],
        capture_output=True, text=True, check=True,
    ).stdout
    return text.split("\f")


def toc_titles(pages: list) -> set:
    """Guideline titles from the table of contents, lowercased.

    Used only to recognise where a guideline starts. Long titles wrap across
    two TOC lines, so this is a recall-oriented set -- a title it misses is
    caught by `looks_like_title`, and an extra entry is harmless.
    """
    titles = set()
    for page in pages[:6]:
        for line in page.split("\n"):
            m = TOC_ENTRY.match(line)
            if m and m.group("title").strip(" ."):
                titles.add(m.group("title").strip().lower())
    return titles


def page_footer(lines: list) -> tuple:
    """(category, index of the footer rule) for one page, or (None, None).

    The guideline title also appears in the footer, but it is **not
    trustworthy**: in the source PDF, pages 198-202 carry the previous
    guideline's title ("Respiratory Distress") while their body is
    "Mechanical Ventilation (Invasive)". Segmentation uses the body heading
    instead; only the category is taken from here.
    """
    nonblank = [(i, l) for i, l in enumerate(lines) if l.strip()]
    for i, line in reversed(nonblank[-5:]):
        m = FOOTER.match(line)
        if m:
            return m.group("category").strip(), i
    return None, None


def read_title(body: list, known: set, category: str):
    """The guideline title starting this page, or None.

    Two signals, both required, because a shape test alone is not enough:
    a title-cased flush-left line is also what section sub-headings look
    like ("Pediatric-Appropriate Pain Assessment Tools" inside Pain
    Management), and treating one as a title truncates the real guideline.

      1. it is the first non-blank line of the page, flush left; and
      2. `Aliases` or `Patient Care Goals` follows within a few lines.

    Titles wrap: "Chest Pain/Acute Coronary Syndrome (ACS)/ST-segment
    Elevation Myocardial" / "Infarction (STEMI)". Consecutive flush-left
    lines are joined until an opener is reached.
    """
    first = next((i for i, l in enumerate(body) if l.strip()), None)
    if first is None or body[first][:1].isspace():
        return None, first

    parts, i, seen, in_preamble = [], first, 0, False
    while i < len(body) and seen < 8:
        line = body[i]
        if not line.strip():
            i += 1
            continue
        seen += 1
        stripped = line.strip()

        # "(Adapted from an evidence-based guideline created using the
        # National Prehospital ... Model Process)" wraps across lines, and
        # only the first starts with "(". Skipping just that line left
        # "Model Process" glued onto five titles, which is how both
        # pediatric respiratory guidelines ended up with the same id.
        if in_preamble:
            if ")" in stripped:
                in_preamble = False
            i += 1
            continue
        if stripped.startswith("(Adapted"):
            in_preamble = ")" not in stripped
            i += 1
            continue

        if stripped.lower() in OPENERS or normalize_heading(line):
            title = " ".join(parts).strip()
            break
        if line[:1].isspace() or STEP_START.match(line):
            return None, first
        parts.append(stripped)
        i += 1
    else:
        return None, first

    # A section divider ("Cardiovascular", "Trauma") sits on the same page as
    # that section's first guideline, so it lands at the front of the title.
    if len(parts) > 1 and parts[0].lower() == category.lower():
        parts = parts[1:]
        title = " ".join(parts).strip()

    if not parts or not title:
        return None, first
    # Section divider pages ("Cardiovascular", "Trauma") repeat the category.
    if title.lower() == category.lower():
        return None, first
    if title.lower() in known or re.match(
            r"^[A-Z][A-Za-z0-9 ,'/()&.:\u2013-]{6,140}$", title):
        return title, i
    return None, first


def segment(pages: list) -> list:
    """Split the document into guidelines: {title, category, page, lines}."""
    known = toc_titles(pages)
    guidelines, current = [], None

    for page in pages:
        lines = page.rstrip("\n").split("\n")
        category, footer_at = page_footer(lines)
        if category is None or category.lower() in SKIP_CATEGORIES:
            continue

        body = [l for l in lines[:footer_at] if not NOISE.match(l)]
        printed = _printed_page(lines, footer_at)

        title, at = read_title(body, known, category)
        if title:
            current = {"title": title, "category": category,
                       "page": printed, "lines": body[at:]}
            guidelines.append(current)
        elif current is not None:
            current["lines"].extend(body)
    return guidelines


def _printed_page(lines: list, footer_at: int):
    """The page number as printed in the footer, for citation."""
    for line in lines[footer_at:]:
        m = re.search(r"\s(\d{1,3})\s*$", line)
        if m:
            return int(m.group(1))
    return None


def split_sections(lines: list) -> dict:
    """Map each guideline section heading to its verbatim lines."""
    out, current = {}, None
    for line in lines:
        key = normalize_heading(line)
        if key and not STEP_START.match(line):
            current = key
            out.setdefault(current, [])
            continue
        if current:
            out[current].append(line)
    return out


def _text(lines: list) -> str:
    """Collapse to single-spaced prose, preserving the words exactly."""
    joined = " ".join(l.strip() for l in (lines or []) if l.strip())
    return re.sub(r"\s{2,}", " ", joined).strip()


def _bullets(lines: list) -> list:
    """Top-level numbered items, each with its sub-items folded in.

    Sub-items are kept because a step's dose often lives in one ("2. ...
    administer epinephrine at the following dose: a. Adult 0.3 mg IM").
    Dropping them would leave a step that names a drug and no dose.
    """
    items, buf = [], []
    for line in lines or []:
        if not line.strip():
            continue
        if STEP_START.match(line) and buf:
            items.append(_text(buf))
            buf = [line]
        elif STEP_START.match(line):
            buf = [line]
        elif buf:
            buf.append(line)
    if buf:
        items.append(_text(buf))
    if items:
        return [re.sub(r"^\d+\.\s*", "", i) for i in items]

    # Not every section is a numbered list -- Functional Needs writes its
    # treatment guidance as prose. Returning [] there silently produced a
    # protocol with no steps whose PDF page plainly has them, so fall back
    # to paragraphs (blank-line separated) rather than dropping the text.
    paragraphs, para = [], []
    for line in lines or []:
        if line.strip():
            para.append(line)
        elif para:
            paragraphs.append(_text(para))
            para = []
    if para:
        paragraphs.append(_text(para))
    return [p for p in paragraphs if p]


def _aliases(lines: list) -> list:
    """Alias terms from the Aliases section.

    Laid out in up to three columns, so one text line can hold three
    unrelated aliases ("Carfentanil    Dilaudid(R)    Drug abuse"). Splitting
    on runs of whitespace is what turns the opioid guideline's block into 18
    separate search terms instead of six run-on strings.
    """
    out = []
    for line in lines or []:
        for cell in re.split(r"\s{2,}", line.strip()):
            cell = cell.strip().strip("\u00ae\u2122").strip()
            if cell and cell.lower() not in ("none", "none noted"):
                out.append(cell)
    return out


def _slug(title: str) -> str:
    """Stable id from a title.

    Parentheses are kept as content, not dropped: "Pediatric Respiratory
    Distress (Bronchiolitis)" and "(Croup)" are two different guidelines
    whose titles are otherwise identical, and stripping the parenthetical
    collapsed them onto one id.
    """
    s = re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").upper()
    s = re.sub(r"-{2,}", "-", s)
    if len(s) <= 64:
        return s
    return s[:64].rsplit("-", 1)[0]   # never end on half a word


def build_record(guideline: dict) -> dict:
    """One Protocols-table item. Clinical fields are verbatim."""
    sec = split_sections(guideline["lines"])
    title = guideline["title"]

    aliases = _aliases(sec.get("Aliases"))
    synonyms = sorted({title.lower(), *(a.lower() for a in aliases)})

    return {
        "protocol_id": f"NASEMSO-{_slug(title)}",
        "title": title,
        "category": guideline["category"],
        "synonyms": synonyms,
        "indications": _text(sec.get("Inclusion Criteria")),
        "exclusions": _text(sec.get("Exclusion Criteria")),
        "care_goals": _bullets(sec.get("Patient Care Goals")),
        "assessment": _bullets(sec.get("Assessment")),
        "steps": _bullets(sec.get("Treatment and Interventions")),
        "safety_considerations": _bullets(sec.get("Patient Safety Considerations")),
        "source_document": SOURCE_DOC,
        "source_version": SOURCE_VERSION,
        "source_page": guideline["page"],
        "reference_note": REFERENCE_NOTE.format(
            doc=SOURCE_DOC, ver=SOURCE_VERSION, page=guideline["page"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", required=True, type=pathlib.Path)
    ap.add_argument("--out", type=pathlib.Path, default=OUT)
    args = ap.parse_args()

    pages = pdf_pages(args.pdf)
    guidelines = segment(pages)
    records = [build_record(g) for g in guidelines]

    # A record with no steps and no inclusion criteria is a parse failure,
    # not a short guideline -- surfacing it beats seeding an empty protocol.
    empty = [r["protocol_id"] for r in records if not r["steps"] and not r["indications"]]
    records = [r for r in records if r["steps"] or r["indications"]]

    # protocol_id is the table's partition key: a collision doesn't error,
    # it silently overwrites one guideline with another at seed time.
    seen = {}
    for r in records:
        if r["protocol_id"] in seen:
            sys.exit(f"duplicate protocol_id {r['protocol_id']!r}: "
                     f"{seen[r['protocol_id']]!r} and {r['title']!r}")
        seen[r["protocol_id"]] = r["title"]

    args.out.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(pages)} pages -> {len(guidelines)} guidelines -> "
          f"{len(records)} records  ({args.out.name})")
    if empty:
        print(f"dropped {len(empty)} with neither steps nor inclusion criteria:")
        for pid in empty:
            print(f"   {pid}")
    no_steps = [r["protocol_id"] for r in records if not r["steps"]]
    if no_steps:
        print(f"\n{len(no_steps)} record(s) have no Treatment and Interventions section:")
        for pid in no_steps:
            print(f"   {pid}")


if __name__ == "__main__":
    main()
