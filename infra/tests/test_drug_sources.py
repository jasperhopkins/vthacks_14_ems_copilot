#!/usr/bin/env python3
"""
Offline checks for the two contraindication sources added on top of the
curated pairs -- no network, no AWS, no PDF:

    python3 infra/tests/test_drug_sources.py

  - `seed/openfda.py`   -- mining FDA labelling for contraindications
  - `seed/ingest_nasemso_meds.py` -- the NASEMSO Appendix III formulary
  - the layered merge in `common/drugs.py`

Every fixture here is text that actually appeared in a real FDA label or
the real appendix, and every one of them produced a *wrong clinical flag*
before the guard it now tests. That is the whole point of pinning them: a
false contraindication is not a cosmetic bug. "Do not give Entonox to this
patient" is a withheld analgesic.
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

import openfda  # noqa: E402
import ingest_nasemso_meds as meds  # noqa: E402

SEED = {d["drug_name"]: d
        for d in json.loads((ROOT / "seed" / "drug_reference_seed.json").read_text())}


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


def flags(names):
    return drugs_mod.check_interactions(names)


class TestLabelSelection(unittest.TestCase):
    """openFDA returns whatever mentions the ingredient, including products
    that merely contain it."""

    def _label(self, generics, ci="Do not use with widgets.", **extra):
        return {"openfda": {"generic_name": generics}, "contraindications": [ci], **extra}

    def test_rejects_combination_products(self):
        # Searching "naloxone" really does return pentazocine/naloxone and
        # buprenorphine/naloxone first; their contraindications are the
        # combination's, not naloxone's.
        results = [self._label(["PENTAZOCINE HYDROCHLORIDE AND NALOXONE HYDROCHLORIDE"]),
                   self._label(["BUPRENORPHINE", "NALOXONE"])]
        self.assertIsNone(openfda.select_label("naloxone", results))

    def test_accepts_a_salt_suffixed_name(self):
        picked = openfda.select_label(
            "propranolol", [self._label(["PROPRANOLOL HYDROCHLORIDE"])])
        self.assertIsNotNone(picked)

    def test_rejects_a_product_that_merely_contains_the_ingredient(self):
        # The second "nitroglycerin" hit is a homeopathic remedy.
        results = [self._label(["GOLD TRICHLORIDE, SOLANUM DULCAMARA, NITROGLYCERIN"])]
        self.assertIsNone(openfda.select_label("nitroglycerin", results))

    def test_rejects_labels_with_no_contraindications_section(self):
        # All 719 OTC aspirin labels look like this.
        self.assertIsNone(openfda.select_label(
            "aspirin", [{"openfda": {"generic_name": ["ASPIRIN"]}}]))

    def test_prefers_the_richest_label_not_the_first(self):
        thin = self._label(["WIDGETOL"], ci="None.")
        rich = self._label(["WIDGETOL"], ci="Do not use with nitrates in any form.")
        picked = openfda.select_label("widgetol", [thin, rich])
        self.assertIn("nitrates", picked[2]["contraindications"])


class TestCoAdministrationGate(unittest.TestCase):
    """A contraindications section names co-administered drugs, patient
    history and the drug's own ingredients. Only the first is a drug-drug
    rule, and naming a drug is not enough to tell them apart."""

    def _q(self, text, target):
        return openfda.qualifies(text, text.lower().find(target))

    def test_rejects_a_diluent_allergy_note(self):
        # Produced "dopamine + dextrose".
        self.assertFalse(self._q(
            "Solutions containing dextrose may be contraindicated in patients "
            "with known allergy to corn or corn products.", "dextrose"))

    def test_rejects_a_patient_history_contraindication(self):
        # Produced "ibuprofen + aspirin". This is about who the patient is,
        # not about what else is going in the line.
        self.assertFalse(self._q(
            "Ibuprofen tablets should not be given to patients who have experienced "
            "asthma, urticaria, or allergic-type reactions after taking aspirin.", "aspirin"))

    def test_rejects_a_sentence_whose_real_subject_is_another_drug(self):
        # Produced "norepinephrine + epinephrine"; the culprit is halothane.
        self.assertFalse(self._q(
            "Cyclopropane and halothane anesthetics increase cardiac autonomic "
            "irritability and therefore seem to sensitize the myocardium to the "
            "action of intravenously administered epinephrine or norepinephrine.",
            "epinephrine"))

    def test_rejects_an_explicitly_negative_finding(self):
        self.assertFalse(self._q(
            "Vardenafil did not potentiate the increase in bleeding time caused "
            "by aspirin.", "aspirin"))

    def test_accepts_concomitant_use(self):
        self.assertTrue(self._q(
            "Severe hypotension and seizures have been reported following rapid IV "
            "administration, particularly with concomitant use of fentanyl.", "fentanyl"))

    def test_accepts_a_do_not_give_with_list(self):
        self.assertTrue(self._q(
            "Therefore, ziprasidone should not be given with: dofetilide, sotalol, "
            "quinidine, chlorpromazine, droperidol, pimozide.", "droperidol"))

    def test_accepts_patients_using_phrasing(self):
        self.assertTrue(self._q(
            "Administration of sildenafil tablets to patients using nitric oxide "
            "donors, such as organic nitrates or organic nitrites in any form.",
            "nitric oxide"))

    def test_a_separate_sentence_does_not_disqualify_the_mention(self):
        """Exercises splitting and gating together, which is how they run.

        The ziprasidone contraindications read "should not be given with:
        ... droperidol ..." and then, as a *separate* sentence, mention
        hypersensitivity. Checking cues against the un-split text dropped a
        real QT interaction between two drugs EMS both carry.
        """
        text = ("Therefore, ziprasidone should not be given with: dofetilide, "
                "sotalol, quinidine, chlorpromazine, droperidol, pimozide, "
                "sparfloxacin. Known hypersensitivity to ziprasidone.")
        kept = [f for f in openfda.fragments(text)
                if "droperidol" in f.lower()
                and openfda.qualifies(f, f.lower().find("droperidol"))]
        self.assertTrue(kept, "the co-administration bullet was discarded")

    def test_a_distant_history_cue_does_not_reject(self):
        head = "Do not give with droperidol. "
        filler = "Additional prescribing information follows in this section. " * 4
        self.assertTrue(self._q(head + filler + "History of hypersensitivity.",
                                "droperidol"))


class TestSelfMatching(unittest.TestCase):
    def test_a_drug_is_not_contraindicated_with_its_own_class(self):
        """Propranolol's label says "beta-blocker", sildenafil's says "PDE5
        inhibitor", nitroglycerin's says "other nitrates"."""
        # Production passes every class name on the record; propranolol
        # carries both the MoA and the EPC spelling of the same idea, and
        # the label phrase "beta-blocker" maps to both.
        found = openfda.find_targets(
            "Do not use with other beta-blockers.", "propranolol",
            {"beta-Adrenergic Blocker", "Adrenergic beta-Antagonists"}, {})
        self.assertEqual(found, [])

    def test_real_seed_records_carry_every_spelling_of_their_own_class(self):
        """The self-match guard is only as good as the class list it is
        given -- a record holding one spelling and not the other would flag
        itself through the spelling it is missing."""
        both = {"beta-Adrenergic Blocker", "Adrenergic beta-Antagonists"}
        for name in ("propranolol", "labetalol", "metoprolol"):
            with self.subTest(name):
                names = {c["class_name"] for c in SEED[name]["classes"]}
                self.assertTrue(both <= names, f"{name} has only {names & both}")

    def test_the_same_phrase_matches_for_a_drug_outside_that_class(self):
        found = openfda.find_targets(
            "Do not use with other beta-blockers.", "albuterol", set(), {})
        self.assertIn("class", [k for k, _, _ in found])


class TestLayeredMerge(unittest.TestCase):
    """Four sources, highest authority first, none allowed to delete
    another's flags."""

    def setUp(self):
        use_table(SEED)

    def test_curated_pair_still_wins(self):
        flag = flags(["epinephrine", "propranolol"])[0]
        self.assertEqual(flag["basis"], "curated_pair")
        self.assertIn("alpha", flag["note"].lower())

    def test_curated_class_rule_covers_a_whole_mechanism(self):
        # One hand-written rule, and labetalol -- which no list names --
        # flags on the same unopposed-alpha mechanism as propranolol.
        flag = flags(["epinephrine", "labetalol"])[0]
        self.assertEqual(flag["basis"], "curated_class")
        self.assertIn("NON-SELECTIVE", flag["note"])

    def test_beta1_selective_agents_do_not_fire_that_rule(self):
        """Keyed on the beta-2 antagonist class on purpose. Metoprolol is
        beta-1 selective and does not carry the unopposed-alpha risk;
        flagging it would be over-warning, which costs a real drug."""
        self.assertEqual(flags(["epinephrine", "metoprolol"]), [])

    def test_fda_label_supplies_the_reciprocal_direction(self):
        """RxClass records nitrate/PDE5 on nitroglycerin's side only, so
        sildenafil's own record is empty and amyl nitrite -- a nitrate the
        formulary carries -- flagged against nothing until labelling filled
        the other direction."""
        flag = flags(["amyl nitrite", "sildenafil"])[0]
        self.assertEqual(flag["basis"], "fda_label")

    def test_label_flag_quotes_the_label_and_links_the_source(self):
        flag = flags(["amyl nitrite", "sildenafil"])[0]
        self.assertIn("FDA labelling", flag["note"])
        self.assertIn("nitric oxide donors", flag["note"].lower())
        self.assertTrue(str(flag.get("source_url", "")).startswith("https://dailymed"))

    def test_a_qt_interaction_between_two_carried_drugs(self):
        self.assertEqual(flags(["ziprasidone", "droperidol"])[0]["basis"], "fda_label")

    def test_one_flag_per_pair_across_all_four_layers(self):
        self.assertEqual(len(flags(["nitroglycerin", "sildenafil", "naloxone"])), 1)


class TestClassExclusions(unittest.TestCase):
    """A reviewed override of a derived classification."""

    def setUp(self):
        use_table(SEED)

    def test_nitrous_oxide_does_not_flag_against_pde5_inhibitors(self):
        """RxClass files N2O under the MoA "Nitric Oxide Donors" -- true of
        the chemistry, false of the clinical rule. Without the exclusion
        every PDE5 inhibitor's labelling told a medic to withhold Entonox
        from a patient who took Viagra."""
        for other in ("sildenafil", "tadalafil", "vardenafil", "avanafil", "viagra"):
            with self.subTest(other):
                self.assertEqual(flags(["nitrous oxide", other]), [])

    def test_the_exclusion_is_recorded_with_its_reason(self):
        n2o = SEED["nitrous oxide"]
        self.assertIn("Nitric Oxide Donors", n2o["class_exclusions"])
        self.assertIn("anaesthetic", n2o["class_exclusion_note"])

    def test_amyl_nitrite_keeps_the_same_class_and_still_flags(self):
        """The exclusion must be per-drug. Amyl nitrite is an organic
        nitrite, genuinely carries the interaction, and "Nitric Oxide
        Donors" is the only class RxClass gives it -- dropping the class
        outright would lose a real contraindication."""
        self.assertEqual(
            [c["class_name"] for c in SEED["amyl nitrite"]["classes"]],
            ["Nitric Oxide Donors"])
        self.assertTrue(flags(["amyl nitrite", "sildenafil"]))

    def test_class_names_helper_applies_exclusions(self):
        rec = {"classes": [{"class_id": "C1", "class_name": "Keep"},
                           {"class_id": "C2", "class_name": "Drop"}],
               "class_exclusions": ["Drop"]}
        self.assertEqual(drugs_mod.class_names(rec), {"Keep"})


class TestFormularyParsing(unittest.TestCase):
    APPENDIX = [
        "Metoprolol",
        "Name — Lopressor®, Toprol XL®",
        "Class — Beta blocker, beta-1 selective",
        "Pharmacologic Action—Selectively blocks beta-1 receptors",
        "Indications — Hypertension, angina, myocardial infarction",
        "Contraindications — Hypersensitivity, severe bradycardia, cardiogenic shock",
        "Acetaminophen",
        "Name — There are multiple over-the-counter medications that include "
        "acetaminophen (Tylenol®) as an active ingredient",
        "Class — Analgesics, antipyretic, other",
        "Contraindications—Hypersensitivity, severe acute liver disease",
    ]

    def test_splits_entries_and_fields(self):
        entries = meds.parse_entries(self.APPENDIX)
        self.assertEqual([e["name"] for e in entries], ["Metoprolol", "Acetaminophen"])
        rec = meds.build_record(entries[0])
        self.assertEqual(rec["drug_name"], "metoprolol")
        self.assertEqual(rec["class"], "Beta blocker, beta-1 selective")
        self.assertIn("cardiogenic shock", rec["contraindications_text"])

    def test_handles_every_dash_and_spacing_variant(self):
        # The appendix uses em dash, en dash and hyphen, spaced and not.
        for dash in ("—", "–", "-"):
            for gap in ("", " "):
                with self.subTest(dash=dash, gap=gap):
                    lines = ["Widgetol", f"Name{gap}{dash}{gap}Widgey®",
                             f"Contraindications{gap}{dash}{gap}Hypersensitivity"]
                    entries = meds.parse_entries(lines)
                    self.assertEqual(len(entries), 1)
                    self.assertEqual(
                        meds.build_record(entries[0])["contraindications_text"],
                        "Hypersensitivity")

    def test_trade_names_become_aliases(self):
        rec = meds.build_record(meds.parse_entries(self.APPENDIX)[0])
        self.assertEqual(rec["trade_names"], ["lopressor", "toprol xl"])

    def test_prose_name_fields_do_not_become_aliases(self):
        """"There are multiple over-the-counter medications that include..."
        is a sentence, not a brand list."""
        rec = meds.build_record(meds.parse_entries(self.APPENDIX)[1])
        self.assertEqual(rec["trade_names"], [])

    def test_merge_never_overwrites_curated_clinical_fields(self):
        existing = [{
            "drug_name": "metoprolol",
            "contraindicated_with": ["epinephrine"],
            "interaction_notes": {"epinephrine": "Hand written."},
            "adult_dose": "5 mg IV", "pediatric_dose": "N/A",
            "classes": [{"class_id": "C1", "class_name": "Widgets"}],
        }]
        extracted = [meds.build_record(meds.parse_entries(self.APPENDIX)[0])]
        merged, stats = meds.merge(existing, extracted)
        rec = next(r for r in merged if r["drug_name"] == "metoprolol")
        self.assertEqual(rec["contraindicated_with"], ["epinephrine"])
        self.assertEqual(rec["interaction_notes"], {"epinephrine": "Hand written."})
        self.assertEqual(rec["adult_dose"], "5 mg IV")
        self.assertEqual(rec["classes"], [{"class_id": "C1", "class_name": "Widgets"}])
        # ...while still gaining the appendix's own fields.
        self.assertIn("cardiogenic shock", rec["contraindications_text"])
        self.assertEqual(stats["updated"], 1)

    def test_merge_does_not_clobber_an_alias_row(self):
        existing = [{"drug_name": "lopressor", "alias_of": "metoprolol"}]
        extracted = [meds.build_record(meds.parse_entries(self.APPENDIX)[0])]
        merged, _ = meds.merge(existing, extracted)
        row = next(r for r in merged if r["drug_name"] == "lopressor")
        self.assertEqual(row["alias_of"], "metoprolol")


class TestSeedIntegrity(unittest.TestCase):
    def test_formulary_size(self):
        real = [d for d in SEED.values() if not d.get("alias_of")]
        self.assertGreaterEqual(len(real), 60)

    def test_label_rows_all_carry_evidence_and_a_citation(self):
        for name, rec in SEED.items():
            for row in rec.get("label_contraindications", []):
                with self.subTest(drug=name, target=row.get("target")):
                    self.assertTrue(row.get("evidence"))
                    self.assertTrue(row.get("set_id"))
                    self.assertIn(row["kind"], ("drug", "class"))
                    self.assertIn(row["section"], ("contraindications", "boxed_warning"))

    def test_label_evidence_mentions_what_it_claims(self):
        """A citation that doesn't contain the thing it's cited for is worse
        than no citation."""
        for name, rec in SEED.items():
            for row in rec.get("label_contraindications", []):
                if row["kind"] != "drug":
                    continue
                with self.subTest(drug=name, target=row["target"]):
                    spellings = [row["target"]] + [
                        d["drug_name"] for d in SEED.values()
                        if d.get("alias_of") == row["target"]]
                    self.assertTrue(
                        any(s.lower() in row["evidence"].lower() for s in spellings),
                        f"evidence does not name {row['target']}")

    def test_no_drug_is_contraindicated_with_itself(self):
        for name, rec in SEED.items():
            if rec.get("alias_of"):
                continue
            for row in rec.get("label_contraindications", []):
                with self.subTest(drug=name):
                    self.assertNotEqual(row.get("target"), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
