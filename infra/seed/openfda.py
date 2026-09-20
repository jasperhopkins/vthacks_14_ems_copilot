"""
Mine FDA drug labelling (openFDA) for contraindications, extractively.

Used only by `seed_tables.py --refresh-labels`, never at request time. What
lands in the seed file is a *verbatim sentence from the label* plus the
DailyMed set id it came from, so every flag this produces can be traced to
a line a human can go and read.

Nothing here generates text. A model asked to summarise a label would be
rewriting clinical content, which is the same boundary `ingest_nasemso.py`
refuses to cross. This matches known drug and class names against the
label's own words and keeps the sentence.

Three things that produce *wrong clinical output* if skipped, each found by
running this against the real API:

1. **Label selection.** Searching `naloxone` returns pentazocine/naloxone
   and buprenorphine/naloxone combination products first, whose
   contraindications are the combination's. Searching `nitroglycerin`
   returns a homeopathic remedy that lists it as an ingredient. Only
   single-ingredient labels whose generic name matches ours (allowing a
   salt suffix) are considered.

2. **Section choice.** Only `contraindications` and `boxed_warning` become
   flags. The `drug_interactions` section is mostly pharmacokinetics and
   *negative* findings -- vardenafil's says aspirin "did not potentiate the
   increase in bleeding time", and mining it produced a flag saying the
   opposite. That text is kept as reference prose, not as a rule.

3. **Self-matching.** A drug is not contraindicated with its own class.
   Propranolol's label says "beta-blocker", sildenafil's says "PDE5
   inhibitor", nitroglycerin's says "other nitrates"; without excluding the
   drug's own classes each of those flags the drug against itself.
"""
import json
import re
import urllib.parse
import urllib.request

OPENFDA = "https://api.fda.gov/drug/label.json"
DAILYMED = "https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid={}"
TIMEOUT = 25

# Sections that state "do not use", and the severity each implies. Ordering
# matters only for which evidence wins when both mention the same target.
FLAG_SECTIONS = {"boxed_warning": "CONTRAINDICATED", "contraindications": "CONTRAINDICATED"}
REFERENCE_SECTIONS = ("drug_interactions",)

# Salt and ester suffixes a label appends to the ingredient name.
SALT = (r"(?:\s+(?:hydrochloride|hcl|sulfate|sulphate|citrate|tartrate|bitartrate|"
        r"maleate|sodium|potassium|calcium|acetate|nitrate|besylate|mesylate|"
        r"succinate|phosphate|dihydrochloride|monohydrate))*")

# How labels name the classes our drugs belong to. Curated and short on
# purpose: these are the words that appear in the prose, not RxClass concept
# names, and a phrase missing here costs a flag rather than inventing one.
CLASS_PHRASES = {
    "Phosphodiesterase 5 Inhibitors": [r"pde[\s-]?5", r"phosphodiesterase[\s-]?(?:type[\s-]?)?5"],
    "Phosphodiesterase 5 Inhibitor": [r"pde[\s-]?5", r"phosphodiesterase[\s-]?(?:type[\s-]?)?5"],
    "Nitrate Vasodilator": [r"\bnitrates?\b", r"nitric oxide donor"],
    "Nitric Oxide Donors": [r"nitric oxide donor", r"\bnitrates?\b"],
    "Adrenergic beta-Antagonists": [r"beta[\s-]?blocker", r"β[\s-]?blocker",
                                    r"beta[\s-]?adrenergic (?:blocking|blocker|antagonist)"],
    "beta-Adrenergic Blocker": [r"beta[\s-]?blocker", r"β[\s-]?blocker",
                                r"beta[\s-]?adrenergic (?:blocking|blocker|antagonist)"],
    "Guanylate Cyclase Stimulators": [r"guanylate cyclase"],
    "Monoamine Oxidase Inhibitors": [r"\bmao\b", r"monoamine oxidase"],
}

# A sentence reporting that an interaction was NOT seen must never become a
# rule saying it was.
NEGATED = re.compile(
    r"\b(did not|does not|do not appear|were not|was not|no (?:significant|clinically|"
    r"apparent|meaningful)|not (?:potentiate|observed|affected|altered))\b", re.I)

# A contraindications section names three different things: drugs you must
# not give *together*, patient history, and the drug's own ingredients. Only
# the first is a drug-drug rule, and naming a drug is not enough to tell
# them apart -- these cues are. Without them the miner produced
# "dopamine + dextrose" (from a corn-allergy note about the diluent) and
# "norepinephrine + epinephrine" (from a sentence whose actual subject is
# halothane).
CO_ADMINISTRATION = re.compile(
    r"\b(concomitant|concurrent|co[\s-]?administ|in combination with|combination with|"
    r"giv(?:e|en) with|used with|taken with|together with|administration with|"
    r"administered with|use of|while (?:taking|receiving|using)|"
    r"patients (?:using|taking|receiving|on)\b)", re.I)

# Patient history, not co-administration: "reactions after taking aspirin"
# is a rule about who the patient is, not about what else is in the line.
HISTORY_ONLY = re.compile(
    r"\b(history of|after (?:taking|receiving|use)|who have (?:experienced|had)|"
    r"previous(?:ly)? (?:reaction|received)|allergy to|allergic to|"
    r"hypersensitivity to|known allergy)\b", re.I)


def _get(url: str):
    with urllib.request.urlopen(url, timeout=TIMEOUT) as resp:
        return json.load(resp)


def fetch_labels(drug_name: str, limit: int = 20) -> list:
    """Candidate label documents for an ingredient name. [] if none."""
    url = OPENFDA + "?" + urllib.parse.urlencode(
        {"search": f'openfda.generic_name:"{drug_name}"', "limit": limit})
    try:
        return _get(url).get("results", [])
    except Exception:  # noqa: BLE001 -- a 404 for an unlabelled drug is normal
        return []


def select_label(drug_name: str, results: list):
    """The best single-ingredient label for this drug, or None.

    Picks the richest one rather than the first: openFDA's ordering is not
    by usefulness, and many labels carry an empty contraindications section.
    """
    rx = re.compile(rf"^{re.escape(drug_name)}{SALT}$", re.I)
    best = None
    for r in results:
        generics = [g.strip() for g in (r.get("openfda") or {}).get("generic_name", [])]
        if len(generics) != 1 or not rx.match(generics[0]):
            continue
        sections = {k: " ".join(r.get(k, []))
                    for k in list(FLAG_SECTIONS) + list(REFERENCE_SECTIONS)}
        weight = sum(len(sections[k]) for k in FLAG_SECTIONS)
        if weight and (best is None or weight > best[0]):
            best = (weight, r, sections)
    return best


def fragments(text: str) -> list:
    """Bullet- and sentence-sized chunks of label prose.

    Label contraindications are bullet lists as often as sentences, and a
    1,600-character blob cannot serve as evidence for one specific pair.
    """
    text = re.sub(r"\s+", " ", text or "")
    parts = re.split(r"\s*[•·]\s*|(?<=[.;])\s+(?=[A-Z(])", text)
    return [p.strip() for p in parts if p and len(p.strip()) > 20]


# How far either side of a drug mention to look for the cue that qualifies
# it. Label contraindications are often one long run-on bullet listing a
# dozen drugs, so a cue found anywhere in the fragment says nothing about
# any particular one.
CUE_WINDOW = 140


def find_targets(fragment: str, self_name: str, self_classes: set,
                 known_drugs: dict) -> list:
    """[(kind, target, position)] mentioned in one fragment.

    Position is where the mention starts, so the caller can judge the cues
    *around that mention* rather than anywhere in the fragment.

    `known_drugs` maps a canonical drug name to the names and aliases it can
    appear under, so a label naming "Viagra" resolves the same way speech
    does.
    """
    found = {}
    for canonical, spellings in known_drugs.items():
        if canonical == self_name:
            continue
        for spelling in spellings:
            m = re.search(rf"\b{re.escape(spelling)}\b", fragment, re.I)
            if m:
                found[("drug", canonical)] = m.start()
                break
    for class_name, patterns in CLASS_PHRASES.items():
        if class_name in self_classes:
            continue
        for pattern in patterns:
            m = re.search(pattern, fragment, re.I)
            if m:
                found[("class", class_name)] = m.start()
                break
    return [(k, t, pos) for (k, t), pos in found.items()]


def qualifies(fragment: str, position: int) -> bool:
    """Is the mention at `position` a co-administration rule?

    Judged on a window around the mention. Checking the whole fragment
    dropped ziprasidone/droperidol -- its bullet says "should not be given
    with: ... droperidol ..." and then, 200 characters later, mentions
    hypersensitivity, which is a different rule about a different thing.
    """
    window = fragment[max(0, position - CUE_WINDOW): position + CUE_WINDOW]
    if NEGATED.search(window) or HISTORY_ONLY.search(window):
        return False
    return bool(CO_ADMINISTRATION.search(window))


def extract(drug: dict, sections: dict, set_id: str, known_drugs: dict) -> list:
    """Contraindication rows for one drug, each carrying its own evidence."""
    self_name = drug["drug_name"].lower()
    self_classes = {c.get("class_name") for c in (drug.get("classes") or [])}
    rows, seen = [], set()

    for section, severity in FLAG_SECTIONS.items():
        for fragment in fragments(sections.get(section, "")):
            for kind, target, position in find_targets(
                    fragment, self_name, self_classes, known_drugs):
                if (kind, target) in seen or not qualifies(fragment, position):
                    continue
                seen.add((kind, target))
                rows.append({
                    "kind": kind,
                    "target": target,
                    "severity": severity,
                    "section": section,
                    "evidence": fragment[:400],
                    "set_id": set_id,
                    "source": "FDA drug label via openFDA",
                    "source_url": DAILYMED.format(set_id) if set_id else None,
                })
    rows.sort(key=lambda r: (r["kind"], r["target"]))
    return rows


def known_drug_spellings(records: list) -> dict:
    """{canonical: [canonical, *aliases]} for every non-alias record."""
    aliases = {}
    for r in records:
        target = r.get("alias_of")
        if target:
            aliases.setdefault(str(target).lower(), []).append(str(r["drug_name"]).lower())
    return {
        str(r["drug_name"]).lower(): [str(r["drug_name"]).lower(),
                                      *aliases.get(str(r["drug_name"]).lower(), [])]
        for r in records if not r.get("alias_of")
    }
