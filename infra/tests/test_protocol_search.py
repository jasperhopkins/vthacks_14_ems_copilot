#!/usr/bin/env python3
"""
Offline checks for protocol retrieval scoring -- no AWS calls, no
credentials, no deploy needed:

    python3 infra/tests/test_protocol_search.py

`common/protocol_search.py` imports no boto3 precisely so this can run against
the real seed file with nothing stubbed. Scoring *and* the seed data are
tested together on purpose: the scorer is only as good as the `symptoms` /
`synonyms` lists it matches against, and a regression in either one shows up
the same way in the field -- as the wrong protocol, confidently delivered.

TestOldScorerRegressions is the reason this file exists. Each case there is
a query that the previous substring-counting scorer got wrong.
"""
import json
import pathlib
import random
import sys
import unittest

sys.dont_write_bytecode = True

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))

from common import protocol_search as search  # noqa: E402

PROTOCOLS = json.loads((ROOT / "seed" / "protocol_reference_seed.json").read_text())


def top(query, items=None):
    """The winning protocol_id, or None when the search abstains."""
    results = search.search(query, items if items is not None else PROTOCOLS)
    return results[0]["protocol_id"] if results else None


def ids(query, items=None):
    return [r["protocol_id"] for r in search.search(query, items if items is not None else PROTOCOLS)]


class TestOldScorerRegressions(unittest.TestCase):
    """Queries the substring-counting scorer answered wrongly.

    The scores in the comments are what it produced before the rewrite.
    """

    def test_symptom_phrasing_reaches_the_right_protocol(self):
        # Was a 2-2 tie with the opioid protocol: "patient" and "a" matched
        # both records and nothing clinical matched either.
        self.assertEqual(
            top("patient stung by a bee, face swelling, wheezing, hypotensive"),
            "PROT-ANAPHYLAXIS-01",
        )

    def test_lay_description_of_an_overdose(self):
        # Was a three-way 2-2-2 tie.
        self.assertEqual(
            top("kid is 22 kg and unresponsive, found with mom's pain pills"),
            "PROT-OPIOID-OD-01",
        )

    def test_does_not_invent_a_match_out_of_stopwords(self):
        # The headline bug: this scored 5 against anaphylaxis -- the highest
        # score of any query tested -- purely on "what/do/i/for/a". A query
        # with no correct answer produced the most confident-looking match.
        self.assertIsNone(top("what do I do for a diabetic emergency"))

    def test_clinical_phrasing_beats_incidental_word_overlap(self):
        # Previously won by the chest-pain record on the word "can".
        self.assertEqual(top("she took viagra last night, can I give nitro"),
                         "PROT-CHEST-PAIN-01")

    def test_classic_presentation(self):
        self.assertEqual(top("crushing substernal pressure radiating to jaw"),
                         "PROT-CHEST-PAIN-01")

    def test_direct_dosage_question_still_works(self):
        self.assertEqual(top("epinephrine dose for anaphylaxis"),
                         "PROT-ANAPHYLAXIS-01")


class TestAbstention(unittest.TestCase):
    """Returning nothing is a clinical feature. The handler turns an empty
    result into "consult your agency protocol or medical control" -- which
    is the correct answer when the database genuinely has no entry."""

    def test_missing_protocol_abstains_rather_than_guessing(self):
        # There is no seizure protocol in the seed data.
        self.assertIsNone(top("seizure"))
        self.assertIsNone(top("actively seizing for six minutes"))

    def test_pure_filler_query_abstains(self):
        self.assertEqual(search.query_terms("what should I do"), [])
        self.assertIsNone(top("what should I do"))

    def test_empty_and_missing_queries_are_not_fatal(self):
        for q in ("", "   ", None):
            self.assertEqual(search.query_terms(q), [])
            self.assertEqual(search.search(q, PROTOCOLS), [])

    def test_numbers_alone_never_match(self):
        # Patient specifics ("22 kg", "58 year old") are not protocol identity.
        self.assertEqual(search.query_terms("22 kg 58 year old"), [])


class TestScoring(unittest.TestCase):
    def test_scores_are_bounded(self):
        for q in ("chest pain", "narcan", "epinephrine dose for anaphylaxis",
                  "unresponsive pinpoint pupils"):
            for r in search.search(q, PROTOCOLS):
                self.assertGreaterEqual(r["score"], 0.0)
                self.assertLessEqual(r["score"], 1.0)

    def test_title_match_outweighs_steps_match(self):
        """Asserted on `score_protocol` rather than `search`, because the
        relative floor legitimately drops the steps-only record entirely --
        every protocol's `steps` mention oxygen, IV access and transport, so
        a hit there is weak evidence on its own."""
        terms = search.query_terms("widget")
        title_score, _ = search.score_protocol(terms, {"title": "Widget"})
        steps_score, _ = search.score_protocol(
            terms, {"steps": ["Administer widget now."]})
        self.assertGreater(title_score, steps_score)
        self.assertEqual(search.search("widget", [
            {"protocol_id": "B", "steps": ["Administer widget now."]},
            {"protocol_id": "A", "title": "Widget"},
        ])[0]["protocol_id"], "A")

    def test_long_record_does_not_win_on_volume(self):
        """The old scorer summed raw hits, so padding a record with text
        raised its score. Averaging over query length removes that."""
        concise = {"protocol_id": "SHORT", "title": "Widget"}
        padded = {"protocol_id": "LONG", "title": "Unrelated",
                  "steps": ["widget " * 200]}
        self.assertEqual(top("widget", [concise, padded]), "SHORT")

    def test_boilerplate_fields_contribute_nothing(self):
        """`reference_note` is near-identical across every record, so
        scoring it made it pure noise. Field scoring is a whitelist, so any
        unlisted attribute is ignored."""
        rec = {"protocol_id": "X", "title": "Widget",
               "reference_note": "SEED/DEMO protocol only -- zebra."}
        self.assertEqual(search.search("zebra", [rec]), [])
        self.assertEqual(search.search("seed demo", [rec]), [])

    def test_matched_terms_are_reported(self):
        results = search.search("crushing substernal pressure", PROTOCOLS)
        self.assertEqual(results[0]["protocol_id"], "PROT-CHEST-PAIN-01")
        self.assertEqual(set(results[0]["matched_terms"]),
                         {"crushing", "substernal", "pressure"})

    def test_original_record_fields_survive(self):
        """The handler passes these straight to Bedrock and the app renders
        `title`; scoring must not strip the record down."""
        result = search.search("narcan", PROTOCOLS)[0]
        self.assertEqual(result["title"], "Suspected Opioid Overdose")
        self.assertIn("steps", result)
        self.assertIn("reference_note", result)

    def test_weak_secondary_matches_are_dropped(self):
        # "pain" alone matches the opioid record via its "pain pills"
        # symptom. It is not a real alternative to the chest pain protocol.
        self.assertEqual(ids("chest pain"), ["PROT-CHEST-PAIN-01"])

    def test_genuine_ties_are_both_returned(self):
        # "shortness of breath" is listed under anaphylaxis *and* chest
        # pain, and an EMT should see both rather than one picked for them.
        self.assertEqual(
            set(ids("shortness of breath")),
            {"PROT-ANAPHYLAXIS-01", "PROT-CHEST-PAIN-01"},
        )

    def test_ranking_is_deterministic_regardless_of_scan_order(self):
        """DynamoDB scan order is not stable. An EMT re-asking the same
        question must not get a different protocol."""
        baseline = ids("shortness of breath")
        rng = random.Random(0)
        for _ in range(20):
            shuffled = PROTOCOLS[:]
            rng.shuffle(shuffled)
            self.assertEqual(ids("shortness of breath", shuffled), baseline)


class TestTokenization(unittest.TestCase):
    def test_matches_whole_words_not_substrings(self):
        """`"a" in haystack` was true for every record ever written."""
        rec = {"protocol_id": "X", "symptoms": ["pinpoint pupils"]}
        self.assertEqual(search.search("pin", [rec]), [])
        self.assertEqual(top("pinpoint", [rec]), "X")

    def test_singular_and_plural_match_either_direction(self):
        self.assertEqual(top("hive"), "PROT-ANAPHYLAXIS-01")
        self.assertEqual(top("hives"), "PROT-ANAPHYLAXIS-01")
        self.assertEqual(top("pinpoint pupil"), "PROT-OPIOID-OD-01")
        self.assertEqual(top("pinpoint pupils"), "PROT-OPIOID-OD-01")

    def test_folding_is_applied_identically_to_both_sides(self):
        """The fold is crude on purpose -- "anaphylaxis" becomes
        "anaphylaxi". That is harmless as long as records fold the same way,
        which is the only property this function actually needs."""
        for word in ("anaphylaxis", "unconscious", "distress", "allergies",
                     "rashes", "status"):
            self.assertEqual(search._fold(word),
                             next(iter(search._tokens(word))))

    def test_double_s_words_are_not_stripped(self):
        self.assertEqual(search._fold("distress"), "distress")

    def test_field_slang_is_reachable_through_synonyms(self):
        # "epi" and "narcan" are what gets said out loud. The drug table has
        # alias rows for this; protocols carry it in `synonyms`.
        self.assertEqual(top("epi"), "PROT-ANAPHYLAXIS-01")
        self.assertEqual(top("narcan"), "PROT-OPIOID-OD-01")
        self.assertEqual(top("ntg"), "PROT-CHEST-PAIN-01")

    def test_protocol_id_retrieves_itself(self):
        self.assertEqual(top("PROT-ANAPHYLAXIS-01"), "PROT-ANAPHYLAXIS-01")

    def test_case_and_punctuation_are_irrelevant(self):
        self.assertEqual(top("PINPOINT PUPILS!!!"), "PROT-OPIOID-OD-01")
        self.assertEqual(top("pinpoint, pupils."), "PROT-OPIOID-OD-01")


class TestSeedData(unittest.TestCase):
    """The scorer leans on these fields; an unfilled record is invisible to
    symptom-phrased queries even though it looks fine in the console."""

    def test_every_protocol_has_retrieval_fields(self):
        for rec in PROTOCOLS:
            with self.subTest(rec["protocol_id"]):
                self.assertTrue(rec.get("symptoms"), "missing symptoms")
                self.assertTrue(rec.get("synonyms"), "missing synonyms")

    def test_retrieval_fields_are_not_labelled_as_clinical_criteria(self):
        """These lists are phrasing aids. Anything that presents them as
        diagnostic criteria turns a lookup tool into a triage tool."""
        for rec in PROTOCOLS:
            with self.subTest(rec["protocol_id"]):
                self.assertIn("NOT diagnostic criteria", rec["reference_note"])

    def test_seed_data_is_still_labelled_as_demo_data(self):
        for rec in PROTOCOLS:
            with self.subTest(rec["protocol_id"]):
                self.assertIn("SEED/DEMO", rec["reference_note"])

    def test_every_protocol_is_reachable_by_its_own_title(self):
        for rec in PROTOCOLS:
            with self.subTest(rec["protocol_id"]):
                self.assertIn(rec["protocol_id"], ids(rec["title"]))

    def test_no_symptom_is_pure_stopwords(self):
        """A symptom that folds away to nothing ("on the way") silently
        contributes no retrieval value."""
        for rec in PROTOCOLS:
            for phrase in rec["symptoms"] + rec["synonyms"]:
                with self.subTest(protocol=rec["protocol_id"], phrase=phrase):
                    self.assertTrue(
                        set(search._tokens(phrase)) - search.STOPWORDS,
                        f"{phrase!r} is entirely stopwords",
                    )


if __name__ == "__main__":
    unittest.main(verbosity=2)
