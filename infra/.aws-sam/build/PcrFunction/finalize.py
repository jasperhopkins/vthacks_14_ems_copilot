"""
Turn a finished transcript into a draft PCR.

  POST /pcr/finalize  { "encounter_id": ..., "transcript": "..." }
    -> 202 { "status": "EXTRACTING" }
    -> { "status": "RECORDING", "pending": 2 }   (chunked mode, still transcribing)

The caller then polls GET /pcr/{encounter_id} until it reports DRAFT (or
FAILED), reviews the result, and POSTs it to /pcr/{id}/commit -- which is
what actually files it. Nothing reaches the saved-PCR list until that
commit, so an extraction the medic disagrees with never becomes part of
their chart history.

Why the extraction is asynchronous
----------------------------------
It used to run inline and return the draft. That works until the
transcript gets long: Bedrock takes longer than API Gateway's 30-second
integration ceiling (which, being an HTTP API, is not adjustable), the
request 504s, and the app reports a failure -- while the Lambda keeps
running and quietly writes a perfectly good DRAFT nobody ever sees. That
is exactly the "long recordings never show a PCR" symptom.

So this handler now does the cheap part inline (persist the transcript,
mark the record EXTRACTING) and re-invokes ITSELF with InvocationType
"Event" to do the Bedrock call outside the request. The worker gets up to
the function's full 300s timeout. Polling was already how the client
learns about PCR state, so this costs the app nothing new.

Two transcript sources feed this, and they are the same from here on:
  - streaming (the app's live Transcribe WebSocket) passes "transcript"
  - chunked (chunk.py -> live.py) passes none, and it is stitched from the
    chunk map, which must be fully harvested first
"""
import json
import os
import time
import boto3
from common.audit import log_audit_event
from common.pcr import cross_check, extract_structured_pcr
from common.responses import ok, error, get_user_id

dynamodb = boto3.resource("dynamodb")
lambda_client = boto3.client("lambda")
ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

# Marks the async self-invocation, which arrives as a raw dict rather than
# an API Gateway event.
WORKER_FLAG = "__extract_worker"


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _fail(encounter_id: str, reason: str) -> None:
    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression="SET #st = :failed, #err = :reason",
        ExpressionAttributeNames={"#st": "status", "#err": "error"},
        ExpressionAttributeValues={":failed": "FAILED", ":reason": reason},
    )


# ---------------------------------------------------------------------
# The async half: Bedrock extraction + drug cross-check.
# ---------------------------------------------------------------------

def _run_extraction(encounter_id: str, user_id: str, source_ip: str | None) -> dict:
    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        return {"status": "FAILED", "error": f"No encounter {encounter_id}"}

    transcript = (record.get("transcript") or "").strip()
    if not transcript:
        _fail(encounter_id, "No transcript to extract from")
        return {"status": "FAILED", "error": "No transcript to extract from"}

    try:
        structured = extract_structured_pcr(transcript)
    except Exception as e:  # noqa: BLE001 -- surface pipeline errors to the app
        _fail(encounter_id, str(e))
        return {"status": "FAILED", "error": str(e)}

    drugs, interaction_flags = cross_check(structured)
    if len(drugs) >= 2:
        log_audit_event(
            user_id=user_id,
            action="DRUG_INTERACTION_CHECK",
            encounter_id=encounter_id,
            resource="drug_reference",
            payload={"drugs": drugs, "flags_found": len(interaction_flags), "trigger": "pcr_auto"},
            source_ip=source_ip,
        )

    # UpdateItem rather than PutItem: chunk writes can touch the same record
    # and a read-modify-write here would drop any that landed in between.
    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression=(
            "SET #st = :draft, structured_pcr = :p, interaction_flags = :f, "
            "drafted_at = :now REMOVE #err"
        ),
        ExpressionAttributeNames={"#st": "status", "#err": "error"},
        ExpressionAttributeValues={
            ":draft": "DRAFT",
            ":p": structured,
            ":f": interaction_flags,
            ":now": int(time.time() * 1000),
        },
    )

    log_audit_event(
        user_id=user_id,
        action="UPDATE",
        encounter_id=encounter_id,
        resource="encounters.pcr",
        payload={"status": "DRAFT", "structured_pcr": structured},
        source_ip=source_ip,
    )
    return {"status": "DRAFT", "pcr": structured, "interaction_flags": interaction_flags}


# ---------------------------------------------------------------------

def handler(event, context):
    # Async self-invocation: no HTTP wrapper, just do the work.
    if isinstance(event, dict) and event.get(WORKER_FLAG):
        return _run_extraction(event["encounter_id"], event.get("user_id", "UNKNOWN_USER"),
                               event.get("source_ip"))

    user_id = get_user_id(event)
    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    try:
        body = json.loads(event.get("body") or "{}")
        encounter_id = body["encounter_id"]
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    # Streaming mode hands us the transcript the device already has; chunked
    # mode stitches it from the harvested chunks.
    transcript = (body.get("transcript") or "").strip()
    streaming = bool(transcript)

    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        # In streaming mode nothing has written this encounter yet -- the
        # audio went from the device straight to Transcribe and never
        # touched S3 or a Lambda, so this is the first the backend hears of
        # it. Chunked mode always has a record by now (chunk.py creates it).
        if not streaming:
            return error(f"No encounter {encounter_id}", status=404)
        encounters_table.put_item(
            Item={
                "encounter_id": encounter_id,
                "record_type": "PCR",
                "created_by": user_id,
                "created_at": int(time.time() * 1000),
                "capture_mode": "STREAMING",
                "status": "EXTRACTING",
            },
            ConditionExpression="attribute_not_exists(encounter_id)",
        )
    elif record.get("created_by") not in (user_id, None):
        return error("Not your encounter", status=403)

    if not transcript:
        chunks = sorted((record.get("chunks") or {}).values(), key=lambda c: _int(c.get("seq")))
        if not chunks:
            return error("No transcript and no audio chunks on this encounter", status=409)
        pending = [c for c in chunks if c.get("status") == "PENDING"]
        if pending:
            return ok({"encounter_id": encounter_id, "status": "RECORDING", "pending": len(pending)})
        transcript = " ".join(
            (c.get("text") or "").strip() for c in chunks if c.get("status") == "DONE"
        ).strip()

    if not transcript:
        reason = "Nothing was transcribed"
        _fail(encounter_id, reason)
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": reason})

    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression="SET #st = :extracting, transcript = :t REMOVE #err",
        ExpressionAttributeNames={"#st": "status", "#err": "error"},
        ExpressionAttributeValues={":extracting": "EXTRACTING", ":t": transcript},
    )

    payload = {
        WORKER_FLAG: True,
        "encounter_id": encounter_id,
        "user_id": user_id,
        "source_ip": source_ip,
    }
    try:
        lambda_client.invoke(
            FunctionName=context.function_name,
            InvocationType="Event",
            Payload=json.dumps(payload).encode(),
        )
    except Exception as e:  # noqa: BLE001
        # Falling back to inline keeps a short transcript working even if
        # the self-invoke permission is missing; a long one will still 504,
        # but the record is left in a state the client can poll.
        result = _run_extraction(encounter_id, user_id, source_ip)
        return ok({"encounter_id": encounter_id, **result})

    log_audit_event(
        user_id=user_id,
        action="UPDATE",
        encounter_id=encounter_id,
        resource="encounters.pcr",
        payload={"status": "EXTRACTING", "transcript_chars": len(transcript)},
        source_ip=source_ip,
    )

    return ok({"encounter_id": encounter_id, "status": "EXTRACTING"}, status=202)
