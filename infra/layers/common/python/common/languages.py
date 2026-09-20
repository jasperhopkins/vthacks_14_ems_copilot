"""
The language table: one row per language the translator supports, carrying
every code the four services want for it.

There is one table because the four services do not agree on codes and the
disagreements are not guessable:

  * Amazon Translate wants ISO 639-1 ("zh", "pt").
  * Amazon Transcribe streaming wants a locale ("zh-CN", "pt-BR"), and
    *rejects* some plausible ones -- "cmn-CN" is not a Transcribe code even
    though it is Polly's code for the same language.
  * Amazon Polly has its own third spelling ("cmn-CN", "arb") plus an
    engine that must be named explicitly, and for Hindi the voice is filed
    under en-IN with hi-IN as an *additional* language, so the synth call
    needs both VoiceId and LanguageCode.
  * Amazon Comprehend returns ISO 639-1, which happens to match Translate.

Every code and voice/engine combination below was verified against the live
account -- a Transcribe websocket handshake per code, a Polly
synthesize_speech per voice, and an en -> L -> en Translate round trip.

`polly_voice: None` is a real, supported state, not a gap to fill in later:
Amazon Polly has no voice at all for Vietnamese, Tagalog or Haitian Creole,
all three of which are languages a US medic actually meets. Those languages
translate to text and the app shows the text; it just cannot speak it.

Deliberately NOT in the table
-----------------------------
Somali (so / so-SO) passes every capability check -- Transcribe streams it,
Comprehend detects it at 0.99, Translate accepts the pair -- and is still
excluded, because the round trip is wrong in a way that matters here:

    en -> so: "Are you having chest pain?"
    so -> en: "Do you have pain in the ankle?"

A translator that moves the pain to a different body part with no signal
that it is unsure is worse than one that says it does not speak the
language. Re-measure before adding it back; do not add it because the
service list says it is supported.
"""

LANGUAGES = [
    # code   label                    endonym          transcribe  polly voice  engine      polly lang
    ("en", "English",             "English",           "en-US", "Joanna",  "neural",   None),
    ("es", "Spanish",             "Español",           "es-US", "Lupe",    "neural",   None),
    ("zh", "Chinese (Mandarin)",  "中文",               "zh-CN", "Zhiyu",   "neural",   None),
    ("vi", "Vietnamese",          "Tiếng Việt",        "vi-VN", None,      None,       None),
    ("ar", "Arabic",              "العربية",            "ar-AE", "Hala",    "neural",   "arb"),
    ("fr", "French",              "Français",          "fr-FR", "Léa",     "neural",   None),
    ("ko", "Korean",              "한국어",              "ko-KR", "Seoyeon", "neural",   None),
    ("ru", "Russian",             "Русский",           "ru-RU", "Tatyana", "standard", None),
    ("tl", "Tagalog",             "Tagalog",           "tl-PH", None,      None,       None),
    ("ht", "Haitian Creole",      "Kreyòl Ayisyen",    "ht-HT", None,      None,       None),
    ("pt", "Portuguese",          "Português",         "pt-BR", "Camila",  "neural",   None),
    ("hi", "Hindi",               "हिन्दी",              "hi-IN", "Kajal",   "neural",   "hi-IN"),
    ("de", "German",              "Deutsch",           "de-DE", "Vicki",   "neural",   None),
    ("ja", "Japanese",            "日本語",             "ja-JP", "Takumi",  "neural",   None),
    ("it", "Italian",             "Italiano",          "it-IT", "Bianca",  "neural",   None),
    ("pl", "Polish",              "Polski",            "pl-PL", "Ewa",     "standard", None),
]

_FIELDS = ("code", "label", "endonym", "transcribe_code", "polly_voice", "polly_engine", "polly_language")

BY_CODE = {row[0]: dict(zip(_FIELDS, row)) for row in LANGUAGES}

#: What the client is allowed to ask for. Anything else is rejected rather
#: than passed through to Translate, so an unsupported code fails loudly
#: here instead of producing an unspoken, unreviewable translation.
SUPPORTED_CODES = frozenset(BY_CODE)

#: Comprehend returns regional variants for a few languages. Folding them
#: onto the row we do support is right for a medic ("zh-TW" heard from a
#: patient still means show them Chinese) but has to be explicit -- an
#: unmapped variant would otherwise read as "unsupported language".
DETECTION_ALIASES = {
    "zh-TW": "zh",
    "pt-PT": "pt",
    "es-MX": "es",
    "fr-CA": "fr",
}


def normalize_detected(code: str) -> str:
    """Comprehend's code -> a code in this table, where one exists."""
    return DETECTION_ALIASES.get(code, code)


def is_supported(code: str) -> bool:
    return code in BY_CODE


def voice_for(code: str):
    """(VoiceId, Engine, LanguageCode|None), or None if Polly cannot speak it."""
    row = BY_CODE.get(code)
    if not row or not row["polly_voice"]:
        return None
    return row["polly_voice"], row["polly_engine"], row["polly_language"]


def catalog() -> list:
    """The table as the app consumes it -- see GET /translate/languages."""
    return [
        {
            "code": r["code"],
            "label": r["label"],
            "endonym": r["endonym"],
            "transcribe_code": r["transcribe_code"],
            "can_speak": bool(r["polly_voice"]),
        }
        for r in BY_CODE.values()
    ]
