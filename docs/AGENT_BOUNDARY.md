# The agent action boundary

**Read this before adding a tool to `infra/src/agent/tools.py`.**

EMS Copilot has a hands-free mode: the medic says "Copilot" and talks, and
a language model answers out loud, calling tools to look things up. This
document is what makes that defensible rather than reckless. It is short on
purpose — a boundary nobody reads is not a boundary.

The motivation is real, not a gimmick. In a moving ambulance, with gloved
hands and eyes that belong on the patient, a voice-driven assistant is
plausibly *safer* than a touchscreen. So the question was never whether to
reduce interaction. It is which actions the assistant is allowed to take.

## The one rule

> **An agent may add information and prepare work.
> It may not remove information or finalize a record.**

Everything below is that sentence applied to the eighteen routes this
system exposes.

| The agent may | Only a human may |
|---|---|
| Search the protocol library and read a guideline | Decide which of several matches applies |
| Look up a drug, dose, indication, contraindication | Decide what this patient gets, and how much |
| Run the drug interaction cross-check | Suppress, dismiss or deprioritise a flag |
| Read the draft report for the call in progress | `POST /pcr/{id}/commit` — file the report |
| Start drafting a report from the call's transcript | Correct the draft and attest to it |
| Say something to the patient in their language | Decide what the patient is told clinically |

Committing a PCR is a legal attestation by a named clinician. It is the one
write in this system that turns a machine's reading of what someone said
into somebody's chart, and it stays a deliberate human tap.

## How each half is enforced

Not by the prompt. The prompt says these things too, because the assistant
has to be able to *explain* the boundary when a medic asks it to file
something — but the prompt is the documentation, not the control.

**Finalizing is absent, not refused.** There is no `commit_pcr` tool. The
model cannot call what does not exist, so there is no instruction to
jailbreak and no refusal to argue with.
`policy.HUMAN_ONLY` names the forbidden actions as data, and
`test_agent_policy.py::test_no_human_only_action_is_a_tool` fails if any of
them ever appears in the registry.

**Drafts are structurally unfileable.** `draft_pcr_from_transcript` leaves
the record in `DRAFT`. The saved-PCR list reads the sparse `ByUserSaved`
GSI, whose sort key is `saved_at`, and only `/commit` writes `saved_at`. A
draft the agent prepared is *physically absent* from the medic's filed
records, not filtered out of them. A test asserts no agent tool writes that
attribute.

**Warnings are concatenated, not generated.** Interaction flags, tool
failures and weak retrieval matches become sentences in
`policy.compose_speech`, *after* the model has finished talking. The
model's text is one element of a list built around it:

```
[safety flags] [the model's answer] [what went unchecked] [match confidence]
```

The model cannot drop a drug interaction from an answer for the same reason
it cannot drop the timestamp — it never held it. `TestWarningsSurvive`
feeds it replies that actively try ("Everything looks fine, no concerns")
and asserts the warning comes out anyway, first.

This is the important half. The most dangerous thing an agent in this role
can do is not act wrongly; it is decide a flag probably isn't relevant.

**The model never composes a request.** Every tool takes typed arguments
against a fixed JSON schema. None takes a URL, a query expression, a table
name or a filter. Code decides what to fetch; the model only sees what
comes back. An agent that writes its own outbound calls is a PHI egress
channel with extra steps.

**The encounter is not an argument.** Tools read `ctx.encounter_id` from
the authenticated session. There is nowhere for the model to put a
different one, so it cannot ask for a chart that is not this patient's.
That is minimum-necessary enforced by shape rather than by policy. For the
same reason there is no `list_my_recent_pcrs` tool: it would widen the
agent's reach from one patient to the medic's whole history, for a
convenience.

**Identity, or nothing.** Every tool call is audited against the
clinician's Cognito `sub` with `actor="AGENT"` and a shared `agent_turn_id`,
so the trail reconstructs as *this medic said something, the agent made
these four calls, here is what it answered*. If `get_user_id` cannot
establish who is asking, `/agent/turn` returns 401 rather than degrading to
`UNKNOWN_USER` the way a read-only endpoint safely can. An agent acting on
behalf of nobody in particular is the failure mode that guts §164.312(b)
audit controls, and it is better to break loudly than to be
unattributable quietly.

**The safety-critical checks live outside the agent's reach.** The drug
cross-check runs on every commit, in deterministic code, regardless of what
the agent did or said. The agent is a convenience layer; the guarantees
live in the code path it cannot touch. That is the structural answer to
"can a language model be trusted with this" — don't trust it, and arrange
things so you don't have to.

## Silence is never "all clear"

FDA's Clinical Decision Support guidance turns, for software like this, on
whether the clinician can independently review the *basis* for a
recommendation. A spoken answer is the worst case: you cannot look at a
citation you only heard. FDA also names automation bias explicitly, and an
always-on assistant under time pressure is close to a textbook generator of
it. More autonomy moves this toward "regulated device", not away.

Three things follow, all implemented:

- **Every clinical claim names its source out loud** and renders on screen
  at the same time with document, version, page and which query terms
  matched — tapping it opens the full guideline.
- **A check that did not happen is stated.** A failed tool produces a
  sentence ("I could not reach the drug interaction check, so treat that as
  unchecked"). So does hitting the tool-iteration ceiling.
- **Weak retrieval says so.** `common/protocol_search` scores ~13/18 on its
  own benchmark, and that is pinned as a floor, not a target. Showing a
  result (`MIN_SCORE`, 0.20) and sounding confident about it
  (`CONFIDENT_MATCH_SCORE`, 0.45) are deliberately different thresholds; a
  match between them is delivered as "that is a loose match, check it
  against your own protocol".

## Known limits — read these before claiming more than is true

**The wake word does not stop audio leaving the device.** It is detected in
the *transcript*, which means the audio already reached Amazon Transcribe.
Transcribe is HIPAA-eligible and retains nothing, so the accurate claim is
"continuous audio goes to an eligible service that persists nothing, and
only wake-word-addressed turns reach our storage" — **not** "it only
listens when spoken to". Closing that gap needs on-device keyword spotting,
which needs a native module, which rules out Expo Go. See item 10 of
`HIPAA_NOTES.md`.

**Choosing a tool is itself triage, and the miss is invisible.** When a
medic describes a presentation and the agent searches with the wrong terms,
nothing announces the error — the answer just quietly concerns a different
guideline. The mitigations are partial: matched terms are shown, weak
matches are announced, and the medic can open every source. A real fix is a
semantic index (Bedrock Knowledge Base / OpenSearch), which is the same
documented right answer as for typed protocol search.

**An agent multiplies inferences.** Each turn is several Bedrock calls
carrying clinical narrative. Bedrock model-invocation logging is off by
default and must stay off, or be routed to a controlled sink, before this
sees real PHI — see `HIPAA_NOTES.md` items 4 and 11.

**One IAM role.** `AgentFunction` shares `EncounterFunctionsRole` with
everything else, so its *IAM* reach is the union of all four feature
modules'. The narrowing that matters is the tool registry, not the role.
Splitting the role is the right next step past a demo.

## Adding a tool

1. Is it *adding information or preparing work*? If it removes, finalizes,
   attests, or decides, stop — it belongs to the human.
2. Can its arguments be a fixed schema with no free-form request in them?
3. Does it need an encounter? Read it from `ToolContext`, never from an
   argument.
4. Pick a tier: `READ`, `DRAFT`, or `SPEAKS` (acts outside the phone —
   currently exactly one tool, and a test keeps it that way).
5. If it produces anything the medic must hear regardless of phrasing, the
   orchestrator collects it and `policy.compose_speech` says it. Do not
   leave it to the model.
6. Run `python3 infra/tests/test_agent_policy.py` and
   `python3 infra/tests/smoke_test_agent.py`.
