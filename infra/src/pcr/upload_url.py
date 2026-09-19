"""
GET /pcr/upload-url?filename=encounter.m4a

Returns a presigned S3 PUT URL so the Expo app uploads audio directly to
S3 (never through a Lambda, to avoid base64-encoding a large payload
through API Gateway). The app then calls POST /pcr/generate with the
returned s3_key.

Two things here are load-bearing and easy to get wrong:

  - The S3 client is pinned to SigV4. Without it boto3 can hand back a
    SigV2 URL, whose string-to-sign includes Content-Type; any client that
    sends a different Content-Type than the signer assumed (urllib defaults
    to application/x-www-form-urlencoded, for instance) gets a 403
    SignatureDoesNotMatch that looks like a permissions problem.
  - Content-Type is signed and returned to the caller, so the client can
    echo back exactly what was signed instead of guessing.
"""
import os
import uuid
import boto3
from botocore.config import Config
from common.responses import ok, error, get_user_id

s3 = boto3.client("s3", config=Config(signature_version="s3v4"))
AUDIO_BUCKET = os.environ["AUDIO_BUCKET_NAME"]

CONTENT_TYPE_BY_EXT = {
    "m4a": "audio/m4a",
    "mp3": "audio/mpeg",
    "mp4": "audio/mp4",
    "wav": "audio/wav",
    "webm": "audio/webm",
    "ogg": "audio/ogg",
    "flac": "audio/flac",
    "amr": "audio/amr",
}


def handler(event, context):
    user_id = get_user_id(event)
    params = event.get("queryStringParameters") or {}
    filename = params.get("filename", "recording.m4a")
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "m4a"
    content_type = CONTENT_TYPE_BY_EXT.get(ext, "application/octet-stream")

    s3_key = f"audio/{user_id}/{uuid.uuid4()}.{ext}"
    url = s3.generate_presigned_url(
        "put_object",
        Params={"Bucket": AUDIO_BUCKET, "Key": s3_key, "ContentType": content_type},
        ExpiresIn=300,
    )
    # The caller MUST send this exact Content-Type on the PUT -- it's part
    # of the signature.
    return ok({"upload_url": url, "s3_key": s3_key, "content_type": content_type})
