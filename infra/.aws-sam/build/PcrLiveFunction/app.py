"""
Module 1, step 2 of 3: start the transcription job.

  POST /pcr/generate  { "s3_key": "audio/<sub>/<uuid>.m4a", "encounter_id": "..." }
    -> 202 { "encounter_id": ..., "status": "PROCESSING" }

The client then polls GET /pcr/{encounter_id} (status.py) until the status
is COMPLETE or FAILED.

Why this is async instead of one synchronous call: API Gateway HTTP APIs
cap integration time at 30 seconds, and unlike the REST API's limit that
one is NOT adjustable. Amazon Transcribe regularly needs longer than that
even for a 20-second clip, so polling Transcribe inside this request (what
the first draft of this file did) hands the app a 504 before the job lands,
no matter how high Globals.Function.Timeout is set. Splitting start from
poll keeps every request comfortably short and needs no EventBridge rule.
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

# Transcribe rejects anything outside this set. Expo's HIGH_QUALITY recording
# preset produces .m4a on both iOS and Android.
ALLOWED_MEDIA_FORMATS = {"amr", "flac", "m4a", "mp3", "mp4", "ogg", "webm", "wav"}


def _media_format(s3_key: str) -> str:
    ext = s3_key.rsplit(".", 1)[-1].lower() if "." in s3_key else ""
    return ext if ext in ALLOWED_MEDIA_FORMATS else "mp4"


def _job_name(encounter_id: str) -> str:
    """Transcribe job names must be unique per account and are limited to
    [0-9a-zA-Z._-]. Encounter IDs are ours, but sanitize anyway."""
    safe = re.sub(r"[^0-9a-zA-Z._-]", "-", encounter_id)[:150]
    return f"ems-pcr-{safe}-{uuid.uuid4().hex[:8]}"


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        s3_key = body["s3_key"]
        encounter_id = body.get("encounter_id") or str(uuid.uuid4())
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    job_name = _job_name(encounter_id)
    transcript_key = f"transcripts/{job_name}.json"

    job_args = {
        "TranscriptionJobName": job_name,
        "Media": {"MediaFileUri": f"s3://{AUDIO_BUCKET}/{s3_key}"},
        "MediaFormat": _media_format(s3_key),
        "LanguageCode": "en-US",
        "OutputBucketName": AUDIO_BUCKET,
        "OutputKey": transcript_key,
    }
    # The audio bucket has SSE-KMS default encryption with our CMK, so tell
    # Transcribe to write its output with that same key -- otherwise it tries
    # SSE-S3 against a bucket that requires the CMK and the job fails at the
    # very end, after the transcription work is already done.
    if KMS_KEY_ARN:
        job_args["OutputEncryptionKMSKeyId"] = KMS_KEY_ARN

    try:
        transcribe.start_transcription_job(**job_args)
    except Exception as e:  # noqa: BLE001 -- surface AWS-side failures to the app
        return error(f"Could not start transcription: {e}", status=500)

    record = {
        "encounter_id": encounter_id,
        "record_type": "PCR",
        "status": "PROCESSING",
        "created_by": user_id,
        "created_at": int(time.time() * 1000),
        "audio_s3_key": s3_key,
        "transcribe_job_name": job_name,
        "transcript_s3_key": transcript_key,
    }
    encounters_table.put_item(Item=record)

    log_audit_event(
        user_id=user_id,
        action="CREATE",
        encounter_id=encounter_id,
        resource="encounters.pcr",
        payload=record,
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({"encounter_id": encounter_id, "status": "PROCESSING"}, status=202)
