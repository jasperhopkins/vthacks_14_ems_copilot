"""
Live-transcription step 1 of 3: accept one short audio chunk and start a
transcription job for it.

  POST /pcr/stream-chunk  { "encounter_id": ..., "s3_key": ..., "seq": 3 }
    -> 202 { "encounter_id": ..., "seq": 3, "status": "PENDING" }

Why chunks at all: Amazon Transcribe's streaming API wants a continuous
WebSocket of raw PCM frames, and Expo Go can't produce those -- expo-audio
hands back a finished file only once stop() resolves, with no mid-recording
buffer callback. So the app records in short consecutive clips instead and
posts each one here the moment it lands; GET /pcr/{id}/live harvests the
results as they finish and the transcript grows in the UI a chunk at a
time. Transcript latency is roughly one chunk plus Transcribe's own job
turnaround, and a word can be clipped at a seam (the extraction prompt in
common/pcr.py is told to expect that). The alternative was a native PCM
module, which rules out Expo Go -- see the note in CLAUDE.md.

Concurrency note: chunk uploads overlap, so two invocations of this handler
can land on the same encounter at once. Chunk state therefore lives in a
DynamoDB *map* keyed by sequence number and is written with UpdateItem on
the individual map path -- concurrent writers touching different seq keys
don't clobber each other the way two read-modify-write PutItems would.
"""
import json
import os
import re
import time
import uuid
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

transcribe = boto3.client("transcribe")
dynamodb = boto3.resource("dynamodb")

ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
AUDIO_BUCKET = os.environ["AUDIO_BUCKET_NAME"]
KMS_KEY_ARN = os.environ.get("KMS_KEY_ARN")

encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

ALLOWED_MEDIA_FORMATS = {"amr", "flac", "m4a", "mp3", "mp4", "ogg", "webm", "wav"}


def _media_format(s3_key: str) -> str:
    ext = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else ""
    return ext if ext in ALLOWED_MEDIA_FORMATS else "mp4"


def _job_name(encounter_id: str, seq: int) -> str:
    safe = re.sub(r"[^0-9a-zA-Z._-]", "-", encounter_id)[:120]
    return f"ems-chunk-{safe}-{seq}-{uuid.uuid4().hex[:8]}"


def _ensure_encounter(encounter_id: str, user_id: str) -> None:
    """Create-or-leave-alone. Every chunk calls this; if_not_exists makes it
    idempotent, so chunk 0 and chunk 1 racing each other is harmless and we
    never need a read first."""
    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression=(
            "SET chunks = if_not_exists(chunks, :empty), "
            "record_type = if_not_exists(record_type, :pcr), "
            "created_by = if_not_exists(created_by, :user), "
            "created_at = if_not_exists(created_at, :now), "
            "capture_mode = if_not_exists(capture_mode, :mode), "
            "#st = if_not_exists(#st, :recording)"
        ),
        ExpressionAttributeNames={"#st": "status"},
        ExpressionAttributeValues={
            ":empty": {},
            ":pcr": "PCR",
            ":user": user_id,
            ":now": int(time.time() * 1000),
            ":mode": "CHUNKED",
            ":recording": "RECORDING",
        },
    )


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        s3_key = body["s3_key"]
        encounter_id = body["encounter_id"]
        seq = int(body["seq"])
    except (KeyError, ValueError, TypeError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    job_name = _job_name(encounter_id, seq)
    transcript_key = f"transcripts/{job_name}.json"

    job_args = {
        "TranscriptionJobName": job_name,
        "Media": {"MediaFileUri": f"s3://{AUDIO_BUCKET}/{s3_key}"},
        "MediaFormat": _media_format(s3_key),
        "LanguageCode": "en-US",
        "OutputBucketName": AUDIO_BUCKET,
        "OutputKey": transcript_key,
    }
    # Same reason as pcr/app.py: the bucket defaults to SSE-KMS with our
    # CMK, so Transcribe must write its output with that key or the job
    # fails at the very end, after the transcription work is already done.
    if KMS_KEY_ARN:
        job_args["OutputEncryptionKMSKeyId"] = KMS_KEY_ARN

    _ensure_encounter(encounter_id, user_id)

    try:
        transcribe.start_transcription_job(**job_args)
    except Exception as e:  # noqa: BLE001 -- surface AWS-side failures to the app
        return error(f"Could not start transcription for chunk {seq}: {e}", status=500)

    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression="SET chunks.#seq = :chunk",
        ExpressionAttributeNames={"#seq": str(seq)},
        ExpressionAttributeValues={
            ":chunk": {
                "seq": seq,
                "status": "PENDING",
                "job_name": job_name,
                "transcript_s3_key": transcript_key,
                "audio_s3_key": s3_key,
                "text": None,
            }
        },
    )

    log_audit_event(
        user_id=user_id,
        action="CREATE",
        encounter_id=encounter_id,
        resource="encounters.pcr.chunk",
        payload={"seq": seq, "s3_key": s3_key, "job_name": job_name},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({"encounter_id": encounter_id, "seq": seq, "status": "PENDING"}, status=202)
