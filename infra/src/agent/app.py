"""
Module 5: the hands-free conversational assistant.

  POST /agent/turn
    { "encounter_id": "...",
      "utterance": "he's allergic to bees, face is swelling, what's the epi dose",
      "transcript": "...",            # the running session transcript, device-held
      "history": [ {role, text}, ... ] }

    -> { "speech": "...", "speech_audio_base64_mp3": "...",
         "tool_calls": [...], "flags": [...], "sources": [...],
         "spoken_to_patient": {...} | null }

One turn: the medic says something, a bounded tool loop answers it, and the
answer comes back as text for the screen and audio for the cab.

Why a voice agent is defensible here
------------------------------------
In a moving ambulance, with gloved hands and eyes that belong on the
patient, a voice-driven assistant is plausibly *safer* than a touchscreen.
The question was never whether to reduce interaction -- it is which actions
the assistant is allowed to take. `policy.py` holds that boundary and
`tools.py` implements it; read both before changing this file.

The short version: the agent may add information and prepare work. It may
not remove information or finalize a record. There is no commit tool, and
safety warnings are concatenated onto its answer by code after it has
finished speaking, so it cannot decide a drug interaction is probably not
relevant.

Identity, and why this refuses rather than degrades
---------------------------------------------------
The whole accountability story rests on `get_user_id` returning a real
Cognito sub, because every tool call is logged against the *clinician*,
with `actor=AGENT` marking that the assistant performed it. If identity
cannot be established this handler refuses the turn instead of falling
back to "UNKNOWN_USER" the way a read-only endpoint safely can. An agent
acting on behalf of nobody in particular is exactly the failure mode that
guts §164.312(b), and it is better to be broken loudly than unattributable
quietly.

What is not stored
------------------
Conversation history comes from the device and goes back to it. The
backend keeps no transcript of the medic's dialogue with the assistant,
only the hashed audit rows -- one more PHI store is one more thing to
secure, retain and eventually produce, and this one buys nothing the audit
trail does not already give. The trade is the same one `/pcr/finalize`
already makes and is item 9 of docs/HIPAA_NOTES.md: the chain of custody
for what was said runs through the device.
"""
import base64
import json
import os
import time
import uuid

import boto3

import policy
import tools
from common.audit import AGENT, log_audit_event
from common.responses import ok, error, get_user_id

bedrock = boto3.client("bedrock-runtime")
polly = boto3.client("polly")

BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")

#: The assistant's own voice. Neural because the standard engine's prosody
#: on clinical strings ("0.3 mg IM") is noticeably worse, and this is heard
#: over road noise. Engine is always passed explicitly -- Polly defaults to
#: standard, and that default has already cost this codebase a 400 once.
AGENT_VOICE_ID = os.environ.get("AGENT_VOICE_ID", "Joanna")
AGENT_VOICE_ENGINE = "neural"

#: Spoken answers are two or three sentences. This is a backstop against a
#: model that decides to lecture, not the primary control -- the prompt is.
MAX_REPLY_TOKENS = 400

#: How much prior dialogue the device may replay into a turn. Enough for
#: "what about the paediatric dose" to resolve against the previous answer,
#: bounded so a long shift cannot grow one request without limit.
MAX_HISTORY_TURNS = 8


def _speak(text: str) -> str | None:
    """The agent's reply as base64 mp3. Best-effort: losing the audio must
    not lose the answer, because the text still renders on screen.

    The failure is logged because a silently-swallowed one is
    indistinguishable, from the app's side, from a playback bug on the
    device -- and that ambiguity cost a debugging session. Only the
    exception class and the length of the text are logged, never the text:
    it is the medic's answer and may name a patient's medications. See
    item 4 of docs/HIPAA_NOTES.md.
    """
    try:
        speech = polly.synthesize_speech(
            Text=text,
            OutputFormat="mp3",
            VoiceId=AGENT_VOICE_ID,
            Engine=AGENT_VOICE_ENGINE,
        )
        return base64.b64encode(speech["AudioStream"].read()).decode("utf-8")
    except Exception as e:  # noqa: BLE001 -- see docstring
        print(f"polly.synthesize_speech failed: {type(e).__name__} "
              f"(voice={AGENT_VOICE_ID}, engine={AGENT_VOICE_ENGINE}, chars={len(text)})")
        return None


def _history_messages(history) -> list:
    """Device-held dialogue -> Converse messages.

    Anything malformed is dropped rather than raising: a garbled history
    should cost the medic context, not their answer.
    """
    messages = []
    for entry in (history or [])[-MAX_HISTORY_TURNS * 2:]:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        text = (entry.get("text") or "").strip()
        if role in ("user", "assistant") and text:
            messages.append({"role": role, "content": [{"text": text}]})
    # Converse rejects a history that does not alternate cleanly or that
    # opens on an assistant turn; trim rather than error.
    while messages and messages[0]["role"] != "user":
        messages.pop(0)
    return messages


def _tool_result_message(tool_use_id: str, payload: dict, is_error: bool = False) -> dict:
    """A toolResult block, carried as text rather than json.

    Both are valid Converse, but text is what every provider accepts, and
    `BEDROCK_MODEL_ID` is deliberately swappable between vendors -- the
    same reason both Bedrock callers use Converse instead of invoke_model.
    """
    block = {
        "toolUseId": tool_use_id,
        "content": [{"text": json.dumps(payload, default=str)}],
    }
    if is_error:
        block["status"] = "error"
    return {"role": "user", "content": [{"toolResult": block}]}


def _run_turn(ctx: tools.ToolContext, utterance: str, history) -> dict:
    """The bounded tool loop. Returns everything the response needs."""
    messages = _history_messages(history)
    messages.append({"role": "user", "content": [{"text": utterance}]})

    flags: list = []
    sources: list = []
    tool_calls: list = []
    failed_tools: list = []
    top_score: float | None = None
    spoken_to_patient = None
    reply_text = ""
    hit_iteration_limit = False

    for _ in range(policy.MAX_TOOL_ITERATIONS):
        response = bedrock.converse(
            modelId=BEDROCK_MODEL_ID,
            system=[{"text": policy.SYSTEM_PROMPT}],
            messages=messages,
            toolConfig=tools.TOOL_CONFIG,
            inferenceConfig={"maxTokens": MAX_REPLY_TOKENS, "temperature": 0},
        )
        message = response["output"]["message"]
        messages.append(message)

        blocks = message.get("content") or []
        reply_text = "".join(b.get("text", "") for b in blocks)
        uses = [b["toolUse"] for b in blocks if "toolUse" in b]
        if not uses:
            break

        for use in uses:
            name, args = use.get("name"), use.get("input") or {}
            try:
                result = tools.run_tool(name, args, ctx)
            except Exception as e:  # noqa: BLE001
                # A tool failure is never swallowed. It is reported to the
                # model so it can answer around the gap, AND recorded so
                # policy.failure_notice states it out loud -- the medic has
                # to hear that something went unchecked rather than infer
                # it from an answer that merely sounds complete.
                failed_tools.append(name)
                tool_calls.append({"name": name, "args": args, "ok": False,
                                   "tier": getattr(tools.TOOLS.get(name), "tier", None),
                                   "error": str(e)})
                messages.append(_tool_result_message(
                    use["toolUseId"], {"error": str(e)}, is_error=True))
                continue

            flags.extend(result.flags)
            sources.extend(result.sources)
            if result.top_score is not None:
                top_score = result.top_score if top_score is None else max(top_score, result.top_score)
            for source in result.sources:
                if source.get("kind") == "spoken_to_patient":
                    spoken_to_patient = source

            tool_calls.append({"name": name, "args": args, "ok": True,
                               "tier": tools.TOOLS[name].tier})
            messages.append(_tool_result_message(use["toolUseId"], result.content))
    else:
        # Fell out of the loop still wanting tools. Answer with what we
        # have rather than looping -- slow, in a moving ambulance, is the
        # same as broken -- but say so, because a truncated answer sounds
        # exactly like a finished one.
        hit_iteration_limit = True

    return {
        "reply_text": reply_text,
        "flags": flags,
        "sources": sources,
        "tool_calls": tool_calls,
        "failed_tools": failed_tools,
        "top_score": top_score,
        "spoken_to_patient": spoken_to_patient,
        "hit_iteration_limit": hit_iteration_limit,
    }


def handler(event, context):
    user_id = get_user_id(event)
    # See the module docstring: no identity, no turn. Every other handler
    # can degrade to UNKNOWN_USER because a human is still driving; here
    # the whole point is that a machine is.
    if user_id == "UNKNOWN_USER":
        return error("Could not establish who is asking; refusing to act.", status=401)

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    try:
        body = json.loads(event.get("body") or "{}")
        utterance = (body.get("utterance") or "").strip()
        encounter_id = body.get("encounter_id") or str(uuid.uuid4())
    except json.JSONDecodeError as e:
        return error(f"Invalid request: {e}")

    if not utterance:
        return error("Nothing was said.")

    turn_id = str(uuid.uuid4())
    ctx = tools.ToolContext(
        user_id=user_id,
        encounter_id=encounter_id,
        turn_id=turn_id,
        source_ip=source_ip,
        transcript=(body.get("transcript") or "").strip(),
    )

    started = time.time()
    try:
        outcome = _run_turn(ctx, utterance, body.get("history"))
    except Exception as e:  # noqa: BLE001
        log_audit_event(
            user_id=user_id,
            action="AGENT_TURN",
            encounter_id=encounter_id,
            resource="agent",
            payload={"utterance": utterance, "error": str(e)},
            source_ip=source_ip,
            actor=AGENT,
            agent_turn_id=turn_id,
        )
        return error(f"The assistant could not complete that: {e}", status=502)

    # The model's text is one element of this list. Warnings are prepended
    # and caveats appended by code, so no phrasing choice can drop them.
    speech = policy.compose_speech(
        outcome["reply_text"],
        flags=outcome["flags"],
        failed_tools=outcome["failed_tools"],
        top_score=outcome["top_score"],
        hit_iteration_limit=outcome["hit_iteration_limit"],
    )

    log_audit_event(
        user_id=user_id,
        action="AGENT_TURN",
        encounter_id=encounter_id,
        resource="agent",
        payload={
            "utterance": utterance,
            "tools": [c["name"] for c in outcome["tool_calls"]],
            "flags_found": len(outcome["flags"]),
            "speech": speech,
        },
        source_ip=source_ip,
        actor=AGENT,
        agent_turn_id=turn_id,
    )

    return ok({
        "turn_id": turn_id,
        "encounter_id": encounter_id,
        "speech": speech,
        "speech_audio_base64_mp3": _speak(speech),
        "flags": outcome["flags"],
        "sources": outcome["sources"],
        "tool_calls": outcome["tool_calls"],
        "spoken_to_patient": outcome["spoken_to_patient"],
        # So the app can render "I could not file that" honestly rather
        # than the medic discovering the boundary by asking twice.
        "can_file_reports": False,
        "latency_ms": int((time.time() - started) * 1000),
    })
