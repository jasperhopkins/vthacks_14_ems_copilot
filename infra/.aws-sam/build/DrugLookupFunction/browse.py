"""
Browse endpoints for the drug reference.

    GET /drug/list           -> every real drug record, list-card shaped
    GET /drug/interactions   -> every flagged pair in the formulary

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
from common.drugs import all_interactions
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


def interactions_handler(event, context):
    """Every contraindicated pair the four rule layers can find.

    Computed from one scan rather than by resolving names: asking
    `check_interactions` for all 2,346 pairs would be 69 DynamoDB reads to
    answer a question the scan already has the data for. At formulary scale
    the pairing itself is pure in-memory work.

    Recomputed per request rather than stored. The rules live in four
    places that refresh independently (curated edits, `--refresh-classes`,
    `--refresh-labels`), and a cached pair list is one more thing that can
    silently disagree with what the interaction check actually does.
    """
    user_id = get_user_id(event)
    try:
        items = _scan_all()
    except Exception as e:  # noqa: BLE001
        return error(f"Could not load drug reference: {e}", status=502)

    flags = all_interactions(items)
    log_audit_event(
        user_id=user_id,
        action="DRUG_INTERACTION_CHECK",
        encounter_id="N/A",
        resource="drug_reference",
        payload={"view": "all", "flags_found": len(flags)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )
    return ok({
        "interactions": flags,
        "count": len(flags),
        "drugs_checked": len([i for i in items if not i.get("alias_of")]),
    })


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
            # Any of the four rule layers is reason to show the warning
            # badge; the detail view says which one.
            "has_interactions": bool(row.get("contraindicated_with")
                                     or row.get("contraindicated_classes")
                                     or row.get("curated_contraindicated_classes")
                                     or row.get("label_contraindications")),
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
