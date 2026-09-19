"""
Shared PCR logic: the Bedrock extraction prompt, the drug cross-check that
runs on top of it, and the flat summary/search projection the saved-PCR
list reads.

Two entry points feed the pipeline -- src/pcr/status.py (the original
single-file record-then-transcribe flow) and src/pcr/finalize.py (the
chunked live-transcript flow) -- so the extraction lives here rather than
in either one. Same reasoning as common/drugs.py: one implementation means
the two paths can't quietly produce differently-shaped PCRs.
"""
import json
import os
import boto3
from common.drugs import check_interactions

bedrock = boto3.client("bedrock-runtime")
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "amazon.nova-pro-v1:0")

PCR_EXTRACTION_PROMPT = """You are assisting an EMT by converting a spoken \
patient encounter narration into a structured Patient Care Report (PCR).

Extract the following fields from the transcript below. If a field was not \
mentioned, use null -- do not guess or invent clinical information.

Return ONLY valid JSON with this shape:
{{
  "chief_complaint": string | null,
  "patient_age": string | null,
  "patient_sex": string | null,
  "vitals": {{"bp": string|null, "hr": string|null, "rr": string|null, "spo2": string|null, "gcs": string|null, "temp": string|null, "bgl": string|null}},
  "allergies": [string],
  "interventions": [string],
  "medications_administered": [{{"name": string, "dose": string|null, "route": string|null, "time": string|null}}],
  "patient_medications": [string],
  "narrative_summary": string
}}

"medications_administered" is what the EMT gave on this call. \
"patient_medications" is what the patient reports already taking (home \
medications, other providers' doses) -- list the drug names only. Both \
matter: interactions run across the two lists combined.

The transcript may have been stitched together from short consecutive \
recordings, so a word can be clipped at a seam. Read through minor \
gaps; do not treat a truncated word as a new clinical finding.

Transcript:
\"\"\"
{transcript}
\"\"\"
"""

# The field order the mobile app renders in, and the order this module
# normalizes to. Kept here so the app and the extractor agree on shape
# even when the model omits a key entirely.
PCR_FIELDS = (
    "chief_complaint",
    "patient_age",
    "patient_sex",
    "vitals",
    "allergies",
    "interventions",
    "medications_administered",
    "patient_medications",
    "narrative_summary",
)

VITALS_FIELDS = ("bp", "hr", "rr", "spo2", "gcs", "temp", "bgl")


def extract_structured_pcr(transcript: str) -> dict:
    """Run Bedrock extraction over a transcript and return a PCR dict with
    every key in PCR_FIELDS present (null / empty list when unmentioned)."""
    # Converse instead of invoke_model: it's the provider-agnostic Bedrock
    # API, so swapping BEDROCK_MODEL_ID between vendors is a parameter
    # change rather than a rewrite of the request body. temperature 0
    # because this is extraction -- we want the same transcript to produce
    # the same PCR, not a creative variation on it.
    resp = bedrock.converse(
        modelId=BEDROCK_MODEL_ID,
        messages=[{"role": "user", "content": [{"text": PCR_EXTRACTION_PROMPT.format(transcript=transcript)}]}],
        inferenceConfig={"maxTokens": 2000, "temperature": 0},
    )
    text = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
    # Bedrock may wrap JSON in prose/code fences despite instructions -- extract defensively.
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("Model did not return JSON")
    return normalize_pcr(json.loads(text[start:end + 1]))


def normalize_pcr(raw: dict) -> dict:
    """Fill in every expected key so the UI never has to branch on absent
    vs. null, and so an edited PCR round-trips through commit unchanged."""
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    for field in PCR_FIELDS:
        value = raw.get(field)
        if field == "vitals":
            value = value if isinstance(value, dict) else {}
            out[field] = {k: value.get(k) or None for k in VITALS_FIELDS}
        elif field in ("allergies", "interventions", "patient_medications"):
            out[field] = [str(v).strip() for v in (value or []) if v]
        elif field == "medications_administered":
            meds = []
            for med in value or []:
                if isinstance(med, dict) and med.get("name"):
                    meds.append({
                        "name": str(med["name"]).strip(),
                        "dose": med.get("dose") or None,
                        "route": med.get("route") or None,
                        "time": med.get("time") or None,
                    })
                elif isinstance(med, str) and med.strip():
                    meds.append({"name": med.strip(), "dose": None, "route": None, "time": None})
            out[field] = meds
        else:
            out[field] = value or None
    return out


def drugs_mentioned(structured: dict) -> list[str]:
    """Every drug name in the PCR, from both what we gave and what the
    patient is already on. De-duplicated, order preserved so the flags read
    in the order the EMT said them."""
    names = []
    for med in structured.get("medications_administered") or []:
        name = (med or {}).get("name") if isinstance(med, dict) else med
        if name:
            names.append(str(name).strip())
    for name in structured.get("patient_medications") or []:
        if name:
            names.append(str(name).strip())

    seen, unique = set(), []
    for name in names:
        if name.lower() not in seen:
            seen.add(name.lower())
            unique.append(name)
    return unique


def cross_check(structured: dict) -> tuple[list[str], list[dict]]:
    """(drugs considered, interaction flags). Best-effort: a drug-table
    failure must not cost the EMT the PCR they just dictated, so a lookup
    error degrades to zero flags rather than raising."""
    drugs = drugs_mentioned(structured)
    if len(drugs) < 2:
        return drugs, []
    try:
        return drugs, check_interactions(drugs)
    except Exception:  # noqa: BLE001
        return drugs, []


# ---------------------------------------------------------------------
# Flat projection for the saved-PCR list.
#
# DynamoDB GSIs can't project nested attributes, and the list screen needs
# to render a useful card without pulling every full record (each of which
# carries a whole transcript). So commit writes these flat attributes
# alongside the nested structured_pcr, and the ByUser index projects them.
# ---------------------------------------------------------------------

def build_summary_attrs(structured: dict, interaction_flags: list[dict]) -> dict:
    meds = [m["name"] for m in structured.get("medications_administered") or [] if m.get("name")]
    age = structured.get("patient_age")
    sex = structured.get("patient_sex")
    label = " ".join(str(p) for p in (age, sex) if p) or "Patient"

    # search_text is what GET /pcr/saved?q= filters on. Lowercased at write
    # time so the filter is a plain contains() and the query side only has
    # to lowercase the needle.
    parts = [
        structured.get("chief_complaint") or "",
        structured.get("narrative_summary") or "",
        label,
        " ".join(meds),
        " ".join(structured.get("patient_medications") or []),
        " ".join(structured.get("interventions") or []),
        " ".join(structured.get("allergies") or []),
        " ".join(f"{f.get('drug_a')} {f.get('drug_b')} {f.get('severity')}" for f in interaction_flags),
    ]
    return {
        "summary_chief_complaint": structured.get("chief_complaint") or "Unspecified complaint",
        "summary_meds": meds,
        "patient_label": label,
        "flag_count": len(interaction_flags),
        "search_text": " ".join(parts).lower(),
    }
