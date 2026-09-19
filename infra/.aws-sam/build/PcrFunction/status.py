"""
Module 1, step 3 of 3: poll for the PCR, and finish the pipeline when the
transcript is ready.

  GET /pcr/{encounter_id}
    -> { "status": "PROCESSING" }                       (job still running)
    -> { "status": "COMPLETE", "pcr": {...}, "transcript": "...",
         "interaction_flags": [...] }                   (done)
    -> { "status": "FAILED", "error": "..." }

The first poll that finds Transcribe COMPLETED does the remaining work
inline -- Bedrock field extraction, then the drug cross-check -- and writes
the finished record, so every later poll is a cheap DynamoDB read. That
whole tail runs in a few seconds, well inside API Gateway's 30s ceiling;
the transcription wait, which is the part that blows the ceiling, happened
across earlier polls.

The cross-check is the piece that makes this one platform instead of four
demos: mentioning two drugs out loud during the narration surfaces a
contraindication in the PCR itself, using the same table and the same rules
as the standalone /drug/check-interaction endpoint.
"""
import json
import os
import time
import boto3
from common.audit import log_audit_event
from common.drugs import check_interactions
from common.responses import ok, error, get_user_id

transcribe = boto3.client("transcribe")
bedrock = boto3.client("bedrock-runtime")
s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
AUDIO_BUCKET = os.environ["AUDIO_BUCKET_NAME"]
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")

encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

PCR_EXTRACTION_PROMPT = """You are assisting an EMT by converting a spoken \
patient encounter narration into a structured Patient Care Report (PCR).

Extract the following fields from the transcript below. If a field was not \
mentioned, use null -- do not guess or invent clinical information.

Return ONLY valid JSON with this shape:
{{
  "chief_complaint": string | null,
  "vitals": {{"bp": string|null, "hr": string|null, "rr": string|null, "spo2": string|null, "gcs": string|null}},
  "interventions": [string],
  "medications_administered": [{{"name": string, "dose": string|null, "route": string|null}}],
  "patient_medications": [string],
  "narrative_summary": string
}}

"medications_administered" is what the EMT gave on this call. \
"patient_medications" is what the patient reports already taking (home \
medications, other providers' doses) -- list the drug names only. Both \
matter: interactions run across the two lists combined.

Transcript:
\"\"\"
{transcript}
\"\"\"
"""


def _fetch_transcript(transcript_key: str) -> str:
    obj = s3.get_object(Bucket=AUDIO_BUCKET, Key=transcript_key)
    result = json.loads(obj["Body"].read())
    return result["results"]["transcripts"][0]["transcript"]


def _extract_structured_pcr(transcript: str) -> dict:
    # Converse instead of invoke_model: it's the provider-agnostic Bedrock
    # API, so swapping BEDROCK_MODEL_ID between vendors is a parameter
    # change rather than a rewrite of the request body. temperature 0
    # because this is extraction -- we want the same transcript to produce
    # the same PCR, not a creative variation on it.
    resp = bedrock.converse(
        modelId=BEDROCK_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": PCR_EXTRACTION_PROMPT.format(transcript=transcript)}]}],
        inferenceConfig={"maxTokens": 2000, "temperature": 0},
    )
    text = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
    # Bedrock may wrap JSON in prose/code fences despite instructions -- extract defensively.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("Model did not return JSON")
    return json.loads(text[start:end + 1])


def _drugs_mentioned(structured: dict) -> list[str]:
    """Every drug name in the PCR, from both what we gave and what the
    patient is already on. De-duplicated, order preserved so the flags read
    in the order the EMT said them."""
    names = []
    for med in structured.get("medications_administered") or []:
        name = (med or {}).get("name") if isinstance(med, dict) else med
        if name:
            names.append(str(name).strip())
    for name in structured.get("patient_medications") or []:
        if name:
            names.append(str(name).strip())

    seen, unique = set(), []
    for name in names:
        if name.lower() not in seen:
            seen.add(name.lower())
            unique.append(name)
    return unique


def handler(event, context):
    user_id = get_user_id(event)
    encounter_id = (event.get("pathParameters") or {}).get("encounter_id")
    if not encounter_id:
        return error("Missing encounter_id in path")

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        return error(f"No encounter {encounter_id}", status=404)

    # Terminal states: just read it back.
    if record.get("status") == "COMPLETE":
        log_audit_event(
            user_id=user_id, action="READ", encounter_id=encounter_id,
            resource="encounters.pcr", payload={"status": "COMPLETE"}, source_ip=source_ip,
        )
        return ok({
            "encounter_id": encounter_id,
            "status": "COMPLETE",
            "pcr": record.get("structured_pcr"),
            "transcript": record.get("transcript"),
            "interaction_flags": record.get("interaction_flags", []),
        })
    if record.get("status") == "FAILED":
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": record.get("error")})

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
        structured = _extract_structured_pcr(transcript)
    except Exception as e:  # noqa: BLE001 -- surface pipeline errors to the app
        record.update({"status": "FAILED", "error": str(e)})
        encounters_table.put_item(Item=record)
        return ok({"encounter_id": encounter_id, "status": "FAILED", "error": str(e)}, status=200)

    # Cross-check every drug the narration mentioned against the same drug
    # reference table the standalone endpoint uses. Best-effort: a lookup
    # failure must not cost the EMT the PCR they just dictated.
    drugs = _drugs_mentioned(structured)
    interaction_flags = []
    if len(drugs) >= 2:
        try:
            interaction_flags = check_interactions(drugs)
        except Exception:  # noqa: BLE001
            interaction_flags = []
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
