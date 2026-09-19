"""
Module 3: Medical-vocabulary translator

POST /translate
  { "text": "Where does it hurt?", "source_lang": "en", "target_lang": "es", "speak": true }

Uses Amazon Translate for the text and, if "speak" is true, synthesizes
audio with Amazon Polly so the EMT can play it aloud without needing to
pronounce the translation themselves. Both services are on AWS's
HIPAA-eligible list (see docs/HIPAA_NOTES.md) -- but note patient speech
going *in* the other direction (patient's spoken reply) would need to go
through Transcribe with target_lang detection before this step; that's the
"stretch goal" direction if you have time.
"""
import base64
import json
import os
import boto3
from common.audit import log_audit_event
from common.responses import ok, error, get_user_id

translate = boto3.client("translate")
polly = boto3.client("polly")

# Very small map of language -> a reasonable Polly voice. Expand as needed.
POLLY_VOICE_BY_LANG = {
    "es": "Lupe",
    "fr": "Lea",
    "zh": "Zhiyu",
    "vi": "N/A",  # Polly has no Vietnamese voice as of writing -- text-only fallback
    "ar": "Zeina",
    "en": "Joanna",
}


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        text = body["text"]
        source_lang = body.get("source_lang", "en")
        target_lang = body["target_lang"]
        want_audio = body.get("speak", True)
        encounter_id = body.get("encounter_id", "N/A")
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    result = translate.translate_text(
        Text=text, SourceLanguageCode=source_lang, TargetLanguageCode=target_lang
    )
    translated_text = result["TranslatedText"]

    audio_b64 = None
    voice = POLLY_VOICE_BY_LANG.get(target_lang)
    if want_audio and voice and voice != "N/A":
        speech = polly.synthesize_speech(
            Text=translated_text, OutputFormat="mp3", VoiceId=voice
        )
        audio_b64 = base64.b64encode(speech["AudioStream"].read()).decode("utf-8")

    log_audit_event(
        user_id=user_id,
        action="TRANSLATE",
        encounter_id=encounter_id,
        resource="translate",
        payload={"source_lang": source_lang, "target_lang": target_lang, "text": text},
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({
        "translated_text": translated_text,
        "audio_base64_mp3": audio_b64,
    })
