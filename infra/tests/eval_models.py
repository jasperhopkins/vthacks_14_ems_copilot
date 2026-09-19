#!/usr/bin/env python3
"""
Model selection harness for the PCR extraction step.

    python3 infra/tests/eval_models.py                 # default shortlist
    python3 infra/tests/eval_models.py --models amazon.nova-pro-v1:0 openai.gpt-oss-120b-1:0

Scores candidate Bedrock models on transcripts written to look like what
Amazon Transcribe actually emits -- run-on, unpunctuated, spoken numbers --
plus the failure modes that matter clinically: inventing vitals or doses
that were never said, logging a drug that was explicitly *held*, confusing
an allergy with a medication, and fabricating interventions on a refusal.

This is what picked the current BedrockModelId. Re-run it before switching
models; a model that reads well on the happy path can still fabricate.
Every run costs a few cents of Bedrock inference.
"""
import argparse
import json
import os
import pathlib
import statistics
import sys
import time
from collections import Counter

import boto3

sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "layers" / "common" / "python"))
sys.path.insert(0, str(ROOT / "src" / "pcr"))
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ.setdefault("AUDIO_BUCKET_NAME", "eval-placeholder")

from unittest import mock  # noqa: E402
with mock.patch("boto3.resource"), mock.patch("boto3.client"):
    import status  # noqa: E402  -- imported for the real prompt + parser

DEFAULT_MODELS = [
    "amazon.nova-pro-v1:0",
    "amazon.nova-lite-v1:0",
    "us.amazon.nova-2-lite-v1:0",
    "openai.gpt-oss-120b-1:0",
    "mistral.mistral-large-3-675b-instruct",
    "us.meta.llama3-3-70b-instruct-v1:0",
    "moonshotai.kimi-k2.5",
    "qwen.qwen3-32b-v1:0",
]


def med_names(pcr, key):
    out = []
    for m in pcr.get(key) or []:
        name = m.get("name") if isinstance(m, dict) else m
        if name:
            out.append(str(name).lower())
    return out


REALISTIC_ASR = (
    "alright so we got dispatched to a residence for difficulty breathing "
    "patient is a fifty eight year old female she was stung by a wasp in the garden about "
    "fifteen minutes prior to our arrival on arrival she's got diffuse hives audible wheezing "
    "and she's anxious um vitals blood pressure ninety over sixty heart rate one thirty "
    "respirations thirty two pulse ox eighty four percent on room air GCS fourteen "
    "she's got a history of hypertension and she tells us she takes propranolol every morning "
    "also on sildenafil for pulmonary hypertension we placed her on high flow oxygen fifteen "
    "liters non rebreather established an eighteen gauge IV in the left AC and administered "
    "epinephrine zero point three milligrams IM in the lateral thigh also gave albuterol "
    "by nebulizer transported code three to regional"
)

CASES = [
    ("realistic_asr_vitals", REALISTIC_ASR,
     lambda d: all(x in str(d["vitals"].get(k) or "")
                   for k, x in [("bp", "90"), ("hr", "130"), ("rr", "32"), ("spo2", "84"), ("gcs", "14")])),
    ("realistic_asr_meds", REALISTIC_ASR,
     lambda d: any("epi" in n for n in med_names(d, "medications_administered"))
     and any("albuterol" in n for n in med_names(d, "medications_administered"))
     and any("propranolol" in n for n in med_names(d, "patient_medications"))
     and not any("propranolol" in n for n in med_names(d, "medications_administered"))),

    ("no_invented_vitals",
     "Dispatched for a fall. 78 year old female, complains of right hip pain. Heart rate 88. "
     "Transported without incident.",
     lambda d: d["vitals"].get("bp") is None and d["vitals"].get("spo2") is None
     and not med_names(d, "medications_administered")),

    ("held_drug_not_logged",
     "Suspected overdose, unresponsive, respirations six. We considered naloxone but held it and "
     "ventilated with a BVM instead. No drugs were administered by us.",
     lambda d: not any("nalox" in n or "narcan" in n for n in med_names(d, "medications_administered"))),

    ("allergy_is_not_a_med",
     "45 year old female, hives after a bee sting. Allergic to penicillin and shellfish. "
     "No home medications. We gave epinephrine 0.3 IM. BP 110 over 70.",
     lambda d: not any("penicillin" in n or "shellfish" in n
                       for n in med_names(d, "medications_administered") + med_names(d, "patient_medications"))),

    ("dose_not_invented",
     "Gave the patient some aspirin for the chest pain. Didn't note the exact amount.",
     lambda d: any("aspirin" in n for n in med_names(d, "medications_administered"))
     and all((m.get("dose") in (None, "", "null")) for m in (d.get("medications_administered") or [])
             if isinstance(m, dict))),

    ("no_phantom_interventions",
     "Patient refused all care and signed a refusal form. No assessment performed beyond initial contact.",
     lambda d: len(d.get("interventions") or []) <= 1 and not med_names(d, "medications_administered")),

    ("mid_sentence_correction",
     "Blood pressure was 140 over 90, no wait, recheck was 168 over 104. Heart rate uh 72, "
     "sorry that was the pulse ox, heart rate is 112, sat is 94 percent.",
     lambda d: "168" in str(d["vitals"].get("bp") or "") and "112" in str(d["vitals"].get("hr") or "")),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="*", default=DEFAULT_MODELS)
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--reps", type=int, default=2, help="repeats per case; catches non-determinism")
    args = ap.parse_args()

    br = boto3.client("bedrock-runtime", region_name=args.region)
    print(f"{len(CASES)} cases x {args.reps} reps against {len(args.models)} models\n")

    for model_id in args.models:
        passed = total = 0
        latencies, failures = [], []
        for case_name, transcript, check in CASES:
            prompt = status.PCR_EXTRACTION_PROMPT.format(transcript=transcript)
            for _ in range(args.reps):
                total += 1
                try:
                    t0 = time.time()
                    resp = br.converse(
                        modelId=model_id,
                        messages=[{"role": "user", "content": [{"text": prompt}]}],
                        inferenceConfig={"maxTokens": 2000, "temperature": 0},
                    )
                    latencies.append(time.time() - t0)
                    text = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
                    pcr = json.loads(text[text.find("{"):text.rfind("}") + 1])
                    if check(pcr):
                        passed += 1
                    else:
                        failures.append(case_name)
                except Exception as e:  # noqa: BLE001 -- a model that errors is a model we can't ship
                    failures.append(f"{case_name}:{type(e).__name__}")
        p50 = statistics.median(latencies) if latencies else 0.0
        worst = max(latencies) if latencies else 0.0
        print(f"{model_id:42s} {passed:2d}/{total}  p50={p50:4.1f}s  max={worst:4.1f}s  {dict(Counter(failures))}")


if __name__ == "__main__":
    main()
