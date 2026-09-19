#!/usr/bin/env python3
"""
End-to-end smoke test for the voice-to-PCR pipeline, against a deployed
stack. Uses Amazon Polly to synthesize the demo narration so no microphone
or phone is needed, then drives the real API exactly the way the mobile app
does -- Cognito SRP login, presigned upload, generate, poll.

    python3 infra/tests/smoke_test_pcr.py \
        --stack ems-copilot-dev --region us-east-1 \
        --username demo@ems-copilot.test --password 'RealPass123!'

Exits non-zero if the PCR never completes or the drug cross-check misses
the interaction the narration contains.
"""
import argparse
import json
import sys
import time
import urllib.request

import boto3
from pycognito.aws_srp import AWSSRP

# Wasp sting -> anaphylaxis. Patient is on propranolol, we give epinephrine:
# the pair the drug cross-check is supposed to catch on its own.
NARRATION = (
    "Dispatched to a residence for difficulty breathing. Patient is a 58 year old female, "
    "stung by a wasp in the garden about 15 minutes prior to our arrival. On arrival she has "
    "diffuse hives, audible wheezing, and she's anxious. Vitals: blood pressure 90 over 60, "
    "heart rate 130, respirations 32, pulse ox 84 percent on room air, G C S 14. "
    "She has a history of hypertension and tells us she takes propranolol every morning. "
    "We placed her on high flow oxygen, 15 liters by non-rebreather, established an 18 gauge "
    "I V in the left A C, and administered epinephrine 0.3 milligrams I M in the lateral thigh. "
    "Also gave albuterol by nebulizer. Transported code 3 to regional."
)


def outputs(stack, region):
    cf = boto3.client("cloudformation", region_name=region)
    o = cf.describe_stacks(StackName=stack)["Stacks"][0]["Outputs"]
    return {x["OutputKey"]: x["OutputValue"] for x in o}


def login(pool_id, client_id, username, password, region):
    srp = AWSSRP(username=username, password=password, pool_id=pool_id,
                 client_id=client_id, client=boto3.client("cognito-idp", region_name=region))
    return srp.authenticate_user()["AuthenticationResult"]["IdToken"]


def call(url, token, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Authorization": token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return r.status, json.loads(r.read() or "{}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stack", default="ems-copilot-dev")
    ap.add_argument("--region", default="us-east-1")
    ap.add_argument("--username", required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--timeout", type=int, default=180)
    args = ap.parse_args()

    out = outputs(args.stack, args.region)
    api = out["ApiUrl"]
    encounter_id = f"smoke-{int(time.time())}"
    print(f"encounter {encounter_id}\napi {api}")

    print("[1/6] synthesizing narration with Polly")
    polly = boto3.client("polly", region_name=args.region)
    audio = polly.synthesize_speech(Text=NARRATION, OutputFormat="mp3",
                                    VoiceId="Matthew", Engine="neural")["AudioStream"].read()
    print(f"      {len(audio)} bytes of mp3")

    print("[2/6] Cognito SRP login")
    token = login(out["UserPoolId"], out["UserPoolClientId"], args.username, args.password, args.region)

    print("[3/6] GET /pcr/upload-url")
    _, up = call(f"{api}/pcr/upload-url?filename=smoke.mp3", token)

    print("[4/6] PUT audio to presigned S3 URL")
    put = urllib.request.Request(up["upload_url"], data=audio, method="PUT",
                                 headers={"Content-Type": up["content_type"]})
    with urllib.request.urlopen(put) as r:
        assert r.status in (200, 204), r.status

    print("[5/6] POST /pcr/generate")
    status_code, started = call(f"{api}/pcr/generate", token, "POST",
                                {"s3_key": up["s3_key"], "encounter_id": encounter_id})
    print(f"      HTTP {status_code} {started}")

    print("[6/6] polling GET /pcr/{encounter_id}")
    deadline = time.time() + args.timeout
    t0 = time.time()
    while time.time() < deadline:
        time.sleep(3)
        _, res = call(f"{api}/pcr/{encounter_id}", token)
        if res["status"] == "COMPLETE":
            print(f"      COMPLETE after {time.time()-t0:.0f}s\n")
            print("TRANSCRIPT:", res["transcript"][:200], "...\n")
            print("PCR:", json.dumps(res["pcr"], indent=2))
            print("\nINTERACTION FLAGS:", json.dumps(res["interaction_flags"], indent=2))
            flags = res["interaction_flags"]
            if not any({f["drug_a"].lower(), f["drug_b"].lower()} == {"epinephrine", "propranolol"}
                       for f in flags):
                print("\nFAIL: expected an epinephrine/propranolol flag")
                return 1
            print("\nPASS: pipeline completed and auto-flagged the interaction")
            return 0
        if res["status"] == "FAILED":
            print("FAIL:", res.get("error"))
            return 1
        print(f"      {res['status']} ...")
    print("FAIL: timed out")
    return 1


if __name__ == "__main__":
    sys.exit(main())
