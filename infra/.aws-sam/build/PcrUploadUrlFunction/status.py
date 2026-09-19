"""
Poll target and detail view for a single encounter.

  GET /pcr/{encounter_id}
    -> { "status": "PROCESSING" }                       (job still running)
    -> { "status": "COMPLETE", "pcr": {...}, ... }      (single-file flow finished)
    -> { "status": "DRAFT",  "pcr": {...}, ... }        (chunked flow, awaiting review)
    -> { "status": "SAVED",  "pcr": {...}, "saved_at": ... }
    -> { "status": "FAILED", "error": "..." }

Two capture paths land here. The single-file flow (POST /pcr/generate ->
this handler polls Transcribe) is the original: the first poll that finds
Transcribe COMPLETED does the remaining work inline -- Bedrock field
extraction, then the drug cross-check -- and writes the finished record, so
every later poll is a cheap DynamoDB read. That tail runs in a few seconds,
well inside API Gateway's 30s ceiling; the transcription wait, which is the
part that blows the ceiling, happened across earlier polls.

The chunked live-transcription flow (chunk.py -> live.py -> finalize.py)
never enters the branch below -- it arrives already in DRAFT or SAVED --
but it reads back through this same endpoint, which is what the saved-PCR
detail screen calls.

The cross-check is the piece that makes this one platform instead of four
demos: mentioning two drugs out loud during the narration surfaces a
contraindication in the PCR itself, using the same table and the same rules
as the standalone /drug/check-interaction endpoint. It lives in
common/pcr.py so this path and finalize.py can't drift.
"""
import json
import os
import time
import boto3
from common.audit import log_audit_event
from common.pcr import cross_check, extract_structured_pcr
from common.responses import ok, error, get_user_id

transcribe = boto3.client("transcribe")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
AUDIO_BUCKET = os.environ["AUDIO_BUCKET_NAME"]

encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

# States the pipeline has already finished with, in one way or another --
# read them straight back instead of looking for a Transcribe job.
SETTLED_STATUSES = ("COMPLETE", "DRAFT", "SAVED")


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _fetch_transcript(transcript_key: str) -> str:
    obj = s3.get_object(Bucket=AUDIO_BUCKET, Key=transcript_key)
    result = json.loads(obj["Body"].read())
    return result["results"]["transcripts"][0]["transcript"]


def _read_back(record: dict) -> dict:
    return {
        "encounter_id": record["encounter_id"],
        "status": record.get("status"),
        "pcr": record.get("structured_pcr"),
        "transcript": record.get("transcript"),
        "interaction_flags": record.get("interaction_flags", []),
        "crew_notes": record.get("crew_notes"),
        "capture_mode": record.get("capture_mode", "SINGLE"),
        "created_at": _int(record.get("created_at")),
        "saved_at": _int(record.get("saved_at")) or None,
    }


def handler(event, context):
    user_id = get_user_id(event)
    encounter_id = (event.get("pathParameters") or {}).get("encounter_id")
    if not encounter_id:
        return error("Missing encounter_id in path")

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        return error(f"No encounter {encounter_id}", status=404)
    if record.get("created_by") not in (user_id, None):
        return error("Not your encounter", status=403)

    status = record.get("status")

    if status in SETTLED_STATUSES:
        log_audit_event(
            user_id=user_id, action="READ", encounter_id=encounter_id,
            resource="encounters.pcr", payload={"status": status}, source_ip=source_ip,
        )
        return ok(_read_back(record))
    if status == "FAILED":
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": record.get("error")})
    if status == "EXTRACTING":
        # finalize.py handed the Bedrock call to an async worker; the client
        # is polling here until it lands.
        return ok({"encounter_id": encounter_id, "status": "EXTRACTING"})
    if status == "RECORDING":
        # Chunked capture in progress; GET /pcr/{id}/live is the right poll
        # target for this one, not this handler.
        return ok({"encounter_id": encounter_id, "status": "RECORDING",
                   "chunk_count": len(record.get("chunks") or {})})

    job_name = record.get("transcribe_job_name")
    if not job_name:
        return error("Encounter has no transcription job on it", status=500)

    job = transcribe.get_transcription_job(TranscriptionJobName=job_name)["TranscriptionJob"]
    job_status = job["TranscriptionJobStatus"]

    if job_status in ("QUEUED", "IN_PROGRESS"):
        return ok({"encounter_id": encounter_id, "status": "PROCESSING"})

    if job_status == "FAILED":
        reason = job.get("FailureReason", "unknown")
        record.update({"status": "FAILED", "error": reason})
        encounters_table.put_item(Item=record)
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": reason})

    # COMPLETED -- finish the pipeline.
    try:
        transcript = _fetch_transcript(record["transcript_s3_key"])
        structured = extract_structured_pcr(transcript)
    except Exception as e:  # noqa: BLE001 -- surface pipeline errors to the app
        record.update({"status": "FAILED", "error": str(e)})
        encounters_table.put_item(Item=record)
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": str(e)}, status=200)

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

    record.update({
        "status": "COMPLETE",
        "completed_at": int(time.time() * 1000),
        "transcript": transcript,
        "structured_pcr": structured,
        "interaction_flags": interaction_flags,
    })
    encounters_table.put_item(Item=record)

    log_audit_event(
        user_id=user_id,
        action="UPDATE",
        encounter_id=encounter_id,
        resource="encounters.pcr",
        payload=record,
        source_ip=source_ip,
    )

    return ok({
        "encounter_id": encounter_id,
        "status": "COMPLETE",
        "pcr": structured,
        "transcript": transcript,
        "interaction_flags": interaction_flags,
    })
