"""
Module 2: Protocol / dosage assistant

Deliberately NOT a diagnostic tool. It answers "what does our protocol say
for X" and "what's the weight-based dose for Y" by retrieving from a
curated protocol/dosage dataset (DynamoDB) and having Bedrock summarize the
match -- it never free-generates a dosage from model knowledge alone. This
keeps the liability story sane for a hackathon demo: the model's job is
retrieval + phrasing, not clinical judgment.

POST /protocol/query
  { "query": "epinephrine dose for anaphylaxis, adult", "patient_weight_kg": 80 }
"""
import json
import os
import time
import uuid
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

dynamodb = boto3.resource("dynamodb")
bedrock = boto3.client("bedrock-runtime")

PROTOCOL_TABLE = os.environ.get("PROTOCOL_TABLE_NAME", "ems-copilot-protocols")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
protocol_table = dynamodb.Table(PROTOCOL_TABLE)

ANSWER_PROMPT = """You are helping an EMT quickly find the right protocol \
entry. You are given a small set of candidate protocol records (already \
retrieved from the curated database -- do not use outside knowledge) and \
the EMT's query. Pick the single best-matching record and answer concisely.

If patient weight is given and the matched record has a per-kg dosage \
formula, compute the exact dose.

Rules:
- Only use information present in the candidate records below.
- If nothing matches well, say so explicitly rather than guessing.
- Always include the protocol reference ID in your answer so it can be verified.

Candidate records:
{candidates}

EMT query: "{query}"
Patient weight (kg): {weight}

Respond in 3-5 short sentences, EMT-radio style.
"""


def _keyword_search(query: str, limit: int = 5):
    """Simple scan+filter for hackathon scope. Swap for a proper search
    (OpenSearch, or a Bedrock Knowledge Base / vector index) once you have
    more than a few hundred protocol entries."""
    resp = protocol_table.scan(Limit=200)
    items = resp.get("Items", [])
    q_terms = [t.lower() for t in query.split()]
    scored = []
    for item in items:
        haystack = json.dumps(item).lower()
        score = sum(1 for t in q_terms if t in haystack)
        if score > 0:
            scored.append((score, item))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [item for _, item in scored[:limit]]


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        query = body["query"]
        weight = body.get("patient_weight_kg")
        encounter_id = body.get("encounter_id") or str(uuid.uuid4())
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    candidates = _keyword_search(query)
    if not candidates:
        return ok({"answer": "No matching protocol found in the database.", "matches": []})

    prompt = ANSWER_PROMPT.format(
        candidates=json.dumps(candidates, default=str),
        query=query,
        weight=weight if weight is not None else "not provided",
    )
    resp = bedrock.converse(
        modelId=BEDROCK_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": prompt}]}],
        inferenceConfig={"maxTokens": 500, "temperature": 0},
    )
    answer_text = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])

    log_audit_event(
        user_id=user_id,
        action="READ",
        encounter_id=encounter_id,
        resource="protocols",
        payload={"query": query, "weight": weight, "matched_ids": [c.get("protocol_id") for c in candidates]},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({"answer": answer_text, "matches": candidates})
