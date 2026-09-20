"""
Module 2: Protocol / dosage assistant

Deliberately NOT a diagnostic tool. It answers "what does our protocol say
for X" and "what's the weight-based dose for Y" by retrieving from a
curated protocol/dosage dataset (DynamoDB) and having Bedrock summarize the
match -- it never free-generates a dosage from model knowledge alone. This
keeps the liability story sane for a hackathon demo: the model's job is
retrieval + phrasing, not clinical judgment.

Retrieval scoring lives in `common/protocol_search.py`, which imports no
boto3 so it can be tested offline (`infra/tests/test_protocol_search.py`).
It sits in the common layer because the hands-free agent
(`src/agent/tools.py`) ranks with the identical scorer -- a spoken question
and a typed one must not retrieve different guidelines.

POST /protocol/query
  { "query": "epinephrine dose for anaphylaxis, adult", "patient_weight_kg": 80 }
"""
import json
import os
import uuid
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id
from common import protocol_search as search

dynamodb = boto3.resource("dynamodb")
bedrock = boto3.client("bedrock-runtime")

PROTOCOL_TABLE = os.environ.get("PROTOCOL_TABLE_NAME", "ems-copilot-protocols")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")
protocol_table = dynamodb.Table(PROTOCOL_TABLE)

NO_MATCH_ANSWER = (
    "No protocol in the database matches that query. Do not treat this as "
    "'nothing applies' -- it means this tool has nothing to offer here. "
    "Consult your agency protocol directly or contact medical control."
)

ANSWER_PROMPT = """You are helping an EMT quickly find the right protocol \
entry. You are given the candidate protocol records that a keyword search \
already retrieved from the curated database, and the EMT's query. Answer \
only from these records.

If patient weight is given and the matched record has a per-kg dosage \
formula, compute the exact dose.

Rules:
- Only use information present in the candidate records below. Do not add \
dosages, indications or contraindications from your own knowledge, even if \
you are confident they are correct.
- Lead with the single best match. If a second record is genuinely also \
relevant, mention it in one clause -- do not pad the answer with weak matches.
- If none of the candidates actually answer the query, say so plainly and \
tell the EMT to consult their agency protocol or medical control. A wrong \
protocol confidently delivered is worse than "not found".
- Always include the protocol reference ID so the EMT can verify it.
- The `symptoms` and `synonyms` fields exist to help the search match how \
EMTs phrase things. They are not diagnostic criteria -- never tell the EMT \
what the patient has, only which protocol matches what they described.

Candidate records (`score` is the search's own 0-1 confidence, not a \
clinical judgment):
{candidates}

EMT query: "{query}"
Patient weight (kg): {weight}

Respond in 3-5 short sentences, EMT-radio style.
"""


def _load_protocols():
    """Scan the (small) protocol table.

    Fine at seed scale and already the documented first thing to replace --
    move to a Bedrock Knowledge Base or OpenSearch once this table grows
    past a few hundred rows. Ranking happens in `search.search`.
    """
    return protocol_table.scan(Limit=200).get("Items", [])


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        query = body["query"]
        weight = body.get("patient_weight_kg")
        encounter_id = body.get("encounter_id") or str(uuid.uuid4())
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    candidates = search.search(query, _load_protocols())

    def _audit(matched_ids):
        # Logged on every path including the no-match one: the protocol
        # table was read either way, and "what did this EMT ask that we had
        # no answer for" is exactly what the audit trail should preserve.
        log_audit_event(
            user_id=user_id,
            action="READ",
            encounter_id=encounter_id,
            resource="protocols",
            payload={"query": query, "weight": weight, "matched_ids": matched_ids},
            source_ip=source_ip,
        )

    if not candidates:
        _audit([])
        return ok({"answer": NO_MATCH_ANSWER, "matches": []})

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

    _audit([c.get("protocol_id") for c in candidates])

    return ok({"answer": answer_text, "matches": candidates})
