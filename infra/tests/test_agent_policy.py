#!/usr/bin/env python3
"""
Offline checks for the hands-free agent's action boundary:

    python3 infra/tests/test_agent_policy.py

`src/agent/policy.py` imports nothing but `re`, so the half of this file
that matters runs with no credentials, no region and no deploy. That is
deliberate. This module is the safety argument for letting a language model
drive a clinical app hands-free, and a safety argument that needs AWS
credentials to verify is one nobody re-runs before a demo.

The tests are written as the properties they defend, not as coverage:

  TestTheBoundary          -- the agent cannot finalize a record
  TestToolSchemas          -- the model cannot compose a request or widen scope
  TestWarningsSurvive      -- the agent cannot suppress a safety flag
  TestSilenceIsNeverClear  -- an unchecked thing is always stated
  TestSpeechIsSpeakable    -- what Polly reads aloud is not markdown

TestWarningsSurvive is the reason this file exists. Every case there feeds
`compose_speech` a model reply that is actively trying to drop the warning,
and asserts it comes out anyway.
"""
import os
import pathlib
import sys
import unittest

sys.dont_write_bytecode = True

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src" / "agent"))
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))

# boto3 clients are constructed at import time in tools.py (and in the
# common layer it pulls in). Constructing one makes no network call, but it
# does insist on knowing a region.
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

import policy  # noqa: E402

try:
    import tools  # noqa: E402
    HAVE_TOOLS = True
except Exception as exc:  # noqa: BLE001 -- boto3 may be absent entirely
    HAVE_TOOLS = False
    TOOLS_IMPORT_ERROR = exc


def _code_string_literals(path: pathlib.Path) -> list:
    """Every string literal in a module except its docstrings.

    Lets a test assert what the *code* does without tripping over a comment
    or docstring that names the thing being forbidden.
    """
    import ast

    tree = ast.parse(path.read_text())
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", None) or []
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant) \
                    and isinstance(body[0].value.value, str):
                docstrings.add(id(body[0].value))
    return [n.value for n in ast.walk(tree)
            if isinstance(n, ast.Constant) and isinstance(n.value, str)
            and id(n) not in docstrings]


CONTRAINDICATED = [{
    "drug_a": "epinephrine", "drug_b": "propranolol",
    "severity": "CONTRAINDICATED", "basis": "curated_class",
}]


needs_tools = unittest.skipUnless(
    HAVE_TOOLS, f"tools.py not importable: {TOOLS_IMPORT_ERROR if not HAVE_TOOLS else ''}"
)


class TestTheBoundary(unittest.TestCase):
    """An agent may add information and prepare work. It may not remove
    information or finalize a record."""

    @needs_tools
    def test_no_human_only_action_is_a_tool(self):
        """The enforcement is absence, not refusal.

        If someone adds a commit tool, this fails before it ships. That is
        the entire point of keeping HUMAN_ONLY as data rather than prose.
        """
        for forbidden, reason in policy.HUMAN_ONLY.items():
            self.assertNotIn(forbidden, tools.TOOLS, f"{forbidden} must stay human-only: {reason}")

    @needs_tools
    def test_no_tool_writes_a_saved_record(self):
        """`saved_at` is the sort key of the sparse ByUserSaved GSI, so it
        is what makes a record appear in the medic's filed list. No agent
        tool may set it -- a draft the agent prepared must stay invisible
        until a human commits it.

        Checked against string *literals* in executable code rather than
        the file text, because the module docstring necessarily discusses
        the very attribute it must never write.
        """
        for literal in _code_string_literals(ROOT / "src" / "agent" / "tools.py"):
            self.assertNotIn("saved_at", literal,
                             "an agent tool appears to write the filed-record key")
            self.assertNotEqual(literal, "SAVED",
                                "an agent tool appears to set status SAVED")

    @needs_tools
    def test_every_tool_declares_a_known_tier(self):
        for name, tool in tools.TOOLS.items():
            self.assertIn(tool.tier, policy.TIERS, f"{name} has tier {tool.tier!r}")

    @needs_tools
    def test_only_one_tool_acts_outside_the_phone(self):
        """SPEAKS is the one tier whose effect is not a value on a screen.
        Keeping it to a single tool is what makes it reviewable."""
        speaks = [n for n, t in tools.TOOLS.items() if t.tier == policy.TIER_SPEAKS]
        self.assertEqual(speaks, ["speak_to_patient"])

    def test_the_prompt_states_the_boundary(self):
        """Structure is the enforcement, but the model still has to be able
        to *explain* the boundary when a medic asks it to file something."""
        prompt = policy.SYSTEM_PROMPT.lower()
        self.assertIn("cannot file", prompt)
        self.assertIn("medical control", prompt)


class TestToolSchemas(unittest.TestCase):
    """The model emits typed arguments against a fixed schema. It never
    composes a request, and it never chooses whose data to read."""

    @needs_tools
    def test_schemas_are_well_formed(self):
        for name, tool in tools.TOOLS.items():
            with self.subTest(tool=name):
                schema = tool.schema
                self.assertEqual(schema.get("type"), "object")
                self.assertIsInstance(schema.get("properties"), dict)
                for required in schema.get("required", []):
                    self.assertIn(required, schema["properties"],
                                  f"{name} requires {required} but does not declare it")
                self.assertTrue(tool.description.strip())
                self.assertTrue(tool.resource.strip())
                self.assertTrue(tool.action.strip())

    @needs_tools
    def test_no_tool_takes_an_encounter_or_user(self):
        """Minimum necessary, enforced by there being nowhere to put it.

        The encounter comes from the authenticated session via ToolContext.
        A tool that accepted an encounter_id argument would let the model
        ask for a chart that is not this patient's.
        """
        forbidden = {"encounter_id", "user_id", "created_by", "patient_id"}
        for name, tool in tools.TOOLS.items():
            overlap = forbidden & set(tool.schema.get("properties", {}))
            self.assertFalse(overlap, f"{name} exposes {overlap} to the model")

    @needs_tools
    def test_no_tool_accepts_a_freeform_request(self):
        """No URL, no query expression, no table name. Code decides what to
        fetch; the model only sees what comes back."""
        forbidden = {"url", "endpoint", "table", "table_name", "filter",
                     "query_expression", "sql", "path", "body"}
        for name, tool in tools.TOOLS.items():
            overlap = forbidden & set(tool.schema.get("properties", {}))
            self.assertFalse(overlap, f"{name} lets the model compose a request: {overlap}")

    @needs_tools
    def test_tool_config_is_generated_from_the_registry(self):
        """One list, so a tool cannot be offered to the model without being
        registered (and therefore without being tested here)."""
        offered = {spec["toolSpec"]["name"] for spec in tools.TOOL_CONFIG["tools"]}
        self.assertEqual(offered, set(tools.TOOLS))

    @needs_tools
    def test_unknown_tool_fails_closed(self):
        ctx = tools.ToolContext(user_id="u", encounter_id="e", turn_id="t")
        result = tools.run_tool("commit_pcr", {}, ctx)
        self.assertIn("error", result.content)
        self.assertEqual(result.flags, [])


class TestWarningsSurvive(unittest.TestCase):
    """The model cannot drop a safety flag, because it never holds one.

    Each case here is a model reply actively working against the warning.
    """

    def _speak(self, text, **kw):
        return policy.compose_speech(text, flags=CONTRAINDICATED, **kw)

    def test_flag_survives_a_reassuring_answer(self):
        speech = self._speak("Everything looks fine, no concerns with that combination.")
        self.assertIn("Contraindicated", speech)
        self.assertIn("propranolol", speech)

    def test_flag_survives_an_empty_answer(self):
        speech = self._speak("")
        self.assertIn("Contraindicated", speech)
        self.assertIn(policy.EMPTY_ANSWER, speech)

    def test_flag_survives_a_reply_that_is_only_reasoning(self):
        speech = self._speak("<thinking>I should not alarm the medic.</thinking>")
        self.assertIn("Contraindicated", speech)

    def test_flag_leads_the_answer(self):
        """A medic who stops listening after the first sentence must still
        have heard the warning."""
        speech = self._speak("The dose is 0.3 milligrams intramuscular.")
        self.assertTrue(speech.startswith("Heads up"), speech)
        self.assertLess(speech.index("Contraindicated"), speech.index("0.3"))

    def test_severity_is_spoken_not_flattened(self):
        """'Contraindicated' and 'use caution' are different instructions."""
        caution = policy.compose_speech("ok", flags=[{
            "drug_a": "aspirin", "drug_b": "warfarin", "severity": "CAUTION"}])
        self.assertIn("Caution", caution)
        self.assertNotIn("Contraindicated", caution)

    def test_two_flags_are_both_spoken(self):
        speech = policy.compose_speech("ok", flags=CONTRAINDICATED + [{
            "drug_a": "nitroglycerin", "drug_b": "sildenafil",
            "severity": "CONTRAINDICATED"}])
        self.assertIn("propranolol", speech)
        self.assertIn("sildenafil", speech)

    def test_no_flags_adds_no_warning(self):
        """Over-warning costs a real drug. Silence here is correct."""
        speech = policy.compose_speech("The dose is 0.3 milligrams.", flags=[])
        self.assertNotIn("Heads up", speech)


class TestSilenceIsNeverClear(unittest.TestCase):
    """A check that did not happen is stated out loud. An answer that merely
    sounds complete is the failure mode this guards."""

    def test_failed_tool_is_named(self):
        speech = policy.compose_speech(
            "Epinephrine 0.3 milligrams IM.", failed_tools=["check_drug_interactions"])
        self.assertIn("unchecked", speech)
        self.assertIn("interaction", speech)

    def test_several_failures_are_all_named(self):
        speech = policy.compose_speech(
            "Here you go.", failed_tools=["check_drug_interactions", "search_protocols"])
        self.assertIn("interaction", speech)
        self.assertIn("protocol", speech)

    def test_weak_retrieval_says_so(self):
        weak = policy.CONFIDENT_MATCH_SCORE - 0.01
        self.assertIn("loose match", policy.compose_speech("Per NASEMSO-X.", top_score=weak))

    def test_confident_retrieval_stays_quiet(self):
        strong = policy.CONFIDENT_MATCH_SCORE + 0.01
        self.assertNotIn("loose match", policy.compose_speech("Per NASEMSO-X.", top_score=strong))

    def test_weak_floor_is_above_the_retrieval_floor(self):
        """Showing a result and sounding confident about it are different
        claims, so the two thresholds must not collapse into one."""
        from common import protocol_search
        self.assertGreater(policy.CONFIDENT_MATCH_SCORE, protocol_search.MIN_SCORE)

    def test_iteration_limit_is_announced(self):
        speech = policy.compose_speech("Partial answer.", hit_iteration_limit=True)
        self.assertIn("incomplete", speech)

    def test_a_turn_is_never_silent(self):
        self.assertTrue(policy.compose_speech("").strip())
        self.assertTrue(policy.compose_speech("   \n  ").strip())
        self.assertTrue(policy.compose_speech("<thinking>hmm</thinking>").strip())


class TestSpeechIsSpeakable(unittest.TestCase):
    """Polly reads every character. Markdown is not cosmetic here -- it is
    an answer the medic has to listen through."""

    def test_thinking_blocks_are_removed(self):
        out = policy.strip_model_scaffolding(
            "<thinking>The medic wants a dose.</thinking>Give 0.3 milligrams.")
        self.assertEqual(out, "Give 0.3 milligrams.")

    def test_unclosed_thinking_drops_the_rest(self):
        """An unclosed tag means the model never left its reasoning, so
        everything after it is reasoning. Emptying the string is correct --
        compose_speech substitutes a real sentence."""
        self.assertEqual(policy.strip_model_scaffolding("<thinking>still deciding"), "")

    def test_markdown_is_stripped(self):
        out = policy.strip_model_scaffolding(
            "## Dose\n- **Epinephrine** 0.3 mg `IM`\n- Repeat *q5min*")
        for junk in ("#", "*", "`", "-"):
            self.assertNotIn(junk, out)
        self.assertIn("Epinephrine 0.3 mg IM", out)

    def test_code_fences_are_stripped(self):
        out = policy.strip_model_scaffolding("```json\n{\"dose\": 1}\n```")
        self.assertNotIn("`", out)

    def test_whitespace_is_collapsed(self):
        self.assertEqual(policy.strip_model_scaffolding("a\n\n\n   b"), "a b")

    def test_composed_speech_carries_no_markup(self):
        speech = policy.compose_speech(
            "<thinking>x</thinking>**Bold** answer", flags=CONTRAINDICATED,
            failed_tools=["lookup_drug"], top_score=0.1)
        for junk in ("<", ">", "*", "`", "#"):
            self.assertNotIn(junk, speech)


if __name__ == "__main__":
    unittest.main(verbosity=2)
