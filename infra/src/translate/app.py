"""
Module 3: Medical-vocabulary translator

POST /translate
  { "text": "Where does it hurt?",
    "source_lang": "en",      # or "auto" to detect it
    "target_lang": "es",
    "speak": true }

Two directions, one endpoint:

  medic -> patient   source_lang "en", target_lang picked on screen
  patient -> medic   source_lang "auto", target_lang "en"

The second direction is the whole point of the feature: a medic who does
not know what language the patient is speaking cannot pick a "from"
language off a list. Detection runs through Amazon Comprehend
(DetectDominantLanguage).

Comprehend is called explicitly rather than by passing
SourceLanguageCode="auto" to Amazon Translate, even though Translate's auto
mode calls the same service underneath, because the explicit call returns
the confidence score and Translate's does not. A language guessed at 0.42
and a language known at 0.99 must not render identically in front of a
medic -- see LOW_CONFIDENCE below -- and an unsupported detection has to
produce "I don't speak Hungarian" rather than a silent failure. Both need
the score, so the detection is visible instead of implicit.

Translate and Polly are both on AWS's HIPAA-eligible list; Comprehend
(non-medical) is too. See docs/HIPAA_NOTES.md.
"""
import base64
import json
import boto3
from common.audit import log_audit_event
from common.languages import (
    BY_CODE,
    is_supported,
    normalize_detected,
    voice_for,
)
from common.responses import ok, error, get_user_id

translate = boto3.client("translate")
polly = boto3.client("polly")
comprehend = boto3.client("comprehend")

#: Below this, the app shows the detection as uncertain and offers the
#: runner-up. Chosen from measurement, not taste: full sentences in all 16
#: supported languages score 0.86-1.00 (see infra/tests/test_languages.py),
#: so anything under 0.70 is not a slightly-worse detection, it is a
#: different situation -- usually a two-word utterance or code-switching.
LOW_CONFIDENCE = 0.70

#: Comprehend charges per 100 characters with a 3-character floor and gets
#: no more accurate on a whole paragraph than on its opening. Detection
#: reads the head of the text; translation still gets all of it.
DETECT_SAMPLE_CHARS = 1000


def _detect(text: str) -> dict:
    """{code, confidence, supported, alternatives} for the dominant language."""
    resp = comprehend.detect_dominant_language(Text=text[:DETECT_SAMPLE_CHARS])
    ranked = sorted(resp.get("Languages", []), key=lambda l: -l["Score"])
    if not ranked:
        return {"code": None, "confidence": 0.0, "supported": False, "alternatives": []}

    best = ranked[0]
    code = normalize_detected(best["LanguageCode"])
    return {
        "code": code,
        "confidence": round(best["Score"], 4),
        "supported": is_supported(code),
        # Only supported runner-ups: offering the medic a language the app
        # cannot then translate is a dead end on screen.
        "alternatives": [
            {
                "code": normalize_detected(l["LanguageCode"]),
                "label": BY_CODE[normalize_detected(l["LanguageCode"])]["label"],
                "confidence": round(l["Score"], 4),
            }
            for l in ranked[1:4]
            if is_supported(normalize_detected(l["LanguageCode"]))
        ],
    }


def _speak(text: str, lang: str):
    """base64 mp3, or None when Polly has no voice for this language."""
    chosen = voice_for(lang)
    if not chosen:
        return None
    voice_id, engine, polly_lang = chosen
    kwargs = {
        "Text": text,
        "OutputFormat": "mp3",
        "VoiceId": voice_id,
        # Explicit: Polly defaults to the standard engine, and several of
        # the voices in the table are neural-only -- Hala and Kajal have no
        # standard engine at all, so omitting this 400s rather than
        # quietly sounding worse.
        "Engine": engine,
    }
    # Hindi and Arabic are bilingual voices filed under another locale
    # (Kajal is an en-IN voice that also speaks hi-IN). Without the
    # language code they read the text with the wrong phonology.
    if polly_lang:
        kwargs["LanguageCode"] = polly_lang
    speech = polly.synthesize_speech(**kwargs)
    return base64.b64encode(speech["AudioStream"].read()).decode("utf-8")


def handler(event, context):
    user_id = get_user_id(event)
    try:
        body = json.loads(event.get("body") or "{}")
        text = (body.get("text") or "").strip()
        source_lang = body.get("source_lang", "en")
        target_lang = body["target_lang"]
        want_audio = body.get("speak", True)
        encounter_id = body.get("encounter_id", "N/A")
    except (KeyError, json.JSONDecodeError) as e:
        return error(f"Invalid request: {e}")

    if not text:
        return error("Nothing to translate.")
    if not is_supported(target_lang):
        return error(f"Unsupported target language: {target_lang}")

    detection = None
    if source_lang == "auto":
        detection = _detect(text)
        if not detection["code"]:
            return error("Could not identify the language of that speech.")
        if not detection["supported"]:
            # Named, not just refused: "that sounded like Hungarian, which
            # this app does not translate" tells a medic to call a phone
            # interpreter. "Unsupported language" tells them nothing.
            return error(
                f"Detected language '{detection['code']}', which this translator "
                "does not support."
            )
        source_lang = detection["code"]
    elif not is_supported(source_lang):
        return error(f"Unsupported source language: {source_lang}")

    if source_lang == target_lang:
        translated_text = text
    else:
        result = translate.translate_text(
            Text=text,
            SourceLanguageCode=source_lang,
            TargetLanguageCode=target_lang,
        )
        translated_text = result["TranslatedText"]

    audio_b64 = _speak(translated_text, target_lang) if want_audio else None

    log_audit_event(
        user_id=user_id,
        action="TRANSLATE",
        encounter_id=encounter_id,
        resource="translate",
        payload={
            "source_lang": source_lang,
            "target_lang": target_lang,
            "detected": bool(detection),
            "detection_confidence": detection["confidence"] if detection else None,
            "text": text,
        },
        source_ip=event.get("requestContext", {}).get("http", {}).get("sourceIp"),
    )

    return ok({
        "translated_text": translated_text,
        "source_lang": source_lang,
        "source_label": BY_CODE[source_lang]["label"],
        "target_lang": target_lang,
        "target_label": BY_CODE[target_lang]["label"],
        "detected": detection is not None,
        "detection_confidence": detection["confidence"] if detection else None,
        "detection_uncertain": bool(detection and detection["confidence"] < LOW_CONFIDENCE),
        "detection_alternatives": detection["alternatives"] if detection else [],
        "can_speak": voice_for(target_lang) is not None,
        "audio_base64_mp3": audio_b64,
    })
