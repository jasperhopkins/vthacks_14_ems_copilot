"""Small helpers so every Lambda returns consistent API Gateway HTTP API
(payload format 2.0) responses, with CORS headers for the Expo app."""
import json


def ok(body: dict, status: int = 200):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Authorization,Content-Type",
        },
        "body": json.dumps(body, default=str),
    }


def error(message: str, status: int = 400):
    return ok({"error": message}, status=status)


def get_user_id(event: dict) -> str:
    """Pull the Cognito sub (user id) out of the JWT authorizer context.
    Every handler MUST call this and pass it into log_audit_event -- an
    audit trail with no reliable user identity is not an audit trail."""
    try:
        claims = event["requestContext"]["authorizer"]["jwt"]["claims"]
        return claims["sub"]
    except KeyError:
        return "UNKNOWN_USER"
