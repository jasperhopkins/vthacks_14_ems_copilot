"""
Module 4: Drug reference / interaction database

POST /drug/lookup              { "drug_name": "epinephrine" }
POST /drug/check-interaction   { "drugs": ["epinephrine", "propranolol"] }

Design note: this is the shared data source the protocol assistant (module
2) and the PCR module (module 1, via the auto interaction cross-check in
pcr/status.py) both read from, which is what makes this "one platform"
instead of four demos. The lookup/normalization/interaction rules
themselves live in the common layer (common/drugs.py) precisely so the PCR
pipeline and these endpoints can't drift apart.
"""
import json
from common.audit import log_audit_event
from common.drugs import check_interactions, get_drug
from common.responses import ok, error, get_user_id


def lookup_handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        drug_name = body["drug_name"]
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    record = get_drug(drug_name)
    if not record:
        return ok({"found": False, "drug_name": drug_name})

    log_audit_event(
        user_id=user_id,
        action="DRUG_LOOKUP",
        encounter_id=body.get("encounter_id", "N/A"),
        resource="drug_reference",
        payload={"drug_name": drug_name},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )
    return ok({"found": True, "drug": record})


def interaction_handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        drug_names = body["drugs"]
        if len(drug_names) < 2:
            return error("Provide at least two drugs to check.")
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    flags = check_interactions(drug_names)

    log_audit_event(
        user_id=user_id,
        action="DRUG_INTERACTION_CHECK",
        encounter_id=body.get("encounter_id", "N/A"),
        resource="drug_reference",
        payload={"drugs": drug_names, "flags_found": len(flags)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({"drugs": drug_names, "flags": flags, "safe": len(flags) == 0})
