"""
Protocol retrieval scoring.

Pure logic, deliberately free of boto3 and every AWS import, so
`infra/tests/test_protocol_search.py` can exercise it against the real seed
file with no credentials and no stubbing. `app.py` does the DynamoDB scan
and hands the items here.

This replaces a scorer that counted raw substring hits over
`json.dumps(item)`. That version had three failure modes worth naming,
because they are easy to reintroduce:

  - **Stopwords matched everything.** "what do I do for a diabetic
    emergency" scored 5 against the anaphylaxis record -- the highest score
    of any query tested -- entirely on *what/do/i/for/a*. A query with no
    correct answer produced the most confident-looking match.
  - **Substring, not word, matching.** `"a" in haystack` is true for every
    record ever written.
  - **Unnormalized totals.** Long records won on volume, and `reference_note`
    ("SEED/DEMO protocol only") is identical across records, so it was pure
    noise that still contributed score.

The fixes, in order of how much they matter: match folded *tokens* rather
than substrings, score only a whitelist of meaningful fields, average over
the query length instead of summing, and refuse to answer below a floor.
"""
import re

# Only these fields are scored. A whitelist rather than a blocklist means a
# new boilerplate attribute (another `reference_note`) can't silently become
# retrieval noise -- it has to be added here on purpose.
FIELD_WEIGHTS = {
    "title": 3.0,
    "synonyms": 3.0,       # other names for this protocol, incl. field slang
    "symptoms": 3.0,       # how an EMT actually describes the presentation
    "indications": 2.5,
    "protocol_id": 2.0,    # so "PROT-ANAPHYLAXIS-01" retrieves itself
    "weight_based_dosage_field": 2.0,
    "steps": 1.0,          # matches here are real but weak -- every protocol
                           # mentions oxygen, transport, IV access
}
MAX_FIELD_WEIGHT = max(FIELD_WEIGHTS.values())

# Absolute floor: below this, report no match rather than the least-bad row.
# Tuned so "kid is 22 kg and unresponsive, found with mom's pain pills"
# keeps the opioid protocol (0.50) and drops chest pain, which matches only
# on the word "pain" (0.17).
MIN_SCORE = 0.20

# Relative floor: drop anything scoring below this fraction of the best hit.
# The absolute floor answers "does anything match at all"; this one answers
# "is this still a real alternative, or noise padding the prompt". Tuned so
# "chest pain" stops also returning the opioid protocol, which scores 0.50
# on the single word "pain" (out of its "pain pills" symptom) against chest
# pain's 1.00. Genuine ties still survive -- "shortness of breath" scores
# 1.00 against both anaphylaxis and chest pain, and an EMT should see both.
RELATIVE_FLOOR = 0.55

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Ordinary English filler, plus the words that show up in *every* EMS query
# and therefore discriminate between protocols not at all: "patient",
# "dose", "give", "protocol", units, and time references. Dropping these is
# what stops a query from scoring against a record it shares no clinical
# content with.
STOPWORDS = frozenset(
    """
    a about after an and any are as at be because been before being but by
    can cant could did do does doing done during for from get gets getting
    give given giving go got had has have having he her here him his how i
    if in into is it its just me my no not of on or our out over she should
    since so some that the their them then there these they this those to
    too under up us was we were what when where which while who whom why
    will with would you your
    """.split()
) | frozenset(
    """
    patient patients pt guy lady male female man woman person kid kids
    year years old age aged yo
    dose dosage doses dosing administer administered administering
    take taken taking took give giving given push pushed
    mg ml mcg kg lb lbs kilo kilos gram grams unit units cc
    protocol protocols guideline guidelines step steps
    ago now today tonight yesterday last night currently still
    much many need needs want call called
    """.split()
)


def _fold(token: str) -> str:
    """Collapse a token to a crude singular form so "hives"/"hive" and
    "pupils"/"pupil" match.

    Deliberately not a real stemmer. The only property that matters is that
    folding is applied identically to the query and to the records, so a
    *wrong* fold ("status" -> "statu") is harmless -- both sides land on the
    same string. A real stemmer would buy little here and would start
    folding clinically distinct words together.
    """
    if len(token) <= 3:
        return token
    if token.endswith("ies"):
        return token[:-3] + "y"          # allergies -> allergy
    if token.endswith("es") and token[:-2].endswith(("s", "x", "z", "ch", "sh")):
        return token[:-2]                # rashes -> rash
    if token.endswith("s") and not token.endswith("ss"):
        return token[:-1]                # hives -> hive  (distress stays put)
    return token


def _tokens(value) -> set:
    """Folded tokens from a string, a list, or a nested list of either.

    Bare digits are dropped on both sides: they are patient specifics
    ("22 kg", "58 year old"), never protocol identity, and keeping them let
    a weight match a record.
    """
    if value is None:
        return set()
    if isinstance(value, (list, tuple, set)):
        out = set()
        for entry in value:
            out |= _tokens(entry)
        return out
    return {
        _fold(t)
        for t in _TOKEN_RE.findall(str(value).lower())
        if len(t) > 1 and not t.isdigit()
    }


def query_terms(query: str) -> list:
    """Folded, de-duplicated, stopword-free terms, in first-seen order.

    Returns [] for a query that is nothing but filler ("what should I do?"),
    which `score_protocol` treats as unanswerable rather than as a match
    against everything.
    """
    seen, out = set(), []
    for raw in _TOKEN_RE.findall((query or "").lower()):
        if len(raw) <= 1 or raw.isdigit() or raw in STOPWORDS:
            continue
        folded = _fold(raw)
        if folded in STOPWORDS or folded in seen:
            continue
        seen.add(folded)
        out.append(folded)
    return out


def score_protocol(terms, item) -> tuple:
    """Score one record in [0, 1] and report which terms carried it.

    Each query term scores the *best* field it appears in, so a term hitting
    both `title` and `steps` counts once at the title's weight rather than
    twice. The total is then divided by the best score this query could
    possibly achieve (every term matching at the top weight), which is what
    makes scores comparable across queries of different lengths and stops a
    long `steps` list from out-scoring a title match on volume.
    """
    if not terms:
        return 0.0, []
    best = {}
    for field, weight in FIELD_WEIGHTS.items():
        field_tokens = _tokens(item.get(field))
        if not field_tokens:
            continue
        for term in terms:
            if term in field_tokens and weight > best.get(term, 0.0):
                best[term] = weight
    if not best:
        return 0.0, []
    score = sum(best.values()) / (len(terms) * MAX_FIELD_WEIGHT)
    matched = [t for t in terms if t in best]
    return score, matched


def search(query: str, items, limit: int = 5, min_score: float = MIN_SCORE) -> list:
    """Rank protocol records against an EMT's query.

    Returns [] when nothing clears the floor -- the caller is expected to
    tell the EMT that plainly rather than present the least-bad row, because
    a confidently-worded near-miss is worse in the field than "not found".

    Results carry `score` and `matched_terms` so the answer can show its
    work; ties break on `protocol_id` so a DynamoDB scan returning items in
    a different order can't change which protocol an EMT is shown.
    """
    terms = query_terms(query)
    if not terms:
        return []

    scored = []
    for item in items:
        score, matched = score_protocol(terms, item)
        if score >= min_score:
            entry = dict(item)
            entry["score"] = round(score, 3)
            entry["matched_terms"] = matched
            scored.append(entry)

    if not scored:
        return []

    scored.sort(key=lambda e: (-e["score"], str(e.get("protocol_id", ""))))
    cutoff = scored[0]["score"] * RELATIVE_FLOOR
    return [e for e in scored if e["score"] >= cutoff][:limit]
