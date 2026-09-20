"""
The action boundary, and the parts of a spoken answer the model does not
get a vote on.

Pure logic -- no boto3, no network -- so `infra/tests/test_agent_policy.py`
runs it with no credentials. That matters more here than anywhere else in
the codebase: this module is the safety argument for letting an LLM drive
the app hands-free, and a safety argument you cannot test offline is a
safety argument nobody re-runs.

The one rule
------------
**An agent may add information and prepare work. It may not remove
information or finalize a record.**

Two things follow, and both are enforced by structure rather than by
asking the model nicely:

1. **Finalizing is absent, not refused.** There is no `commit_pcr` tool in
   the registry. The model cannot call what does not exist, so there is no
   prompt to jailbreak and no refusal to argue with. `HUMAN_ONLY` below
   names the forbidden actions so that a future contributor who adds one
   trips a test rather than shipping it.

2. **Warnings are concatenated, not generated.** Interaction flags, tool
   failures and weak retrieval matches are turned into sentences *here*,
   by `compose_speech`, after the model has finished talking. The model's
   text is one element of a list. It cannot drop a drug interaction from
   an answer for the same reason it cannot drop the timestamp -- it never
   held it.

The second one is the important half. The most dangerous thing an agent in
this role can do is not act wrongly; it is decide a flag probably isn't
relevant. So the flag never passes through its hands.

Why the caveats are so insistent
--------------------------------
FDA's Clinical Decision Support guidance turns, for software like this, on
whether the clinician can independently review the *basis* for a
recommendation. A spoken answer is the worst case for that: you cannot
look at a citation you only heard. Two mitigations run throughout:

  - every spoken clinical claim names its protocol id out loud, and the
    full record with its page citation is on screen at the same time
    (`display` / `sources` in the turn response);
  - the absence of a check is *stated*, never silent. A tool that failed
    produces a sentence. Retrieval that only just cleared the floor
    produces a sentence. Silence must never be readable as "all clear".
"""
import re

# ---------------------------------------------------------------------
# The boundary
# ---------------------------------------------------------------------

#: Actions the hands-free agent must never be able to perform, and why.
#: These names are not tool names -- they are deliberately *not* in the
#: registry. This mapping exists so the test suite can assert their
#: absence, and so anyone tempted to add one reads the reason first.
HUMAN_ONLY = {
    "commit_pcr": (
        "Filing a PCR is a legal attestation by a named clinician. The medic "
        "reviews the draft and taps Save; nothing else may."
    ),
    "edit_saved_pcr": (
        "Editing a filed record is an amendment to a legal document and has "
        "to be attributable to the human making it."
    ),
    "dismiss_interaction_flag": (
        "Suppressing or deprioritising a safety flag is the single most "
        "dangerous capability an agent in this role could hold. Flags are "
        "added by code and never filtered -- see compose_speech."
    ),
    "choose_dose": (
        "Retrieval and phrasing only. The agent reports what a protocol "
        "says; deciding what this patient gets is the medic's judgment."
    ),
    "administer": (
        "Nothing in this system touches a patient. Listed so the boundary "
        "reads as a whole rather than as an accident of what was built."
    ),
}

#: What a tool does to the world, which decides how its result is surfaced.
#:   READ   -- reads reference data or the medic's own records
#:   DRAFT  -- prepares work the medic will review (never files it)
#:   SPEAKS -- causes sound in the ambulance, i.e. talks to the patient
TIER_READ = "read"
TIER_DRAFT = "draft"
TIER_SPEAKS = "speaks"
TIERS = (TIER_READ, TIER_DRAFT, TIER_SPEAKS)

#: A hard ceiling on tool calls per turn. A loop that wanders is a loop
#: that is slow, and slow in a moving ambulance is the same as broken.
MAX_TOOL_ITERATIONS = 5

#: Below this retrieval score the answer is delivered as a weak match.
#: `common/protocol_search.MIN_SCORE` (0.20) is the floor for showing a
#: result at all; this is the floor for sounding confident about it. The
#: gap between them is deliberate -- the retriever scores ~13/18 on its own
#: benchmark, so "I found something" and "this is the right guideline" are
#: genuinely different claims.
CONFIDENT_MATCH_SCORE = 0.45


# ---------------------------------------------------------------------
# The system prompt
# ---------------------------------------------------------------------

SYSTEM_PROMPT = """You are EMS Copilot, a hands-free assistant riding along \
with an EMT. The medic's hands are busy and their eyes are on the patient, \
so they are talking to you and listening to your answer. Sound like a \
competent partner on the radio: short, specific, calm.

How to answer:
- Two or three sentences. This is spoken aloud in a noisy moving vehicle.
- Plain sentences only. No markdown, no bullet points, no headings, no \
emoji -- every character you write gets read out loud.
- Numbers as a medic says them: "0.3 milligrams", "one to two micrograms \
per kilogram per minute".

What you may and may not say:
- Use ONLY what the tools return. If a dose, indication or \
contraindication is not in a tool result, you do not know it -- say you \
could not find it and tell the medic to consult medical control. Do not \
supply it from your own knowledge even when you are confident it is right.
- Never describe the contents of a report, protocol or drug record you did \
not read **in this turn**. Earlier in this conversation you may have said a \
report was being written; that is not the same as having read it. If the \
medic asks what is in something, call the tool that reads it, every time. \
Answering from what you remember of the conversation is how a report the \
medic never saw gets described to them as fact.
- When you quote a protocol, name its id out loud so the medic can find \
it on screen.
- Never tell the medic what the patient has. You match protocols to what \
they described; you do not diagnose.
- Never decide what to give or how much. Report what the protocol says \
and let the medic choose.
- You cannot file a patient care report. If asked to save, file, submit or \
sign one, say that you have prepared the draft and the medic has to review \
and file it themselves. That is not a limitation you should apologise for; \
it is how the record stays theirs.
- You *can* read a draft back. Reading is not filing. If the medic asks \
what is in the report, read it with the tool and tell them; if that tool \
says nothing has been drafted for this call, say exactly that rather than \
claiming you are not allowed to look.
- If a tool returns nothing, say so plainly. "I could not find that" is a \
useful answer. A confident wrong protocol is not.

You do not need to mention drug interaction warnings, tool failures, or how \
certain a protocol match was -- those are added to your answer \
automatically. Just answer the question."""


# ---------------------------------------------------------------------
# Turning things into sentences a medic hears
# ---------------------------------------------------------------------

#: Substituted when the model produced nothing usable. Never leave a turn
#: silent -- the medic asked a question and is waiting.
EMPTY_ANSWER = (
    "I did not get an answer for that. Say it again, or check the protocol yourself."
)


def interaction_notice(flags: list) -> str | None:
    """The sentence that leads the answer when a drug pair is flagged.

    Written here, prepended by `compose_speech`, and never shown to the
    model as something it may edit. Severity is spoken because
    "contraindicated" and "use caution" are different instructions.
    """
    if not flags:
        return None

    parts = []
    for flag in flags:
        a = flag.get("drug_a") or "one drug"
        b = flag.get("drug_b") or "another"
        severity = str(flag.get("severity") or "").upper()
        lead = "Contraindicated" if severity == "CONTRAINDICATED" else "Caution"
        parts.append(f"{lead}: {a} with {b}")

    head = "Heads up. " if len(parts) == 1 else "Heads up, two things. "
    return head + "; ".join(parts) + "."


def failure_notice(failed_tools: list) -> str | None:
    """State what could not be checked.

    An agent that silently drops a failed interaction check leaves the
    medic hearing a complete-sounding answer with a hole in it. This is
    the structural fix: the orchestrator records failures and code turns
    them into words, so a failure cannot be lost in the model's phrasing.
    """
    if not failed_tools:
        return None
    labels = {
        "check_drug_interactions": "the drug interaction check",
        "lookup_drug": "the drug reference",
        "search_protocols": "the protocol library",
        "get_protocol": "the full protocol text",
        "read_current_pcr": "the current report draft",
        "draft_pcr_from_transcript": "the report draft",
        "speak_to_patient": "the translation",
        "list_my_recent_pcrs": "your recent reports",
    }
    named = sorted({labels.get(t, t) for t in failed_tools})
    if len(named) == 1:
        return f"I could not reach {named[0]}, so treat that as unchecked."
    return f"I could not reach {' or '.join(named)}, so treat those as unchecked."


def truncated_notice(hit_iteration_limit: bool) -> str | None:
    """Say so when the loop ran out of steps mid-answer.

    `MAX_TOOL_ITERATIONS` exists because a wandering loop is a slow one,
    and slow in a moving ambulance is the same as broken. But an answer cut
    short for budget reasons sounds exactly like a complete one, which is
    the failure this whole module is about -- so the ceiling announces
    itself.
    """
    if not hit_iteration_limit:
        return None
    return "I ran out of steps before finishing that, so the answer may be incomplete."


def weak_match_notice(top_score: float | None) -> str | None:
    """Say so when retrieval only just cleared its floor.

    Every remaining miss in the retrieval benchmark is the same failure:
    the words an EMT says have near-zero document frequency in NASEMSO's
    prose. The honest response to a retriever with known blind spots is to
    let the medic hear the uncertainty, not to smooth it over.
    """
    if top_score is None or top_score >= CONFIDENT_MATCH_SCORE:
        return None
    return "That is a loose match, so check it against your own protocol before acting on it."


# ---------------------------------------------------------------------
# Cleaning up what the model said
# ---------------------------------------------------------------------

_THINKING = re.compile(r"<thinking>.*?</thinking>", re.DOTALL | re.IGNORECASE)
_UNCLOSED_THINKING = re.compile(r"<thinking>.*\Z", re.DOTALL | re.IGNORECASE)
_TAG = re.compile(r"</?[a-z_][a-z0-9_-]*>", re.IGNORECASE)
_CODE_FENCE = re.compile(r"```[a-z]*\n?", re.IGNORECASE)
_HEADING = re.compile(r"^\s{0,3}#{1,6}\s*", re.MULTILINE)
_BULLET = re.compile(r"^\s{0,3}[-*+]\s+", re.MULTILINE)
_EMPHASIS = re.compile(r"(\*{1,3}|_{1,3}|`)")


def strip_model_scaffolding(text: str) -> str:
    """Model output -> something safe to hand Polly.

    Nova wraps its reasoning in <thinking> tags even when told not to, and
    every model reaches for markdown eventually. Polly reads an asterisk
    out loud as "asterisk", so this is not cosmetic -- unstripped markdown
    is an answer the medic has to listen through.

    An *unclosed* <thinking> tag means the model never left its reasoning,
    so everything after it is dropped. That can empty the string, which is
    correct: `compose_speech` substitutes EMPTY_ANSWER rather than reading
    a half-finished thought aloud.
    """
    text = _THINKING.sub(" ", text or "")
    text = _UNCLOSED_THINKING.sub(" ", text)
    text = _CODE_FENCE.sub(" ", text)
    text = _TAG.sub(" ", text)
    text = _HEADING.sub("", text)
    text = _BULLET.sub("", text)
    text = _EMPHASIS.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def compose_speech(
    model_text: str,
    *,
    flags: list | None = None,
    failed_tools: list | None = None,
    top_score: float | None = None,
    hit_iteration_limit: bool = False,
) -> str:
    """Assemble the spoken answer in a fixed order the model cannot alter.

        [safety flags] [the model's answer] [what went unchecked] [match confidence]

    Flags lead because a medic who stops listening after the first sentence
    must still have heard the warning. Everything except the middle element
    is written by the functions above; the model contributes one string to
    a list built around it.
    """
    answer = strip_model_scaffolding(model_text) or EMPTY_ANSWER
    ordered = [
        interaction_notice(flags or []),
        answer,
        failure_notice(failed_tools or []),
        truncated_notice(hit_iteration_limit),
        weak_match_notice(top_score),
    ]
    return " ".join(part for part in ordered if part).strip()
