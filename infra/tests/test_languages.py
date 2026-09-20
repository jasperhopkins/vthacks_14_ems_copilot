"""
Offline checks on the translator's language table.

These are shape and consistency checks, not capability checks -- whether
AWS actually supports a code is something only AWS can answer, and the
answers that produced this table are recorded in common/languages.py:

  * every `transcribe_code` opened a real Transcribe streaming websocket
    with identify-language on (cmn-CN, Polly's spelling for Mandarin, is
    rejected there; zh-CN is the Transcribe one),
  * every voice/engine/language triple ran through synthesize_speech,
  * every language round-tripped en -> L -> en through Translate, and
  * a sentence in each language was detected correctly by Comprehend at
    0.86 or better -- which is where LOW_CONFIDENCE (0.70) comes from.

What can silently rot is the table's internal consistency: a row added
with a Polly voice but no engine, a detection alias pointing at a language
that is not in the table, or the app and the handler disagreeing about
what a row contains. That is what these cover.
"""
import os
import sys
import unittest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "layers", "common", "python"),
)

from common.languages import (  # noqa: E402
    BY_CODE,
    DETECTION_ALIASES,
    LANGUAGES,
    SUPPORTED_CODES,
    catalog,
    is_supported,
    normalize_detected,
    voice_for,
)


class TestTable(unittest.TestCase):
    def test_codes_are_unique(self):
        codes = [row[0] for row in LANGUAGES]
        self.assertEqual(len(codes), len(set(codes)))

    def test_transcribe_locales_are_unique(self):
        # Two rows sharing a locale would make the identification result
        # ambiguous: "es-US" could not be mapped back to one language.
        locales = [row[3] for row in LANGUAGES]
        self.assertEqual(len(locales), len(set(locales)))

    def test_english_is_present(self):
        # Both directions pivot through English; without this row the
        # patient-speaks direction has no target.
        self.assertIn("en", SUPPORTED_CODES)

    def test_transcribe_codes_are_locales(self):
        for code, *_rest in LANGUAGES:
            locale = BY_CODE[code]["transcribe_code"]
            self.assertRegex(
                locale, r"^[a-z]{2}-[A-Z]{2}$", f"{code} has a non-locale {locale!r}"
            )

    def test_a_voice_implies_an_engine(self):
        # synthesize_speech is called with Engine always set; a row with a
        # voice and no engine would pass None and fail at the API.
        for code in SUPPORTED_CODES:
            row = BY_CODE[code]
            if row["polly_voice"]:
                self.assertIn(row["polly_engine"], ("neural", "standard"), code)
            else:
                self.assertIsNone(row["polly_engine"], code)

    def test_voice_for_returns_a_complete_triple(self):
        voice_id, engine, polly_lang = voice_for("ar")
        self.assertEqual(voice_id, "Hala")
        self.assertEqual(engine, "neural")
        # Hala is an ar-AE voice; the Arabic that Translate produces is
        # MSA, so the synth call has to name arb explicitly.
        self.assertEqual(polly_lang, "arb")

    def test_languages_without_a_voice_are_explicit(self):
        # Not a gap: Polly has no voice for these at all. They must return
        # None rather than fall back to some other language's voice.
        for code in ("vi", "tl", "ht"):
            self.assertIsNone(voice_for(code), f"{code} should be text-only")

    def test_somali_is_excluded(self):
        # Excluded deliberately -- the round trip moved chest pain to the
        # ankle. Re-measure before re-adding; see the module docstring.
        self.assertNotIn("so", SUPPORTED_CODES)


class TestDetection(unittest.TestCase):
    def test_aliases_resolve_into_the_table(self):
        for variant, target in DETECTION_ALIASES.items():
            self.assertIn(target, SUPPORTED_CODES, f"{variant} -> {target} is not a row")

    def test_aliases_do_not_shadow_real_rows(self):
        for variant in DETECTION_ALIASES:
            self.assertNotIn(variant, SUPPORTED_CODES)

    def test_normalize_passes_unknown_codes_through(self):
        # An unsupported detection has to stay nameable, so the handler can
        # say which language it heard rather than just refusing.
        self.assertEqual(normalize_detected("hu"), "hu")
        self.assertFalse(is_supported("hu"))

    def test_regional_variants_fold_onto_their_language(self):
        self.assertEqual(normalize_detected("zh-TW"), "zh")
        self.assertEqual(normalize_detected("pt-PT"), "pt")


class TestCatalog(unittest.TestCase):
    def test_catalog_carries_what_the_app_renders(self):
        # The app builds its language pills and its Transcribe
        # language-options list from exactly these keys.
        for row in catalog():
            self.assertEqual(
                set(row), {"code", "label", "endonym", "transcribe_code", "can_speak"}
            )

    def test_catalog_covers_every_row(self):
        self.assertEqual({r["code"] for r in catalog()}, set(SUPPORTED_CODES))

    def test_can_speak_matches_voice_for(self):
        for row in catalog():
            self.assertEqual(row["can_speak"], voice_for(row["code"]) is not None)

    def test_labels_and_endonyms_are_non_empty(self):
        for row in catalog():
            self.assertTrue(row["label"].strip())
            self.assertTrue(row["endonym"].strip())


if __name__ == "__main__":
    unittest.main(verbosity=2)
