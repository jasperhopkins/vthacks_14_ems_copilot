#!/usr/bin/env python3
"""
Offline checks for the NASEMSO PDF ingestion -- no network, no AWS, no PDF:

    python3 infra/tests/test_nasemso_ingest.py

Every fixture in TestHeadings/TestTitles/TestSections is a real defect this
parser hit against the actual 407-page document, and every one of them
failed *silently* -- producing a protocol with no treatment steps, or two
guidelines merged into one, rather than an error. That is the whole reason
they are pinned here: a protocol that looks fine in DynamoDB and is missing
its dosing section is the worst possible outcome for this subsystem.

TestExtractedSeed runs over the committed seed file, so a re-ingest that
quietly drops guidelines fails here rather than at a demo.
"""
import json
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "seed"))
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))

import ingest_nasemso as ing  # noqa: E402
from common import protocol_search as search  # noqa: E402

SEED_PATH = ROOT / "seed" / "nasemso_protocol_seed.json"
SEED = json.loads(SEED_PATH.read_text()) if SEED_PATH.exists() else []


class TestHeadings(unittest.TestCase):
    """The document spells its own section headings nine different ways.

    Matching exact strings produced protocols with no treatment steps at
    all -- including opioid overdose and chest pain, the two this project
    demos.
    """

    TREATMENT_SPELLINGS = [
        "Treatment and Interventions",
        "Treatments and Interventions",
        "Assessment, Treatment, and Interventions",
        "Assessment, Treatments, and Interventions",
        "Immediate Treatment and Interventions",
        "Secondary Assessment, Treatment, and Interventions",
        "Treatment and Interventions:",
        "Treatment and Interventions (See dosing tables)",
        "Treatment and Troubleshooting Interventions",
    ]

    def test_every_treatment_spelling_normalizes(self):
        for spelling in self.TREATMENT_SPELLINGS:
            with self.subTest(spelling):
                self.assertEqual(ing.normalize_heading(spelling),
                                 "Treatment and Interventions")

    def test_case_and_indentation_are_irrelevant(self):
        self.assertEqual(ing.normalize_heading("   inclusion criteria  "),
                         "Inclusion Criteria")
        self.assertEqual(ing.normalize_heading("Exclusion criteria"),
                         "Exclusion Criteria")

    def test_combined_criteria_heading(self):
        self.assertEqual(ing.normalize_heading("Inclusion/Exclusion Criteria"),
                         "Inclusion Criteria")

    def test_prose_is_not_a_heading(self):
        for line in ["1. Treatment and Interventions should begin",
                     "Treatment provided", "• Treatment and response to treatment",
                     "Treatment. JAMA. 2018;319(7):698-710"]:
            with self.subTest(line):
                self.assertIsNone(ing.normalize_heading(line))

    def test_long_lines_are_never_headings(self):
        self.assertIsNone(ing.normalize_heading("Assessment " * 12))


class TestTitles(unittest.TestCase):
    def test_reads_a_simple_title(self):
        body = ["Tracheostomy Management", "Aliases", "None"]
        self.assertEqual(ing.read_title(body, set(), "Respiratory")[0],
                         "Tracheostomy Management")

    def test_joins_a_wrapped_title(self):
        # Real: page 31. Dropping the second line lost "Infarction (STEMI)".
        body = ["Chest Pain/Acute Coronary Syndrome (ACS)/ST-segment Elevation Myocardial",
                "Infarction (STEMI)", "Aliases", "Heart attack"]
        title, _ = ing.read_title(body, set(), "Cardiovascular")
        self.assertEqual(
            title,
            "Chest Pain/Acute Coronary Syndrome (ACS)/ST-segment Elevation "
            "Myocardial Infarction (STEMI)")

    def test_skips_the_adapted_from_preamble_even_when_it_wraps(self):
        """Only the preamble's first line starts with "(", so skipping just
        that line glued "Model Process" onto five titles -- and collapsed
        both pediatric respiratory guidelines onto one id."""
        body = ["Seizures",
                "(Adapted from an evidence-based guideline created using the National",
                "Prehospital Evidence-Based Guideline Model Process)",
                "Aliases", "Convulsions"]
        self.assertEqual(ing.read_title(body, set(), "General Medical")[0], "Seizures")

    def test_strips_a_leading_section_divider(self):
        # The section divider shares a page with that section's first
        # guideline, so it lands at the front of the title.
        body = ["Cardiovascular", "Adult and Pediatric Syncope and Near Syncope",
                "Aliases", "Fainting"]
        self.assertEqual(ing.read_title(body, set(), "Cardiovascular")[0],
                         "Adult and Pediatric Syncope and Near Syncope")

    def test_divider_alone_is_not_a_guideline(self):
        self.assertIsNone(ing.read_title(["Trauma", "Aliases"], set(), "Trauma")[0])

    def test_subheading_is_not_a_title(self):
        """"Pediatric-Appropriate Pain Assessment Tools" is a sub-heading
        inside Pain Management. Treating it as a title truncated the real
        guideline; requiring Aliases/Patient Care Goals to follow is what
        distinguishes them."""
        body = ["Pediatric-Appropriate Pain Assessment Tools",
                "1. FLACC scale for younger children",
                "2. Numeric rating scale"]
        self.assertIsNone(ing.read_title(body, set(), "General Medical")[0])

    def test_indented_line_is_not_a_title(self):
        self.assertIsNone(ing.read_title(["    Assessment", "Aliases"],
                                         set(), "Trauma")[0])


class TestSections(unittest.TestCase):
    GUIDELINE = [
        "Aliases",
        "Anaphylactic Shock",
        "Patient Presentation",
        "         Inclusion Criteria",
        "         Patients of all ages with suspected allergic reaction",
        "         Exclusion Criteria",
        "         None noted",
        "Patient Management",
        "         Assessment",
        "         1. Evaluate for patent airway",
        "         Treatment and Interventions",
        "         1. If signs of allergic reaction, go to Step 8",
        "         2. Administer epinephrine at the following dose:",
        "             a. Adult (25 kg or more) 0.3 mg IM in the anterolateral thigh",
        "             b. Pediatric (less than 25 kg) 0.15 mg",
    ]

    def test_splits_into_named_sections(self):
        sec = ing.split_sections(self.GUIDELINE)
        self.assertIn("Treatment and Interventions", sec)
        self.assertIn("Inclusion Criteria", sec)
        self.assertIn("Assessment", sec)

    def test_sub_items_stay_with_their_step(self):
        """A step's dose usually lives in a sub-item ("administer
        epinephrine at the following dose: a. Adult 0.3 mg IM"). Dropping
        sub-items leaves a step that names a drug and no dose."""
        steps = ing._bullets(
            ing.split_sections(self.GUIDELINE)["Treatment and Interventions"])
        self.assertEqual(len(steps), 2)
        self.assertIn("0.3 mg IM", steps[1])
        self.assertIn("0.15 mg", steps[1])

    def test_numbering_is_stripped_from_the_step_text(self):
        steps = ing._bullets(
            ing.split_sections(self.GUIDELINE)["Treatment and Interventions"])
        self.assertTrue(steps[0].startswith("If signs of allergic reaction"))

    def test_prose_sections_are_not_dropped(self):
        """Functional Needs writes its treatment guidance as paragraphs.
        Requiring numbered items returned [] and produced a protocol with no
        steps whose PDF page plainly has them."""
        prose = ["Medical care should not be reduced during triage.", "",
                 "The way care is provided may need to change."]
        self.assertEqual(ing._bullets(prose), [
            "Medical care should not be reduced during triage.",
            "The way care is provided may need to change."])

    def test_empty_section(self):
        self.assertEqual(ing._bullets([]), [])
        self.assertEqual(ing._bullets(None), [])


class TestAliases(unittest.TestCase):
    def test_splits_multi_column_layout(self):
        """Aliases are laid out in up to three columns, so one text line
        holds three unrelated terms. Not splitting them turned the opioid
        guideline's 18 search terms into six run-on strings."""
        lines = ["Carfentanil                 Dilaudid®              Drug abuse",
                 "Fentanyl                    Heroin                 Hydrocodone"]
        self.assertEqual(ing._aliases(lines),
                         ["Carfentanil", "Dilaudid", "Drug abuse",
                          "Fentanyl", "Heroin", "Hydrocodone"])

    def test_drops_placeholders(self):
        self.assertEqual(ing._aliases(["None noted"]), [])
        self.assertEqual(ing._aliases(["None"]), [])


class TestSlugs(unittest.TestCase):
    def test_parentheses_are_content_not_noise(self):
        """Stripping the parenthetical collapsed "Pediatric Respiratory
        Distress (Bronchiolitis)" and "(Croup)" onto one protocol_id -- and
        protocol_id is the partition key, so one silently overwrote the
        other at seed time."""
        a = ing._slug("Pediatric Respiratory Distress (Bronchiolitis)")
        b = ing._slug("Pediatric Respiratory Distress (Croup)")
        self.assertNotEqual(a, b)

    def test_never_ends_mid_word(self):
        slug = ing._slug("Chest Pain/Acute Coronary Syndrome (ACS)/ST-segment "
                         "Elevation Myocardial Infarction (STEMI)")
        self.assertFalse(slug.endswith("-"))
        self.assertLessEqual(len(slug), 64)
        self.assertIn("CHEST-PAIN", slug)


class TestPageFooter(unittest.TestCase):
    def test_reads_the_category(self):
        lines = ["body", "____________", "Cardiovascular            Rev. March 2022",
                 "Bradycardia                    35"]
        self.assertEqual(ing.page_footer(lines)[0], "Cardiovascular")

    def test_no_footer(self):
        self.assertEqual(ing.page_footer(["just body text"]), (None, None))


@unittest.skipUnless(SEED, "nasemso_protocol_seed.json not generated yet")
class TestExtractedSeed(unittest.TestCase):
    """Guards the committed extraction against a silent re-ingest regression."""

    def test_expected_guideline_count(self):
        # The document has 71 "Patient Management" sections.
        self.assertEqual(len(SEED), 71)

    def test_protocol_ids_are_unique(self):
        ids = [r["protocol_id"] for r in SEED]
        self.assertEqual(len(ids), len(set(ids)))

    def test_every_record_has_retrievable_content(self):
        for r in SEED:
            with self.subTest(r["protocol_id"]):
                self.assertTrue(r["steps"] or r["indications"])

    def test_the_guidelines_this_project_demos_have_steps(self):
        # These are exactly the ones the heading-variant bug silently emptied.
        for needle in ("OPIOID-POISONING", "CHEST-PAIN", "ANAPHYLAXIS",
                       "SEIZURES", "HYPOGLYCEMIA"):
            with self.subTest(needle):
                rec = next(r for r in SEED if needle in r["protocol_id"])
                self.assertTrue(rec["steps"], f"{rec['protocol_id']} has no steps")

    def test_every_record_cites_its_source_page(self):
        for r in SEED:
            with self.subTest(r["protocol_id"]):
                self.assertIsInstance(r["source_page"], int)
                self.assertIn(str(r["source_page"]), r["reference_note"])

    def test_records_are_labelled_as_a_model_not_an_agency_protocol(self):
        for r in SEED:
            with self.subTest(r["protocol_id"]):
                self.assertIn("NATIONAL MODEL", r["reference_note"])
                self.assertIn("NOT", r["reference_note"])

    def test_doses_survived_extraction(self):
        anaphylaxis = next(r for r in SEED if "ANAPHYLAXIS" in r["protocol_id"])
        joined = " ".join(anaphylaxis["steps"])
        self.assertIn("0.3 mg", joined)
        self.assertIn("epinephrine", joined.lower())

    def test_multi_column_aliases_became_separate_terms(self):
        opioid = next(r for r in SEED if "OPIOID-POISONING" in r["protocol_id"])
        for term in ("fentanyl", "heroin", "oxycodone", "methadone"):
            with self.subTest(term):
                self.assertIn(term, opioid["synonyms"])


@unittest.skipUnless(SEED, "nasemso_protocol_seed.json not generated yet")
class TestRetrievalQuality(unittest.TestCase):
    """A floor, not a target. Scoring 71 long documents with token overlap is
    a stopgap -- the documented replacement is a real index (Bedrock
    Knowledge Base / OpenSearch). This test exists so tuning the weights
    can't quietly make retrieval worse than it is today."""

    GOLD = [
        ("crushing chest pressure radiating to the jaw", "CHEST-PAIN"),
        ("seizure", "SEIZURES"),
        ("actively seizing for six minutes", "SEIZURES"),
        ("blood sugar is 38 and he's confused", "HYPOGLYCEMIA"),
        ("woman in labor contractions two minutes apart", "CHILDBIRTH"),
        ("unresponsive pinpoint pupils not breathing", "OPIOID"),
        ("hypothermic pulled from a lake", "HYPOTHERMIA"),
        ("stroke symptoms facial droop slurred speech", "STROKE"),
        ("severe allergic reaction to peanuts", "ANAPHYLAXIS"),
        ("cardiac arrest no pulse", "CARDIAC-ARREST"),
        ("snake bite on the ankle", "BITES"),
        ("heat stroke marathon runner", "HYPERTHERMIA"),
        ("carbon monoxide detector going off headache", "CARBON-MONOXIDE"),
    ]

    def test_top_hit_is_the_right_guideline(self):
        misses = []
        for query, want in self.GOLD:
            hits = search.search(query, SEED)
            top = hits[0]["protocol_id"] if hits else "NO MATCH"
            if want not in top:
                misses.append(f"{query!r} -> {top} (wanted {want})")
        self.assertLessEqual(
            len(misses), 1,
            "retrieval regressed:\n  " + "\n  ".join(misses))

    def test_a_topic_the_corpus_does_not_cover_still_abstains(self):
        self.assertEqual(search.search("how do I file my tax return", SEED), [])

    def test_ranking_is_deterministic(self):
        import random
        baseline = [r["protocol_id"] for r in search.search("seizure", SEED)]
        rng = random.Random(0)
        for _ in range(5):
            shuffled = SEED[:]
            rng.shuffle(shuffled)
            self.assertEqual([r["protocol_id"] for r in search.search("seizure", shuffled)],
                             baseline)


if __name__ == "__main__":
    unittest.main(verbosity=2)
