"""
Append-only audit logging helper.

Every module (PCR, protocol/dosage, translate, drug lookup) calls
log_audit_event() on every read AND write of encounter data. This is the
core of the "audit trail as a first-class problem" requirement:

- Records are written with a composite key (encounter_id + timestamp#uuid)
  so they can never overwrite each other.
- The IAM role attached to these Lambdas is granted dynamodb:PutItem on the
  audit table but NOT UpdateItem / DeleteItem (see template.yaml). That's
  what makes it actually append-only, not just "a table we don't update."
- We never write raw PHI into the audit record itself -- only metadata
  (who, what action, which encounter, when, and a hash of the payload so
  you can prove later that a record wasn't tampered with without storing
  the PHI twice).
"""
import hashlib
import json
import os
import time
import uuid
import boto3

dynamodb = boto3.resource("dynamodb")
AUDIT_TABLE_NAME = os.environ.get("AUDIT_TABLE_NAME", "ems-copilot-audit-log")
audit_table = dynamodb.Table(AUDIT_TABLE_NAME)


def _hash_payload(payload: dict) -> str:
    """SHA-256 of the canonical JSON payload, so we can detect tampering
    without storing the PHI itself in the audit trail."""
    canonical = json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def log_audit_event(
    *,
    user_id: str,
    action: str,
    encounter_id: str,
    resource: str,
    payload: dict | None = None,
    source_ip: str | None = None,
):
    """
    action: one of "CREATE" | "READ" | "UPDATE" (UPDATE should really be a
            new versioned record in the encounters table, not a mutation --
            see encounters.py) | "DRUG_LOOKUP" | "TRANSLATE" | etc.
    resource: which module/table this touches, e.g. "encounters", "drug_reference"
    payload: the data involved -- we store only a hash of it here, never the
             raw content, to avoid duplicating PHI into the audit trail.
    """
    item = {
        "encounter_id": encounter_id,
        "sort_key": f"{int(time.time() * 1000)}#{uuid.uuid4()}",
        "user_id": user_id,
        "action": action,
        "resource": resource,
        "timestamp": int(time.time() * 1000),
        "payload_hash": _hash_payload(payload) if payload else None,
        "source_ip": source_ip,
    }
    audit_table.put_item(Item={k: v for k, v in item.items() if v is not None})
    return item
