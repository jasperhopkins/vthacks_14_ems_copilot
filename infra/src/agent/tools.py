"""
The agent's tool surface: every action the hands-free assistant can take,
and nothing else.

Four properties of this file are load-bearing. Changing any of them is a
change to the safety argument, not a refactor.

**1. The model never composes a request.** It emits a tool name and typed
arguments against a fixed JSON schema; the code below builds the query,
picks the table, and calls the API. There is no tool that takes a URL, a
query expression, a table name or a raw filter. An agent that writes its
own outbound calls is a PHI egress channel with extra steps, and this is
the same rule the openFDA seed miner follows: code decides what to fetch,
the model only sees what comes back.

**2. Every tool runs the same code the tapped endpoint runs.**
`search_protocols` ranks with `common.protocol_search`, exactly as
`POST /protocol/query` does. `check_drug_interactions` calls
`common.drugs.check_interactions`, exactly as `POST /drug/check-interaction`
does. Drafting re-invokes the real finalize worker. So a spoken question
and a tapped one cannot retrieve different guidelines or disagree about an
interaction -- the same reason `common/drugs.py` and `common/pcr.py` exist
at all.

**3. The encounter is not an argument.** Tools that touch patient records
read `ctx.encounter_id`, which comes from the authenticated session. The
model cannot ask for someone else's encounter because there is nowhere to
put the id. That is the minimum-necessary control: a medic's assistant
should reach exactly one patient's chart, not every chart the medic's
token can open.

**4. There is no tool that finalizes anything.** See `policy.HUMAN_ONLY`.
`draft_pcr_from_transcript` leaves the record in DRAFT, which is invisible
to the saved-PCR list until a human commits it -- the sparse `ByUserSaved`
GSI is keyed on `saved_at`, and only `POST /pcr/{id}/commit` writes that.
So "the agent cannot file a report" is a property of the data model, not
of the prompt.

Deliberately not a tool
-----------------------
`list_my_recent_pcrs` was considered and left out. "What was my last call"
is a plausible thing to ask, but it widens the agent's reach from one
patient to the medic's whole history for a convenience, and minimum
necessary is a rule about what a capability *can* touch, not what it
usually does. The medic can still tap through to their saved PCRs.
"""
import base64
import json
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable

import boto3

import policy
from common.audit import AGENT, log_audit_event
from common.drugs import check_interactions, get_drug
from common.languages import BY_CODE, is_supported, voice_for
from common.tables import scan_all
from common import protocol_search

dynamodb = boto3.resource("dynamodb")
lambda_client = boto3.client("lambda")
translate_client = boto3.client("translate")
polly = boto3.client("polly")

ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
PROTOCOL_TABLE = os.environ.get("PROTOCOL_TABLE_NAME", "ems-copilot-protocols")
FINALIZE_FUNCTION = os.environ.get("FINALIZE_FUNCTION_NAME", "")

encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)
protocol_table = dynamodb.Table(PROTOCOL_TABLE)

#: How many protocol records to put in front of the model. Five is what
#: `POST /protocol/query` uses; more is not better, because a weak fifth
#: candidate is a wrong answer waiting to be phrased confidently.
PROTOCOL_CANDIDATES = 3

#: A report needs an actual account of the call behind it. Below this many
#: words the transcript is a stray phrase or the request itself -- and an
#: empty PCR that looks filed is worse than no PCR, because the medic finds
#: out at the end of the shift rather than while the patient is in front of
#: them. Measured in words, not characters, so a long drug name does not
#: pass for a narration.
MIN_TRANSCRIPT_WORDS = 12

#: Steps sent per protocol. A NASEMSO guideline runs to ~6 KB of verbatim
#: text and three of them blow past a useful context budget for a two
#: sentence spoken answer. The medic gets the full record on screen; the
#: model gets enough to answer from.
MAX_STEPS = 12


def _plain(value):
    """DynamoDB Decimals -> ints/floats, so the model is not handed
    `Decimal('3')` rendered as a string."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------
# What a tool is
# ---------------------------------------------------------------------

@dataclass
class ToolContext:
    """Everything a tool is allowed to know about who is asking.

    `encounter_id` and `user_id` come from the authenticated request, never
    from the model. `transcript` is the running session transcript the
    device holds -- the backend has no copy until a draft is requested.
    """
    user_id: str
    encounter_id: str
    turn_id: str
    source_ip: str | None = None
    transcript: str = ""


@dataclass
class ToolResult:
    """A tool's answer, split by who needs which part.

    `content` goes back to the model. `flags` and `top_score` go to
    `policy.compose_speech`, which turns them into sentences the model
    never sees and therefore cannot drop. `sources` goes to the screen, so
    a spoken protocol id has a citable record next to it.
    """
    content: dict
    flags: list = field(default_factory=list)
    sources: list = field(default_factory=list)
    top_score: float | None = None


@dataclass
class Tool:
    name: str
    tier: str
    description: str
    schema: dict
    run: Callable[..., ToolResult]
    #: What this tool reads or touches, for the audit row.
    resource: str
    action: str

    def spec(self) -> dict:
        """The Bedrock Converse toolSpec for this tool."""
        return {
            "toolSpec": {
                "name": self.name,
                "description": self.description,
                "inputSchema": {"json": self.schema},
            }
        }


# ---------------------------------------------------------------------
# Reference lookups -- the bulk of what a medic asks for
# ---------------------------------------------------------------------

def _protocol_for_model(record: dict) -> dict:
    steps = [str(s) for s in record.get("steps") or []][:MAX_STEPS]
    return {
        "protocol_id": record.get("protocol_id"),
        "title": record.get("title"),
        "category": record.get("category"),
        "indications": record.get("indications"),
        "exclusions": record.get("exclusions"),
        "steps": steps,
        "steps_truncated": len(record.get("steps") or []) > MAX_STEPS,
        "source_page": _plain(record.get("source_page")),
        "score": record.get("score"),
    }


def _protocol_source(record: dict) -> dict:
    """The citation card the app renders under "Sources for this answer"."""
    return {
        "kind": "protocol",
        "protocol_id": record.get("protocol_id"),
        "title": record.get("title"),
        "category": record.get("category"),
        "document": record.get("source_document"),
        "version": record.get("source_version"),
        "page": _plain(record.get("source_page")),
        "score": record.get("score"),
        "matched_terms": record.get("matched_terms") or [],
    }


def _search_protocols(ctx: ToolContext, query: str) -> ToolResult:
    matches = protocol_search.search(
        query, scan_all(protocol_table), limit=PROTOCOL_CANDIDATES
    )
    if not matches:
        # The same wording the typed endpoint uses. "Nothing matched" must
        # never be heard as "nothing applies".
        return ToolResult(content={
            "matches": [],
            "note": (
                "No protocol in the library matches that. This means the tool has "
                "nothing to offer, NOT that no protocol applies. Tell the medic to "
                "consult their agency protocol or medical control."
            ),
        })

    return ToolResult(
        content={"matches": [_protocol_for_model(m) for m in matches]},
        sources=[_protocol_source(m) for m in matches],
        top_score=matches[0].get("score"),
    )


def _get_protocol(ctx: ToolContext, protocol_id: str) -> ToolResult:
    record = protocol_table.get_item(Key={"protocol_id": protocol_id}).get("Item")
    if not record:
        return ToolResult(content={"found": False, "protocol_id": protocol_id})
    full = _protocol_for_model(_plain(record))
    full["assessment"] = [str(a) for a in record.get("assessment") or []][:MAX_STEPS]
    full["safety_considerations"] = [str(s) for s in record.get("safety_considerations") or []]
    return ToolResult(
        content={"found": True, "protocol": full},
        sources=[_protocol_source(_plain(record))],
    )


def _lookup_drug(ctx: ToolContext, drug_name: str) -> ToolResult:
    record = get_drug(drug_name)
    if not record:
        return ToolResult(content={"found": False, "drug_name": drug_name})
    record = _plain(record)
    return ToolResult(
        content={
            "found": True,
            "drug": {
                "drug_name": record.get("display_name") or record.get("drug_name"),
                "class": record.get("class"),
                "common_uses": record.get("common_uses"),
                "adult_dose": record.get("adult_dose"),
                "pediatric_dose": record.get("pediatric_dose"),
                "contraindications": record.get("contraindications_text"),
                "indications": record.get("indications_text"),
            },
        },
        sources=[{
            "kind": "drug",
            "drug_name": record.get("display_name") or record.get("drug_name"),
            "document": record.get("source_document"),
            "version": record.get("source_version"),
        }],
    )


def _check_drug_interactions(ctx: ToolContext, drug_names: list) -> ToolResult:
    names = [str(n).strip() for n in drug_names if str(n).strip()]
    if len(names) < 2:
        return ToolResult(content={
            "error": "Need at least two drug names to check a pair.",
        })

    flags = _plain(check_interactions(names))
    return ToolResult(
        # The model is told the result so it can answer coherently, and
        # told plainly that voicing the warning is not its job -- the
        # warning is prepended by policy.compose_speech either way, and two
        # copies of the same warning in one spoken answer is noise.
        content={
            "drugs_checked": names,
            "flags": flags,
            "safe": not flags,
            "note": (
                "Any flags here are spoken to the medic automatically before your "
                "answer. Do not repeat them."
            ),
        },
        flags=flags,
        sources=[{
            "kind": "interaction",
            "drug_a": f.get("drug_a"),
            "drug_b": f.get("drug_b"),
            "severity": f.get("severity"),
            "basis": f.get("basis"),
            "note": f.get("note"),
            "source_url": f.get("source_url"),
        } for f in flags],
    )


# ---------------------------------------------------------------------
# This encounter -- scoped by the session, never by an argument
# ---------------------------------------------------------------------

def _read_current_pcr(ctx: ToolContext) -> ToolResult:
    record = encounters_table.get_item(Key={"encounter_id": ctx.encounter_id}).get("Item")
    if not record:
        return ToolResult(content={
            "status": "NONE",
            "note": "Nothing has been drafted for this call yet.",
        })
    # Belt and braces. The encounter id is not model-supplied, so this
    # should be unreachable -- but the check costs nothing and the failure
    # it guards against is reading another medic's chart out loud.
    if record.get("created_by") not in (ctx.user_id, None):
        return ToolResult(content={"status": "DENIED", "note": "Not this user's encounter."})

    return ToolResult(content={
        "status": record.get("status"),
        "pcr": _plain(record.get("structured_pcr") or {}),
        "interaction_flags": _plain(record.get("interaction_flags") or []),
        "note": (
            "A DRAFT is not filed. Only the medic can file it, by reviewing it on "
            "screen and tapping save."
        ),
    })


def _draft_pcr_from_transcript(ctx: ToolContext) -> ToolResult:
    """Kick off extraction over what has been said so far on this call.

    Deliberately async, and deliberately not its own extraction: this
    re-invokes the real `PcrFinalizeFunction` worker, so the draft the
    agent produces goes through the identical Bedrock prompt, the identical
    normalisation and the identical drug cross-check as the draft the
    Record button produces. A second extraction path is a second set of
    bugs and a second PCR shape.

    Bedrock extraction on a long transcript also takes longer than API
    Gateway's non-adjustable 30-second ceiling, and this call is already
    inside an agent loop that has spent some of it.
    """
    transcript = (ctx.transcript or "").strip()
    words = len(transcript.split())
    if words < MIN_TRANSCRIPT_WORDS:
        # Not a formality. Extraction over a couple of words returns a PCR
        # with every field null, which is indistinguishable on screen from
        # a report that genuinely found nothing -- so refuse, and say why.
        return ToolResult(content={
            "started": False,
            "words_heard": words,
            "note": (
                f"Only {words} words of this call have been heard, which is not enough "
                "to write a report from. Tell the medic plainly that you have not heard "
                "enough of the call yet, and that they should narrate what happened -- "
                "age, complaint, vitals, what was given -- and then ask again. Do NOT "
                "start a report from this."
            ),
        })
    if not FINALIZE_FUNCTION:
        return ToolResult(content={
            "started": False,
            "note": "Drafting is unavailable: the extraction worker is not configured.",
        })

    lambda_client.invoke(
        FunctionName=FINALIZE_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps({
            "__extract_worker": True,
            "encounter_id": ctx.encounter_id,
            "user_id": ctx.user_id,
            "source_ip": ctx.source_ip,
            "transcript": transcript,
            "capture_mode": "AGENT",
            # So the rows the worker writes say the assistant did this, on
            # this turn, rather than reading as the medic's own tap.
            "actor": AGENT,
            "agent_turn_id": ctx.turn_id,
        }).encode(),
    )
    return ToolResult(content={
        "started": True,
        "encounter_id": ctx.encounter_id,
        "transcript_chars": len(transcript),
        "note": (
            "Extraction started. It appears on the medic's screen as a draft in a "
            "few seconds. Tell them it is being written up and that they need to "
            "review and file it -- you cannot file it."
        ),
    })


# ---------------------------------------------------------------------
# The one tool that causes something to happen outside the phone
# ---------------------------------------------------------------------

def _speak_to_patient(ctx: ToolContext, text: str, language: str) -> ToolResult:
    """Say something to the patient in their language.

    Tiered SPEAKS because it is the only tool whose effect is not a value
    returned to a screen -- it makes sound in the ambulance, at a patient.
    Two controls come with that, both in the turn response rather than in
    the prompt: the English sentence is returned as `spoken_to_patient` and
    rendered verbatim on the medic's screen, and the audit row records the
    turn it belongs to. The medic always sees what was said in their name.
    """
    text = (text or "").strip()
    if not text:
        return ToolResult(content={"spoken": False, "note": "Nothing to say."})
    if not is_supported(language):
        supported = ", ".join(sorted(entry["label"] for entry in BY_CODE.values()))
        return ToolResult(content={
            "spoken": False,
            "note": f"This translator does not support that language. It supports: {supported}.",
        })

    translated = translate_client.translate_text(
        Text=text, SourceLanguageCode="en", TargetLanguageCode=language
    )["TranslatedText"]

    audio_b64 = None
    chosen = voice_for(language)
    if chosen:
        voice_id, engine, polly_lang = chosen
        kwargs = {"Text": translated, "OutputFormat": "mp3", "VoiceId": voice_id,
                  "Engine": engine}
        if polly_lang:
            kwargs["LanguageCode"] = polly_lang
        speech = polly.synthesize_speech(**kwargs)
        audio_b64 = base64.b64encode(speech["AudioStream"].read()).decode("utf-8")

    label = BY_CODE[language]["label"]
    return ToolResult(content={
        "spoken": True,
        "language": label,
        "english": text,
        "translated_text": translated,
        # Three of the sixteen languages have no Polly voice at all. That is
        # a supported state, not a failure -- but the medic has to be told,
        # because a patient who was shown text is not a patient who was
        # spoken to.
        "note": (
            f"Said to the patient in {label}."
            if chosen else
            f"{label} has no voice available, so the text is on screen for the "
            "patient to read. Tell the medic to show them the phone."
        ),
    }, sources=[{
        "kind": "spoken_to_patient",
        "language": label,
        "english": text,
        "translated_text": translated,
        "can_speak": bool(chosen),
        "audio_base64_mp3": audio_b64,
    }])


# ---------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------

_REGISTRY = [
    Tool(
        name="search_protocols",
        tier=policy.TIER_READ,
        resource="protocols",
        action="READ",
        description=(
            "Find the EMS clinical guideline covering a presentation, complaint or "
            "intervention. Use the medic's own words as the query. This is the only "
            "source of protocol content -- never answer a protocol question without it."
        ),
        schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What the medic described, in their words, e.g. 'stung by a bee, face swelling'.",
                }
            },
            "required": ["query"],
        },
        run=_search_protocols,
    ),
    Tool(
        name="get_protocol",
        tier=policy.TIER_READ,
        resource="protocols",
        action="READ",
        description=(
            "Fetch one guideline in full by its id, when search returned it but you "
            "need steps beyond the ones shown."
        ),
        schema={
            "type": "object",
            "properties": {
                "protocol_id": {"type": "string", "description": "An id returned by search_protocols."}
            },
            "required": ["protocol_id"],
        },
        run=_get_protocol,
    ),
    Tool(
        name="lookup_drug",
        tier=policy.TIER_READ,
        resource="drug_reference",
        action="DRUG_LOOKUP",
        description=(
            "Look up one drug in the EMS formulary: class, indications, adult and "
            "paediatric dosing, contraindications. Field nicknames work -- 'epi', "
            "'narcan', 'nitro'."
        ),
        schema={
            "type": "object",
            "properties": {"drug_name": {"type": "string"}},
            "required": ["drug_name"],
        },
        run=_lookup_drug,
    ),
    Tool(
        name="check_drug_interactions",
        tier=policy.TIER_READ,
        resource="drug_reference",
        action="DRUG_INTERACTION_CHECK",
        description=(
            "Check two or more drugs against each other. Call this whenever the medic "
            "mentions giving something to a patient who is already on something, even "
            "if they did not ask."
        ),
        schema={
            "type": "object",
            "properties": {
                "drug_names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Two or more drug names: what was given plus the patient's own medications.",
                }
            },
            "required": ["drug_names"],
        },
        run=_check_drug_interactions,
    ),
    Tool(
        name="read_current_pcr",
        tier=policy.TIER_READ,
        resource="encounters.pcr",
        action="READ",
        description=(
            "Read the draft report for the call in progress. Takes no arguments -- it "
            "always reads this call, never another. You MUST call this before saying "
            "anything about what the report contains; the conversation so far is not "
            "a substitute, and a report you said was being written is not a report "
            "you have read."
        ),
        schema={"type": "object", "properties": {}},
        run=_read_current_pcr,
    ),
    Tool(
        name="draft_pcr_from_transcript",
        tier=policy.TIER_DRAFT,
        resource="encounters.pcr",
        action="UPDATE",
        description=(
            "Start writing up this call as a patient care report from everything said "
            "so far. Produces a DRAFT for the medic to review; it does NOT file "
            "anything.\n"
            "Call this whenever the medic asks for the paperwork in ANY words: write "
            "it up, write up the report, transcribe a PCR, transcribe this patient, "
            "document this call, chart it, make a report, do the PCR, start the "
            "paperwork. 'Transcribe' and 'document' mean this tool -- they do not "
            "mean reading something back.\n"
            "Call it even when the medic describes the patient in the same breath "
            "('transcribe a PCR, 58 year old male with a bee sting'). That "
            "description is material for the report, not a question to look up."
        ),
        schema={"type": "object", "properties": {}},
        run=_draft_pcr_from_transcript,
    ),
    Tool(
        name="speak_to_patient",
        tier=policy.TIER_SPEAKS,
        resource="translate",
        action="TRANSLATE",
        description=(
            "Say something out loud to the patient in their own language. Relay what "
            "the medic wants said, in plain words -- do not invent clinical "
            "instructions or ask questions the medic did not ask."
        ),
        schema={
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The English sentence to say to the patient."},
                "language": {
                    "type": "string",
                    "description": "Two-letter language code from the supported set, e.g. 'es', 'zh', 'ar'.",
                },
            },
            "required": ["text", "language"],
        },
        run=_speak_to_patient,
    ),
]

TOOLS = {tool.name: tool for tool in _REGISTRY}

#: Passed to Bedrock Converse. Built from the registry, so a tool that is
#: not registered is not offered -- there is no second list to forget.
TOOL_CONFIG = {"tools": [tool.spec() for tool in _REGISTRY]}


def run_tool(name: str, args: dict, ctx: ToolContext) -> ToolResult:
    """Execute one tool call and write its audit row.

    The row carries the clinician's `user_id` -- they remain accountable --
    with `actor=AGENT` and the turn id, so the trail reads as "this medic
    said something, and the agent made these calls because of it".
    """
    tool = TOOLS.get(name)
    if tool is None:
        # Unreachable through Converse, which only offers registered tools,
        # but a hallucinated name must fail closed rather than KeyError.
        return ToolResult(content={"error": f"No such tool: {name}"})

    result = tool.run(ctx, **(args or {}))

    log_audit_event(
        user_id=ctx.user_id,
        action=tool.action,
        encounter_id=ctx.encounter_id,
        resource=tool.resource,
        payload={"tool": name, "args": args, "tier": tool.tier},
        source_ip=ctx.source_ip,
        actor=AGENT,
        agent_turn_id=ctx.turn_id,
    )
    return result

