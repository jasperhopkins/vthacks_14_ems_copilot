"""
GET /translate/languages

The app does not hardcode the language list. It asks for it, because the
list is an intersection of what four services independently support and
the codes they disagree on (see common/languages.py) -- a second copy in
JavaScript is a copy that drifts, and the way it would drift is a chip on
screen for a language the backend then refuses, or a Transcribe locale the
websocket rejects at handshake time.

Cheap enough to call on screen mount: no AWS calls, no table read.
"""
from common.audit import log_audit_event
from common.languages import catalog
from common.responses import ok, get_user_id


def list_handler(event, context):
    user_id = get_user_id(event)
    languages = catalog()

    log_audit_event(
        user_id=user_id,
        action="LIST_LANGUAGES",
        encounter_id="N/A",
        resource="translate",
        payload={"count": len(languages)},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({
        "languages": languages,
        # The app sends this as source_lang to get detection; naming it
        # here keeps the sentinel from being a magic string on both sides.
        "auto_detect_code": "auto",
    })
