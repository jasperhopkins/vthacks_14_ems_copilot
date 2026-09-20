#!/usr/bin/env python3
"""
Add `symptoms` (lay/field phrasings) to extracted protocol records.

**This was run against all 71 NASEMSO guidelines and it did not work. Do
not re-run it expecting retrieval to improve.** Measured on the 18-query
benchmark in `infra/tests/test_nasemso_ingest.py`:

    no generated symptoms                        13/18   <- shipped
    +1267 generated terms, weight 3.0            11/18
    +terms pruned to df<=3, weight 2.0           13/18   (zero queries changed)

The failure is structural, not a prompt problem. The model is shown the
guideline's own text and asked for the words an EMT would use instead --
but if that text contained those words, retrieval would already have found
them. What comes back is therefore either vocabulary already indexed via
`indications`/`assessment`, or generic symptoms that many guidelines share:
"altered mental status" was claimed by 12 of 71 protocols, "nausea" and
"trouble breathing" by 10 each. At weight 3.0 those tie with a title match,
which is how "unresponsive pinpoint pupils not breathing" started returning
the organophosphate guideline instead of opioid overdose.

You cannot generate a vocabulary bridge out of the text that is missing the
vocabulary. Closing that gap needs an outside source of field language
(EMT-written queries, dispatch complaint text, real search logs) or a
semantic index -- Bedrock Knowledge Base / OpenSearch -- which is the
documented replacement for this scorer anyway.

The script is kept because the machinery around it is sound and reusable:
the dose/route/imperative filters and the `--check` self-retrieval gate
are what a future vocabulary source should be run through.

    python3 infra/seed/generate_symptoms.py --in nasemso_protocol_seed.json

Separate from `ingest_nasemso.py` on purpose. That script is purely
deterministic and its output is verbatim source text; this one calls
Bedrock, and keeping the boundary visible is the point -- you can re-run the
extraction without ever invoking a model, and diff what the model added.

**Why a model is allowed here at all.** `symptoms` is a retrieval aid, not
clinical content: it only affects *which* protocol is found, never what the
protocol says. The verbatim steps, doses and inclusion criteria are never
touched. The output is written to a seed file and reviewed in a diff before
it reaches a medic, exactly like the RxClass class data. What is explicitly
NOT allowed is a model rewriting a dose or inventing an indication, so
every generated term is passed through `reject_reason` first and anything
carrying a number, a unit, a route or an imperative verb is dropped.

Guarding against a plausible-sounding wrong term is why `--check` exists:
it re-runs retrieval over the whole corpus and reports any guideline whose
own symptom phrases retrieve a *different* guideline first.
"""
import argparse
import json
import pathlib
import re
import sys
import time
import boto3

HERE = pathlib.Path(__file__).parent
MODEL = "amazon.nova-pro-v1:0"
MAX_TERMS = 18
MAX_WORDS_PER_TERM = 4

PROMPT = """You are helping build a SEARCH INDEX for an EMS protocol lookup tool.

Below is one prehospital clinical guideline. List the short phrases an EMT \
would actually say on the radio or type into a search box when THIS \
guideline is the one they need.

Rules:
- Only phrases a person would use to DESCRIBE A PATIENT or the situation: \
presenting complaints, visible findings, lay words for the condition, \
common causes, street/brand names of substances involved.
- 1 to 4 words each. Lowercase. No punctuation.
- NO treatments, NO drug doses, NO routes, NO numbers, NO instructions. \
"pinpoint pupils" is right; "give naloxone 2 mg IN" is wrong.
- Do NOT invent findings this guideline does not describe.
- Prefer plain speech over textbook terms: "trouble breathing" over \
"dyspnea", "bee sting" over "hymenoptera envenomation". Include both when \
both are used.
- At most {max_terms} phrases, most distinctive first.

Return ONLY a JSON array of strings.

Guideline title: {title}
Also known as: {aliases}
Inclusion criteria: {indications}
Assessment findings: {assessment}
"""

# A "symptom" carrying any of these is a treatment instruction wearing the
# wrong hat, and must not enter the index.
# A *dose*, not merely a digit. Rejecting every digit also threw away "k2"
# (a street name for synthetic cannabinoids), "adalat cc", "etco2" and
# "12-lead ekg" -- all legitimate things to search for. What must never get
# through is a quantity attached to a unit.
_DOSE = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:mg|mcg|ug|ml|l|kg|lbs?|g|iu|units?|cc|joules?|"
    r"mmhg|%|feet|foot|ft|meters?|minutes?|hours?|inches)\b"
    r"|\b\d+\s*(?:/|per)\s*\d+\b"          # 1:1000, 20/kg style ratios
    r"|\b\d+\s*:\s*\d+\b", re.I)
_ROUTE = re.compile(r"\b(iv|io|im|in|po|sl|et|ett|neb|nebulized|intranasal|"
                    r"subcutaneous|infusion|drip|bolus)\b", re.I)
# Anchored to the first word: an imperative is a phrase that *starts* with
# the verb. Matching anywhere rejected "refusal of transport", which is a
# perfectly good thing for an EMT to type.
_IMPERATIVE = re.compile(r"^(give|administer|apply|push|titrate|transport|"
                         r"consider|perform|repeat|monitor|assess|obtain|"
                         r"establish|begin|start|treat|refer)\b", re.I)


def reject_reason(term: str):
    """Why this generated term must not be indexed, or None if it's fine."""
    t = (term or "").strip()
    if not t:
        return "empty"
    if len(t.split()) > MAX_WORDS_PER_TERM:
        return "too long"
    if _DOSE.search(t):
        return "contains a number or unit"
    if _ROUTE.search(t):
        return "contains a route"
    if _IMPERATIVE.search(t):
        return "reads as an instruction"
    if not re.fullmatch(r"[a-z0-9 '/–-]+", t.lower()):
        return "unexpected characters"
    return None


def clean(terms, title: str) -> tuple:
    """(accepted, [(term, reason)]) -- dedup, drop rejects, cap the count."""
    accepted, rejected, seen = [], [], set()
    for raw in terms or []:
        if not isinstance(raw, str):
            rejected.append((repr(raw), "not a string"))
            continue
        term = " ".join(raw.lower().split()).strip(" .,-")
        reason = reject_reason(term)
        if reason:
            rejected.append((raw, reason))
        elif term and term not in seen and term != title.lower():
            seen.add(term)
            accepted.append(term)
    return accepted[:MAX_TERMS], rejected


def generate(record: dict, client, attempts: int = 5) -> list:
    prompt = PROMPT.format(
        max_terms=MAX_TERMS,
        title=record["title"],
        aliases=", ".join(record.get("synonyms", [])) or "none",
        indications=(record.get("indications") or "none")[:1200],
        assessment=" ".join(record.get("assessment", []))[:2500] or "none",
    )
    # Bedrock throttles a tight loop of 71 calls; boto3's own retries are not
    # enough, and a throttled record silently keeps whatever symptoms it had.
    for attempt in range(attempts):
        try:
            resp = client.converse(
                modelId=MODEL,
                messages=[{"role": "user", "content": [{"text": prompt}]}],
                inferenceConfig={"maxTokens": 500, "temperature": 0},
            )
            break
        except Exception as e:  # noqa: BLE001
            if "Throttl" not in str(e) or attempt == attempts - 1:
                raise
            time.sleep(2 ** attempt)
    text = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end < 0:
        return []
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return []


def check(records: list) -> int:
    """Does each guideline's own symptom set retrieve that guideline?

    A generated phrase that pulls up someone else's protocol is worse than a
    missing one, so this is the gate that decides whether the generated
    index is usable at all.
    """
    sys.path.insert(0, str(HERE.parent / "src" / "protocol"))
    import search

    misses = 0
    for rec in records:
        if not rec.get("symptoms"):
            continue
        hits = search.search(" ".join(rec["symptoms"][:8]), records)
        top = hits[0]["protocol_id"] if hits else None
        if top != rec["protocol_id"]:
            misses += 1
            print(f"  MISS {rec['protocol_id']}")
            print(f"       -> {top}")
    print(f"\nself-retrieval: {len(records) - misses}/{len(records)} correct")
    return misses


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="path", type=pathlib.Path,
                    default=HERE / "nasemso_protocol_seed.json")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--check", action="store_true",
                    help="Only run the self-retrieval check on existing symptoms.")
    ap.add_argument("--limit", type=int, help="Process only the first N records.")
    args = ap.parse_args()

    records = json.loads(args.path.read_text())

    if args.check:
        sys.exit(1 if check(records) else 0)

    client = boto3.client("bedrock-runtime", region_name=args.region)
    todo = records[:args.limit] if args.limit else records
    total_rejected = 0
    for i, rec in enumerate(todo, 1):
        try:
            raw = generate(rec, client)
        except Exception as e:  # noqa: BLE001 -- one failure must not lose the rest
            print(f"[{i}/{len(todo)}] {rec['protocol_id']}: FAILED ({e})")
            continue
        terms, rejected = clean(raw, rec["title"])
        rec["symptoms"] = terms
        total_rejected += len(rejected)
        time.sleep(0.2)   # be a good citizen across 71 sequential calls
        print(f"[{i}/{len(todo)}] {rec['protocol_id'][:48]:48} {len(terms):2} kept"
              f"{'  ' + str(len(rejected)) + ' rejected' if rejected else ''}")
        for term, reason in rejected[:3]:
            print(f"        rejected {term!r}: {reason}")

    args.path.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n")
    print(f"\nwrote {args.path.name}; {total_rejected} term(s) rejected by the filters")
    print("Review the diff, then run --check before seeding.")


if __name__ == "__main__":
    main()
