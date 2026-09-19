"""
The durable PCR store: committing a reviewed draft, and listing/searching
what a user has committed.

  POST /pcr/{encounter_id}/commit  { "pcr": {...}, "crew_notes": "..." }
    -> { "status": "SAVED", "saved_at": ..., "pcr": {...}, "interaction_flags": [...] }

  GET /pcr/saved?q=&flagged=&from=&to=&limit=&cursor=
    -> { "records": [ {encounter_id, saved_at, chief_complaint, ...} ], "cursor": ... }

Commit is the line between "the model's reading of what I said" and "my
chart". Finalize writes a DRAFT; only this handler sets saved_at, and
saved_at is the sort key of the ByUserSaved index -- a sparse GSI, so
drafts and failed encounters are physically absent from the list rather
than filtered out of it.

Committing re-runs the drug cross-check against the *edited* medication
lists rather than reusing the draft's flags. Correcting a drug the model
misheard has to be able to change the interactions, otherwise review would
be cosmetic.

Re-committing an existing record is allowed and overwrites in place (same
encounter_id key). The audit trail, not the encounters table, is what
preserves the history of who changed what and when.
"""
import base64
import json
import os
import time
from decimal import Decimal
import boto3
from boto3.dynamodb.conditions import Attr, Key
from common.audit import log_audit_event
from common.pcr import build_summary_attrs, cross_check, normalize_pcr
from common.responses import ok, error, get_user_id

dynamodb = boto3.resource("dynamodb")
ENCOUNTERS_TABLE = os.environ.get("ENCOUNTERS_TABLE_NAME", "ems-copilot-encounters")
BY_USER_INDEX = os.environ.get("ENCOUNTERS_BY_USER_INDEX", "ByUserSaved")
encounters_table = dynamodb.Table(ENCOUNTERS_TABLE)

DEFAULT_LIMIT = 25
MAX_LIMIT = 100
# A FilterExpression is applied after the read, so a filtered page can come
# back nearly empty while more matches sit further down the index. Walk a
# bounded number of pages to fill the page the app asked for instead of
# handing it a short list that looks like the end of the results.
MAX_PAGES = 5


def _int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _plain(value):
    """DynamoDB hands back Decimal for every number; json.dumps(default=str)
    would turn those into quoted strings and the app would render "3" where
    it expects 3."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


# ---------------------------------------------------------------------
# POST /pcr/{encounter_id}/commit
# ---------------------------------------------------------------------

def commit_handler(event, context):
    user_id = get_user_id(event)
    source_ip = event.get("requestContext", {}).get("http", {}).get("sourceIp")
    encounter_id = (event.get("pathParameters") or {}).get("encounter_id")
    if not encounter_id:
        return error("Missing encounter_id in path")

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError as e:
        return error(f"Invalid request: {e}")

    record = encounters_table.get_item(Key={"encounter_id": encounter_id}).get("Item")
    if not record:
        return error(f"No encounter {encounter_id}", status=404)
    if record.get("created_by") not in (user_id, None):
        return error("Not your encounter", status=403)

    # Fall back to the draft the pipeline produced if the app posts no
    # edits, so "review and accept as-is" needs no special case.
    edited = body.get("pcr")
    structured = normalize_pcr(_plain(edited if isinstance(edited, dict) else record.get("structured_pcr") or {}))

    _, interaction_flags = cross_check(structured)
    saved_at = int(time.time() * 1000)
    summary = build_summary_attrs(structured, interaction_flags)
    crew_notes = (body.get("crew_notes") or "").strip() or None

    update = {
        "status": "SAVED",
        "saved_at": saved_at,
        "structured_pcr": structured,
        "interaction_flags": interaction_flags,
        "committed_by": user_id,
        "crew_notes": crew_notes,
        "edited": bool(isinstance(edited, dict) and edited != _plain(record.get("structured_pcr") or {})),
        **summary,
    }
    names = {f"#k{i}": k for i, k in enumerate(update)}
    values = {f":v{i}": v for i, v in enumerate(update.values())}
    encounters_table.update_item(
        Key={"encounter_id": encounter_id},
        UpdateExpression="SET " + ", ".join(f"#k{i} = :v{i}" for i in range(len(update))),
        ExpressionAttributeNames=names,
        ExpressionAttributeValues=values,
    )

    log_audit_event(
        user_id=user_id,
        action="COMMIT",
        encounter_id=encounter_id,
        resource="encounters.pcr",
        payload={"structured_pcr": structured, "crew_notes": crew_notes,
                 "edited": update["edited"], "saved_at": saved_at},
        source_ip=source_ip,
    )

    return ok({
        "encounter_id": encounter_id,
        "status": "SAVED",
        "saved_at": saved_at,
        "pcr": structured,
        "interaction_flags": interaction_flags,
    })


# ---------------------------------------------------------------------
# GET /pcr/saved
# ---------------------------------------------------------------------

def _encode_cursor(key: dict | None) -> str | None:
    if not key:
        return None
    return base64.urlsafe_b64encode(json.dumps(_plain(key)).encode()).decode()


def _decode_cursor(cursor: str | None) -> dict | None:
    if not cursor:
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except Exception:  # noqa: BLE001 -- a stale cursor just means start over
        return None


def _summarize(item: dict) -> dict:
    return {
        "encounter_id": item.get("encounter_id"),
        "saved_at": _int(item.get("saved_at")),
        "created_at": _int(item.get("created_at")),
        "chief_complaint": item.get("summary_chief_complaint") or "Unspecified complaint",
        "patient_label": item.get("patient_label") or "Patient",
        "medications": _plain(item.get("summary_meds") or []),
        "flag_count": _int(item.get("flag_count")),
        "capture_mode": item.get("capture_mode") or "SINGLE",
    }


def list_handler(event, context):
    user_id = get_user_id(event)
    params = event.get("queryStringParameters") or {}

    limit = max(1, min(_int(params.get("limit"), DEFAULT_LIMIT), MAX_LIMIT))
    q = (params.get("q") or "").strip().lower()
    flagged_only = (params.get("flagged") or "").lower() in ("1", "true", "yes")
    since = _int(params.get("from"), 0)
    until = _int(params.get("to"), 0)

    key_cond = Key("created_by").eq(user_id)
    if since and until:
        key_cond = key_cond & Key("saved_at").between(since, until)
    elif since:
        key_cond = key_cond & Key("saved_at").gte(since)
    elif until:
        key_cond = key_cond & Key("saved_at").lte(until)

    filters = None
    if q:
        filters = Attr("search_text").contains(q)
    if flagged_only:
        flag_filter = Attr("flag_count").gt(0)
        filters = flag_filter if filters is None else filters & flag_filter

    query = {
        "IndexName": BY_USER_INDEX,
        "KeyConditionExpression": key_cond,
        "ScanIndexForward": False,   # newest first
        "Limit": limit,
    }
    if filters is not None:
        query["FilterExpression"] = filters

    start_key = _decode_cursor(params.get("cursor"))
    records, pages = [], 0
    while pages < MAX_PAGES:
        page = encounters_table.query(
            **query, **({"ExclusiveStartKey": start_key} if start_key else {})
        )
        records.extend(_summarize(item) for item in page.get("Items", []))
        start_key = page.get("LastEvaluatedKey")
        pages += 1
        if len(records) >= limit or not start_key:
            break

    overflow = records[limit:]
    records = records[:limit]
    # Trimming an over-full page means the cursor has to point at the last
    # row we actually returned, not at where the scan stopped.
    if overflow:
        last = records[-1]
        start_key = {"created_by": user_id, "encounter_id": last["encounter_id"],
                     "saved_at": last["saved_at"]}

    log_audit_event(
        user_id=user_id,
        action="READ",
        encounter_id="N/A",
        resource="encounters.pcr.list",
        payload={"q": q, "flagged": flagged_only, "returned": len(records)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({"records": records, "cursor": _encode_cursor(start_key), "count": len(records)})
