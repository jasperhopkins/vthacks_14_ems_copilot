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
    import app as pcr_app
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
            pcr_status._drugs_mentioned(structured),
            ["epinephrine", "albuterol", "Propranolol"],
        )

    def test_handles_missing_and_null_fields(self):
        self.assertEqual(pcr_status._drugs_mentioned({}), [])
        self.assertEqual(
            pcr_status._drugs_mentioned({"medications_administered": None, "patient_medications": None}),
            [],
        )

    def test_tolerates_plain_strings_from_the_model(self):
        # Bedrock occasionally returns ["aspirin"] instead of [{"name": ...}].
        self.assertEqual(
            pcr_status._drugs_mentioned({"medications_administered": ["aspirin"]}),
            ["aspirin"],
        )


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


if __name__ == "__main__":
    unittest.main(verbosity=2)
