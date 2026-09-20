"""
Browse endpoint for the drug reference.

    GET /drug/list   -> every real drug record, list-card shaped

`POST /drug/lookup` still serves the detail view: it already returns the
whole record, and for a canonical name picked off this list it resolves on
the literal key without ever reaching Comprehend Medical.

Alias rows are excluded. The table stores field slang as its own rows
({"drug_name": "epi", "alias_of": "epinephrine"}) so speech resolves, but
an EMT scrolling a reference wants seven drugs, not seven drugs and their
fifteen nicknames. The aliases ride along on each card instead, which is
also the answer to "what do I call this on the radio".
"""
import os
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

dynamodb = boto3.resource("dynamodb")
DRUG_TABLE = os.environ.get("DRUG_TABLE_NAME", "ems-copilot-drug-reference")
drug_table = dynamodb.Table(DRUG_TABLE)


def _scan_all() -> list:
    items, kwargs = [], {}
    while True:
        resp = drug_table.scan(**kwargs)
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
        return error(f"Could not load drug reference: {e}", status=502)

    aliases = {}
    for row in items:
        target = row.get("alias_of")
        if target:
            aliases.setdefault(str(target).lower(), []).append(str(row["drug_name"]))

    cards = []
    for row in items:
        if row.get("alias_of"):
            continue
        name = str(row.get("drug_name", ""))
        cards.append({
            "drug_name": name,
            "class": row.get("class"),
            "common_uses": row.get("common_uses") or [],
            "aliases": sorted(aliases.get(name.lower(), [])),
            # Enough for the card to warn without a second round trip.
            "has_interactions": bool(row.get("contraindicated_with")
                                     or row.get("contraindicated_classes")),
        })
    cards.sort(key=lambda c: c["drug_name"])

    log_audit_event(
        user_id=user_id,
        action="DRUG_LOOKUP",
        encounter_id="N/A",
        resource="drug_reference",
        payload={"view": "list", "count": len(cards)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )
    return ok({"drugs": cards, "count": len(cards)})
