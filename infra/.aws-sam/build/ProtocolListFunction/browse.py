"""
Browse endpoints for the protocol library.

    GET /protocol/list              -> every guideline, list-card shaped
    GET /protocol/{protocol_id}     -> one guideline, in full

Search (`POST /protocol/query`) answers "what do I do for this patient".
These answer "what's in here at all" -- which matters now that the table
holds 71 NASEMSO guidelines rather than three demo rows, and a medic can no
longer be expected to guess what exists.

The split is about payload, not tidiness. The full set is ~400 KB because
every record carries verbatim steps, assessment and safety text; sending
that so a medic can scroll a list of titles would be slow on the worst
connection this app is meant to work on. The list projects only what a card
renders and the detail call fetches the rest.
"""
import json
import os
import re
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

dynamodb = boto3.resource("dynamodb")
PROTOCOL_TABLE = os.environ.get("PROTOCOL_TABLE_NAME", "ems-copilot-protocols")
protocol_table = dynamodb.Table(PROTOCOL_TABLE)

# What a list card needs, and nothing else.
CARD_FIELDS = ["protocol_id", "title", "category", "source_page"]
SUMMARY_CHARS = 140


def _card(item: dict) -> dict:
    card = {k: item.get(k) for k in CARD_FIELDS}
    # Several guidelines number their inclusion criteria, so the verbatim
    # text opens with "1. ". Fine in the detail view, reads like a rendering
    # bug on a one-line card.
    indications = re.sub(r"^\s*1\.\s*", "", (item.get("indications") or "").strip())
    card["summary"] = (
        indications[:SUMMARY_CHARS].rstrip() + "…"
        if len(indications) > SUMMARY_CHARS else indications
    )
    card["step_count"] = len(item.get("steps") or [])
    return card


def _scan_all() -> list:
    """Every protocol row, following pagination.

    `scan(Limit=200)` elsewhere caps *items evaluated per page*, not total,
    so it quietly returns a partial table once the data outgrows one page.
    A browse list that silently omits guidelines is worse than a slow one.
    """
    items, kwargs = [], {}
    while True:
        resp = protocol_table.scan(**kwargs)
        items.extend(resp.get("Items", []))
        key = resp.get("LastEvaluatedKey")
        if not key:
            return items
        kwargs["ExclusiveStartKey"] = key


def list_handler(event, context):
    user_id = get_user_id(event)
    try:
        items = _scan_all()
    except Exception as e:  # noqa: BLE001
        return error(f"Could not load protocols: {e}", status=502)

    cards = sorted(
        (_card(i) for i in items),
        key=lambda c: (str(c.get("category") or ""), str(c.get("title") or "")),
    )
    categories = sorted({c["category"] for c in cards if c.get("category")})

    log_audit_event(
        user_id=user_id,
        action="READ",
        encounter_id="N/A",   # browsing the library isn't tied to a patient
        resource="protocols",
        payload={"view": "list", "count": len(cards)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )
    return ok({"protocols": cards, "categories": categories, "count": len(cards)})


def detail_handler(event, context):
    user_id = get_user_id(event)
    protocol_id = (event.get("pathParameters") or {}).get("protocol_id")
    if not protocol_id:
        return error("Missing protocol_id")

    try:
        item = protocol_table.get_item(Key={"protocol_id": protocol_id}).get("Item")
    except Exception as e:  # noqa: BLE001
        return error(f"Could not load protocol: {e}", status=502)
    if not item:
        return error("Protocol not found", status=404)

    log_audit_event(
        user_id=user_id,
        action="READ",
        encounter_id="N/A",
        resource="protocols",
        payload={"view": "detail", "protocol_id": protocol_id},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )
    return ok({"protocol": json.loads(json.dumps(item, default=str))})
