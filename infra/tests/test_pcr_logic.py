#!/usr/bin/env python3
"""
Offline checks for the parts of the voice-to-PCR pipeline that are pure
logic -- no AWS calls, no credentials, no deploy needed:

    python3 infra/tests/test_pcr_logic.py

Everything that actually talks to Transcribe/Bedrock/DynamoDB is stubbed;
this is a guard against dumb regressions in the drug cross-check and the
media-format handling, not a substitute for a real end-to-end run.
"""
import json
import os
import pathlib
import sys
import unittest

# These tests put the layer source on sys.path; don't litter it with .pyc
# that would then get packaged into the deployed layer.
sys.dont_write_bytecode = True
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))
sys.path.insert(0, str(ROOT / "src" / "pcr"))

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AUDIO_BUCKET_NAME", "test-bucket")
os.environ.setdefault("DRUG_TABLE_NAME", "test-drugs")

# Module-level boto3 clients exist in every handler; stub them at import.
with mock.patch("boto3.resource"), mock.patch("boto3.client"):
    from common import drugs as drugs_mod
    from common import pcr as pcr_common
    import app as pcr_app
    import chunk as pcr_chunk
    import status as pcr_status

SEED = {
    d["drug_name"]: d
    for d in json.loads((ROOT / "seed" / "drug_reference_seed.json").read_text())
}


class FakeTable:
    def __init__(self, data):
        self.data = data

    def get_item(self, Key):
        item = self.data.get(Key["drug_name"])
        return {"Item": item} if item else {}


def use_table(data):
    """Point common.drugs at fixture data and force name normalization down
    its offline fallback path (lowercase), so these tests never need
    Comprehend Medical."""
    drugs_mod._drug_table = FakeTable(data)
    drugs_mod.comprehend_medical = mock.MagicMock()
    drugs_mod.comprehend_medical.infer_rx_norm.side_effect = RuntimeError("offline")


class TestInteractionCheck(unittest.TestCase):
    def setUp(self):
        use_table(SEED)

    def test_flags_contraindicated_pair(self):
        flags = drugs_mod.check_interactions(["epinephrine", "propranolol"])
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0]["severity"], "CONTRAINDICATED")
        self.assertIn("alpha", flags[0]["note"].lower())

    def test_pair_order_does_not_matter(self):
        self.assertEqual(len(drugs_mod.check_interactions(["propranolol", "epinephrine"])), 1)

    def test_one_flag_per_pair_even_when_both_sides_list_it(self):
        # Seed data records epi->propranolol AND propranolol->epi; the EMT
        # should see one warning, not two.
        flags = drugs_mod.check_interactions(["epinephrine", "propranolol", "naloxone"])
        self.assertEqual(len(flags), 1)

    def test_catches_interaction_recorded_on_only_one_side(self):
        one_sided = {
            "nitroglycerin": {
                "drug_name": "nitroglycerin",
                "contraindicated_with": ["sildenafil"],
                "interaction_notes": {"sildenafil": "Refractory hypotension."},
            },
            "sildenafil": {"drug_name": "sildenafil", "contraindicated_with": []},
        }
        use_table(one_sided)
        flags = drugs_mod.check_interactions(["sildenafil", "nitroglycerin"])
        self.assertEqual(len(flags), 1)
        self.assertEqual(flags[0]["note"], "Refractory hypotension.")

    def test_safe_combination_has_no_flags(self):
        self.assertEqual(drugs_mod.check_interactions(["naloxone", "albuterol"]), [])

    def test_unknown_drug_is_ignored_not_fatal(self):
        self.assertEqual(drugs_mod.check_interactions(["epinephrine", "unobtainium"]), [])

    def test_case_insensitive(self):
        self.assertEqual(len(drugs_mod.check_interactions(["Epinephrine", "PROPRANOLOL"])), 1)

    def test_resolves_field_slang_through_alias_rows(self):
        # "epi" is what an EMT says; Comprehend Medical returns no entity at
        # all for it, so this has to come from the alias row.
        canonical, record = drugs_mod.resolve_drug("epi")
        self.assertEqual(canonical, "epinephrine")
        self.assertEqual(record["drug_name"], "epinephrine")

    def test_resolves_brand_name_through_alias_rows(self):
        # RxNorm maps "narcan" to the *brand* concept, not to naloxone.
        self.assertEqual(drugs_mod.resolve_drug("narcan")[0], "naloxone")

    def test_flags_interaction_stated_in_slang(self):
        flags = drugs_mod.check_interactions(["epi", "inderal"])
        self.assertEqual(len(flags), 1)
        # The flag echoes what was said, not the canonical name.
        self.assertEqual({flags[0]["drug_a"], flags[0]["drug_b"]}, {"epi", "inderal"})

    def test_unresolvable_name_returns_itself(self):
        self.assertEqual(drugs_mod.resolve_drug("unobtainium"), ("unobtainium", None))


class TestDrugsMentioned(unittest.TestCase):
    def test_merges_administered_and_home_meds_without_duplicates(self):
        structured = {
            "medications_administered": [
                {"name": "epinephrine", "dose": "0.3 mg", "route": "IM"},
                {"name": "albuterol", "dose": None, "route": "neb"},
            ],
            "patient_medications": ["Propranolol", "epinephrine"],
        }
        self.assertEqual(
            pcr_common.drugs_mentioned(structured),
            ["epinephrine", "albuterol", "Propranolol"],
        )

    def test_handles_missing_and_null_fields(self):
        self.assertEqual(pcr_common.drugs_mentioned({}), [])
        self.assertEqual(
            pcr_common.drugs_mentioned({"medications_administered": None, "patient_medications": None}),
            [],
        )

    def test_tolerates_plain_strings_from_the_model(self):
        # Bedrock occasionally returns ["aspirin"] instead of [{"name": ...}].
        self.assertEqual(
            pcr_common.drugs_mentioned({"medications_administered": ["aspirin"]}),
            ["aspirin"],
        )


class TestNormalizePcr(unittest.TestCase):
    """The UI renders every field unconditionally and commit round-trips the
    dict straight back, so a missing key from the model has to become an
    explicit null here rather than an absent attribute downstream."""

    def test_fills_in_every_field(self):
        out = pcr_common.normalize_pcr({"chief_complaint": "Anaphylaxis"})
        self.assertEqual(set(out), set(pcr_common.PCR_FIELDS))
        self.assertEqual(out["chief_complaint"], "Anaphylaxis")
        self.assertEqual(out["interventions"], [])
        self.assertEqual(set(out["vitals"]), set(pcr_common.VITALS_FIELDS))
        self.assertIsNone(out["vitals"]["bp"])

    def test_coerces_bare_string_medications(self):
        out = pcr_common.normalize_pcr({"medications_administered": ["aspirin"]})
        self.assertEqual(
            out["medications_administered"],
            [{"name": "aspirin", "dose": None, "route": None, "time": None}],
        )

    def test_drops_blank_list_entries(self):
        out = pcr_common.normalize_pcr({"allergies": ["", None, " penicillin "]})
        self.assertEqual(out["allergies"], ["penicillin"])

    def test_survives_a_non_dict(self):
        self.assertEqual(pcr_common.normalize_pcr(None)["chief_complaint"], None)

    def test_is_idempotent(self):
        once = pcr_common.normalize_pcr({"chief_complaint": "Chest pain",
                                         "medications_administered": ["aspirin"]})
        self.assertEqual(pcr_common.normalize_pcr(once), once)


class TestSummaryAttrs(unittest.TestCase):
    """These are what the sparse ByUserSaved index projects; the list screen
    has nothing else to render from."""

    STRUCTURED = {
        "chief_complaint": "Anaphylaxis",
        "patient_age": "58",
        "patient_sex": "male",
        "narrative_summary": "Bee sting with airway swelling.",
        "medications_administered": [{"name": "Epinephrine", "dose": "0.3 mg"}],
        "patient_medications": ["Propranolol"],
        "interventions": ["High-flow oxygen"],
        "allergies": [],
    }
    FLAGS = [{"drug_a": "Epinephrine", "drug_b": "Propranolol", "severity": "CONTRAINDICATED"}]

    def test_search_text_is_lowercased_and_covers_every_searchable_field(self):
        attrs = pcr_common.build_summary_attrs(self.STRUCTURED, self.FLAGS)
        text = attrs["search_text"]
        self.assertEqual(text, text.lower())
        for needle in ("anaphylaxis", "bee sting", "epinephrine", "propranolol",
                       "high-flow oxygen", "58 male", "contraindicated"):
            self.assertIn(needle, text)

    def test_counts_flags_and_labels_the_patient(self):
        attrs = pcr_common.build_summary_attrs(self.STRUCTURED, self.FLAGS)
        self.assertEqual(attrs["flag_count"], 1)
        self.assertEqual(attrs["patient_label"], "58 male")
        self.assertEqual(attrs["summary_meds"], ["Epinephrine"])

    def test_falls_back_when_the_narration_said_nothing_useful(self):
        attrs = pcr_common.build_summary_attrs(pcr_common.normalize_pcr({}), [])
        self.assertEqual(attrs["summary_chief_complaint"], "Unspecified complaint")
        self.assertEqual(attrs["patient_label"], "Patient")
        self.assertEqual(attrs["flag_count"], 0)


class TestMediaFormat(unittest.TestCase):
    def test_accepts_transcribe_supported_extensions(self):
        self.assertEqual(pcr_app._media_format("audio/u/x.m4a"), "m4a")
        self.assertEqual(pcr_app._media_format("audio/u/x.WAV"), "wav")

    def test_falls_back_for_unsupported_or_missing_extension(self):
        self.assertEqual(pcr_app._media_format("audio/u/x.caf"), "mp4")
        self.assertEqual(pcr_app._media_format("audio/u/noextension"), "mp4")


class TestJobName(unittest.TestCase):
    def test_sanitizes_and_stays_unique(self):
        name = pcr_app._job_name("demo/encounter 1")
        self.assertRegex(name, r"^ems-pcr-demo-encounter-1-[0-9a-f]{8}$")
        self.assertNotEqual(name, pcr_app._job_name("demo/encounter 1"))

    def test_chunk_job_names_are_unique_per_sequence(self):
        # Every chunk of one encounter starts its own Transcribe job, and
        # job names are unique per account -- a collision would fail the
        # chunk rather than overwrite anything, but silently mid-recording.
        a = pcr_chunk._job_name("demo/encounter 1", 0)
        b = pcr_chunk._job_name("demo/encounter 1", 1)
        self.assertRegex(a, r"^ems-chunk-demo-encounter-1-0-[0-9a-f]{8}$")
        self.assertRegex(b, r"^ems-chunk-demo-encounter-1-1-[0-9a-f]{8}$")
        self.assertNotEqual(a, pcr_chunk._job_name("demo/encounter 1", 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
