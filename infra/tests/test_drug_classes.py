#!/usr/bin/env python3
"""
Offline checks for class-level drug interaction rules and the RxClass
parsing that feeds them -- no AWS calls, no network, no deploy:

    python3 infra/tests/test_drug_classes.py

Two separate things are covered, because both can fail silently and both
fail as *wrong clinical output* rather than as an error:

  - `common/drugs.py` -- that class rules add flags without ever displacing
    a curated one (TestCuratedRulesSurvive is the load-bearing case), and
    that they don't fire on a drug against itself.
  - `seed/rxclass.py` -- that the `rela` filtering is applied, since RxNav
    returns contraindication relations mixed in with membership ones and
    ignores the `rela` query parameter.

The pair-level interaction tests live in `test_pcr_logic.py`; this file is
only about the class layer added on top of them.
"""
import json
import os
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True
from unittest import mock  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))
sys.path.insert(0, str(ROOT / "seed"))

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("DRUG_TABLE_NAME", "test-drugs")

with mock.patch("boto3.resource"), mock.patch("boto3.client"):
    from common import drugs as drugs_mod

import rxclass  # noqa: E402  -- pure stdlib, no boto3

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
    drugs_mod._drug_table = FakeTable(data)
    drugs_mod.comprehend_medical = mock.MagicMock()
    drugs_mod.comprehend_medical.infer_rx_norm.side_effect = RuntimeError("offline")


def only_flag(names):
    flags = drugs_mod.check_interactions(names)
    assert len(flags) == 1, f"expected exactly one flag, got {flags}"
    return flags[0]


class TestCuratedRulesSurvive(unittest.TestCase):
    """The reason class rules merge rather than replace.

    RxClass has no contraindication relation between epinephrine and
    propranolol -- both drugs' `contraindicated_classes` are empty. If the
    class layer ever became the source of truth, this project's headline
    cross-check would vanish silently.
    """

    def setUp(self):
        use_table(SEED)

    def test_epi_propranolol_still_fires(self):
        flag = only_flag(["epinephrine", "propranolol"])
        self.assertEqual(flag["severity"], "CONTRAINDICATED")
        self.assertIn("alpha", flag["note"].lower())

    def test_epi_propranolol_comes_from_the_curated_layer(self):
        self.assertEqual(only_flag(["epinephrine", "propranolol"])["basis"],
                         "curated_pair")

    def test_rxclass_really_has_nothing_for_that_pair(self):
        # Pins the premise above: if a future refresh starts populating
        # these, this test tells you the class layer now covers it too.
        for name in ("epinephrine", "propranolol"):
            self.assertEqual(SEED[name].get("contraindicated_classes"), [],
                             f"{name} unexpectedly has class contraindications")

    def test_curated_note_wins_when_both_layers_match(self):
        # nitro + sildenafil is covered by BOTH a curated pair and the
        # class rule. The medic should get the hand-written note.
        flag = only_flag(["nitroglycerin", "sildenafil"])
        self.assertEqual(flag["basis"], "curated_pair")
        self.assertIn("refractory hypotension", flag["note"].lower())


class TestClassRulesAddCoverage(unittest.TestCase):
    """The payoff: drugs nobody added to a pairwise list."""

    def setUp(self):
        use_table(SEED)

    def test_flags_pde5_inhibitors_absent_from_any_curated_list(self):
        for drug in ("vardenafil", "avanafil"):
            with self.subTest(drug):
                self.assertNotIn(
                    drug,
                    [c.lower() for c in SEED["nitroglycerin"]["contraindicated_with"]],
                    "test is meaningless if the curated list already has it")
                flag = only_flag(["nitroglycerin", drug])
                self.assertEqual(flag["basis"], "drug_class")

    def test_class_flag_names_the_class_and_its_source(self):
        flag = only_flag(["nitroglycerin", "vardenafil"])
        self.assertIn("Phosphodiesterase 5 Inhibitors", flag["note"])
        self.assertIn("RxClass", flag["note"])
        self.assertEqual([c["class_id"] for c in flag["matched_classes"]],
                         ["N0000020026"])

    def test_works_through_brand_name_aliases(self):
        self.assertEqual(only_flag(["nitro", "levitra"])["basis"], "drug_class")
        self.assertEqual(only_flag(["ntg", "stendra"])["basis"], "drug_class")

    def test_fires_although_only_one_side_records_the_class(self):
        """RxClass records this pair on nitroglycerin's side only, so the
        reverse direction finds nothing and the bidirectional check is what
        saves it.

        Vardenafil is contraindicated with "Guanylate Cyclase Stimulators"
        (N0000190484) while nitroglycerin is a "Guanylate Cyclase Activator"
        (N0000185499) -- near-identical names, different concepts. Matching
        on class *id* rather than class *name* is what keeps that from
        being a coincidental hit.
        """
        vard_ci = {c["class_id"] for c in SEED["vardenafil"]["contraindicated_classes"]}
        nitro_is = {c["class_id"] for c in SEED["nitroglycerin"]["classes"]}
        self.assertEqual(vard_ci & nitro_is, set(),
                         "vardenafil's own data is expected NOT to cover this pair")
        self.assertEqual(len(drugs_mod.check_interactions(["vardenafil", "nitroglycerin"])), 1)


class TestClassRulesDoNotOverfire(unittest.TestCase):
    def setUp(self):
        use_table(SEED)

    def test_same_drug_named_two_ways_is_not_an_interaction(self):
        self.assertEqual(drugs_mod.check_interactions(["epi", "epinephrine"]), [])
        self.assertEqual(drugs_mod.check_interactions(["nitro", "nitroglycerin"]), [])

    def test_one_flag_per_pair(self):
        flags = drugs_mod.check_interactions(["nitroglycerin", "vardenafil", "naloxone"])
        self.assertEqual(len(flags), 1)

    def test_unrelated_drugs_stay_clear(self):
        self.assertEqual(drugs_mod.check_interactions(["naloxone", "albuterol"]), [])
        self.assertEqual(drugs_mod.check_interactions(["aspirin", "vardenafil"]), [])

    def test_does_not_fire_on_a_shared_indication(self):
        """Sildenafil and nitroglycerin both treat pulmonary hypertension,
        and both are vasodilators. Only the MoA contraindication should
        matter -- not overlap in what they're for."""
        self.assertEqual(
            only_flag(["nitroglycerin", "sildenafil"])["basis"], "curated_pair")

    def test_a_drug_in_a_merely_related_class_does_not_flag(self):
        """ATC groups alprostadil with the PDE5 inhibitors under "drugs used
        in erectile dysfunction"; MoA does not, which is why the refresh
        only keeps MoA and EPC. Fixture mirrors real RxClass output."""
        fixture = {
            "nitroglycerin": SEED["nitroglycerin"],
            "alprostadil": {
                "drug_name": "alprostadil",
                "contraindicated_with": [],
                "classes": [
                    {"class_id": "N0000000106",
                     "class_name": "Prostaglandin Receptor Agonists",
                     "class_type": "MOA"},
                    {"class_id": "N0000175454",
                     "class_name": "Prostaglandin Analog", "class_type": "EPC"},
                ],
                "contraindicated_classes": [],
            },
        }
        use_table(fixture)
        self.assertEqual(drugs_mod.check_interactions(["nitroglycerin", "alprostadil"]), [])

    def test_records_without_class_data_still_work(self):
        """Backward compatibility: a drug table seeded before
        --refresh-classes existed has neither key."""
        legacy = {
            "nitroglycerin": {"drug_name": "nitroglycerin",
                              "contraindicated_with": ["sildenafil"],
                              "interaction_notes": {"sildenafil": "Hypotension."}},
            "sildenafil": {"drug_name": "sildenafil", "contraindicated_with": []},
            "vardenafil": {"drug_name": "vardenafil", "contraindicated_with": []},
        }
        use_table(legacy)
        self.assertEqual(only_flag(["nitroglycerin", "sildenafil"])["note"], "Hypotension.")
        self.assertEqual(drugs_mod.check_interactions(["nitroglycerin", "vardenafil"]), [])

    def test_malformed_class_entries_are_skipped_not_fatal(self):
        junk = {
            "a": {"drug_name": "a", "contraindicated_with": [],
                  "contraindicated_classes": [None, "notadict", {}, {"class_name": "no id"}]},
            "b": {"drug_name": "b", "contraindicated_with": [],
                  "classes": [{"class_id": "X1", "class_name": "X"}]},
        }
        use_table(junk)
        self.assertEqual(drugs_mod.check_interactions(["a", "b"]), [])


class TestRxClassParsing(unittest.TestCase):
    """`byRxcui` mixes membership and contraindication rows and ignores the
    `rela` query parameter, so filtering happens client-side or not at all.

    Rows below are trimmed from real nitroglycerin/sildenafil responses.
    """

    NITRO_ROWS = [
        {"rela": "has_moa", "rxclassMinConceptItem": {
            "classId": "N0000000120", "className": "Nitric Oxide Donors", "classType": "MOA"}},
        {"rela": "has_epc", "rxclassMinConceptItem": {
            "classId": "N0000175415", "className": "Nitrate Vasodilator", "classType": "EPC"}},
        {"rela": "ci_moa", "rxclassMinConceptItem": {
            "classId": "N0000020026", "className": "Phosphodiesterase 5 Inhibitors",
            "classType": "MOA"}},
        {"rela": "may_treat", "rxclassMinConceptItem": {
            "classId": "D000787", "className": "Angina Pectoris", "classType": "DISEASE"}},
        {"rela": "has_pe", "rxclassMinConceptItem": {
            "classId": "N0000009911", "className": "Venous Vasodilation", "classType": "PE"}},
        {"rela": "ci_chemclass", "rxclassMinConceptItem": {
            "classId": "D011743", "className": "Pyrimidines", "classType": "CHEM"}},
        {"rela": "has_moa", "rxclassMinConceptItem": {
            "classId": "G04BE", "className": "Drugs used in erectile dysfunction",
            "classType": "ATC1-4"}},
    ]

    def test_splits_membership_from_contraindication(self):
        member, contra = rxclass.parse_class_rows(self.NITRO_ROWS)
        self.assertEqual([c["class_id"] for c in member],
                         ["N0000000120", "N0000175415"])
        self.assertEqual([c["class_id"] for c in contra], ["N0000020026"])

    def test_the_self_match_trap(self):
        """Without `rela` filtering, nitroglycerin lands in the PDE5 class
        it is merely contraindicated with -- and a nitrate x PDE5 rule then
        matches nitroglycerin against itself."""
        member, _ = rxclass.parse_class_rows(self.NITRO_ROWS)
        self.assertNotIn("N0000020026", [c["class_id"] for c in member])

    def test_drops_class_types_that_are_not_mechanisms(self):
        member, contra = rxclass.parse_class_rows(self.NITRO_ROWS)
        kept = [c["class_type"] for c in member + contra]
        self.assertTrue(set(kept) <= {"MOA", "EPC"}, kept)

    def test_drops_atc_even_on_a_membership_relation(self):
        # ATC's G04BE sweeps in alprostadil; see the module docstring.
        member, _ = rxclass.parse_class_rows(self.NITRO_ROWS)
        self.assertNotIn("G04BE", [c["class_id"] for c in member])

    def test_output_is_sorted_for_stable_diffs(self):
        shuffled = list(reversed(self.NITRO_ROWS))
        self.assertEqual(rxclass.parse_class_rows(shuffled),
                         rxclass.parse_class_rows(self.NITRO_ROWS))

    def test_empty_and_missing_input(self):
        self.assertEqual(rxclass.parse_class_rows([]), ([], []))
        self.assertEqual(rxclass.parse_class_rows(None), ([], []))

    def test_unknown_rela_is_ignored_rather_than_guessed(self):
        rows = [{"rela": "something_new", "rxclassMinConceptItem": {
            "classId": "N1", "className": "X", "classType": "MOA"}}]
        self.assertEqual(rxclass.parse_class_rows(rows), ([], []))


class TestSeedClassData(unittest.TestCase):
    def test_refresh_did_not_touch_curated_pairs(self):
        self.assertEqual(SEED["nitroglycerin"]["contraindicated_with"],
                         ["sildenafil", "tadalafil"])
        self.assertEqual(SEED["epinephrine"]["contraindicated_with"],
                         ["propranolol", "phenelzine"])

    def test_new_pde5_records_carry_no_hand_written_pairs(self):
        """They are the demonstration that the class rule stands alone."""
        for drug in ("vardenafil", "avanafil", "tadalafil"):
            with self.subTest(drug):
                self.assertEqual(SEED[drug]["contraindicated_with"], [])
                self.assertTrue(SEED[drug]["classes"])

    def test_alias_rows_have_no_class_data(self):
        for row in SEED.values():
            if row.get("alias_of"):
                with self.subTest(row["drug_name"]):
                    self.assertNotIn("classes", row)

    def test_every_non_alias_record_is_labelled_demo_data(self):
        for row in SEED.values():
            with self.subTest(row["drug_name"]):
                self.assertIn("SEED/DEMO", row.get("notes", ""))


if __name__ == "__main__":
    unittest.main(verbosity=2)
