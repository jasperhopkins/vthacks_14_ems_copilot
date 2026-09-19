"""
Live-transcription step 2 of 3: the poll target that grows the transcript.

  GET /pcr/{encounter_id}/live
    -> { "status": "RECORDING", "chunks": [{seq, status, text}, ...],
         "transcript": "...", "pending": 2, "all_done": false }

Each call checks the chunks still marked PENDING, pulls the finished ones
out of S3, and writes the text back onto that chunk's map entry -- so the
work is done once and every later poll is a single DynamoDB read. The app
polls this while the EMT is still talking, which is what makes the
transcript appear to stream.

Two deliberate limits:

  - HARVEST_LIMIT caps how many chunks one request will resolve. API
    Gateway HTTP APIs cut integrations off at 30s and that ceiling is not
    adjustable (same constraint that split app.py from status.py), so a
    backlog gets drained across consecutive polls instead of in one long
    request.
  - Writes are per-chunk UpdateItems on the individual map path, not a
    read-modify-write of the whole item, because POST /pcr/stream-chunk is
    concurrently adding new chunk keys to the same record.
"""
import json
import os
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

transcribe = boto3.client("transcribe")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
AUDIO_BUCKET = os.environ["AUDIO_BUCKET_NAME"]

encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

HARVEST_LIMIT = 10


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _chunk_transcript(transcript_key: str) -> str:
    obj = s3.get_object(Bucket=AUDIO_BUCKET, Key=transcript_key)
    result = json.loads(obj["Body"].read())
    return result["results"]["transcripts"][0]["transcript"].strip()


def _resolve(encounter_id: str, chunk: dict) -> dict:
    """Check one PENDING chunk's Transcribe job and, if it finished, write
    the text back. Returns the chunk as it now stands."""
    seq = _int(chunk.get("seq"))
    try:
        job = transcribe.get_transcription_job(
            TranscriptionJobName=chunk["job_name"]
        )["TranscriptionJob"]
        job_status = job["TranscriptionJobStatus"]
    except Exception as e:  # noqa: BLE001 -- a lost chunk must not sink the encounter
        return {**chunk, "status": "FAILED", "error": str(e)}

    if job_status in ("QUEUED", "IN_PROGRESS"):
        return chunk

    if job_status == "FAILED":
        resolved = {**chunk, "status": "FAILED", "text": None,
                    "error": job.get("FailureReason", "unknown")}
    else:
        try:
            resolved = {**chunk, "status": "DONE",
                        "text": _chunk_transcript(chunk["transcript_s3_key"])}
        except Exception as e:  # noqa: BLE001
            resolved = {**chunk, "status": "FAILED", "text": None, "error": str(e)}

    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression="SET chunks.#seq = :chunk",
        ExpressionAttributeNames={"#seq": str(seq)},
        ExpressionAttributeValues={":chunk": resolved},
    )
    return resolved


def handler(event, context):
    user_id = get_user_id(event)
    encounter_id = (event.get("pathParameters") or {}).get("encounter_id")
    if not encounter_id:
        return error("Missing encounter_id in path")

    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        # The first chunk creates the record, so a poll that beats it is
        # normal early on rather than an error.
        return ok({"encounter_id": encounter_id, "status": "RECORDING",
                   "chunks": [], "transcript": "", "pending": 0, "all_done": False})

    chunks = sorted((record.get("chunks") or {}).values(), key=lambda c: _int(c.get("seq")))

    harvested = 0
    resolved_chunks = []
    for chunk in chunks:
        if chunk.get("status") == "PENDING" and harvested < HARVEST_LIMIT:
            chunk = _resolve(encounter_id, chunk)
            harvested += 1
        resolved_chunks.append(chunk)

    if harvested:
        log_audit_event(
            user_id=user_id,
            action="READ",
            encounter_id=encounter_id,
            resource="encounters.pcr.chunk",
            payload={"resolved": harvested, "total": len(resolved_chunks)},
            source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
        )

    view = [
        {"seq": _int(c.get("seq")), "status": c.get("status"), "text": c.get("text")}
        for c in resolved_chunks
    ]
    pending = sum(1 for c in view if c["status"] == "PENDING")
    transcript = " ".join(c["text"] for c in view if c["status"] == "DONE" and c["text"])

    return ok({
        "encounter_id": encounter_id,
        "status": record.get("status", "RECORDING"),
        "chunks": view,
        "transcript": transcript,
        "pending": pending,
        "all_done": bool(view) and pending == 0,
    })
