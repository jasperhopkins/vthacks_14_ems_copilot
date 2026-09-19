# Deploying EMS Copilot's backend

## Prerequisites

```bash
# AWS SAM CLI
brew install aws-sam-cli        # or see https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html
aws configure                   # needs credentials for the target account
```

Accept AWS's BAA first if this will ever touch real PHI: AWS Console →
**Artifact** → Agreements → accept the "AWS Business Associate Addendum."
Not required to deploy/demo with synthetic data, but do this before real
patient data ever touches the stack. See `../docs/HIPAA_NOTES.md`.

## Deploy

```bash
cd infra
sam build          # packages the Lambda layer + each function
sam deploy          # first run: sam deploy --guided, then samconfig.toml takes over after
```

`sam deploy` prints the stack Outputs at the end — grab these:

- `ApiUrl` → put in `mobile/src/config.js` as `API_BASE_URL`
- `UserPoolId` → `COGNITO_USER_POOL_ID`
- `UserPoolClientId` → `COGNITO_CLIENT_ID`

Or fetch them anytime with:

```bash
aws cloudformation describe-stacks --stack-name ems-copilot-dev \
  --query "Stacks[0].Outputs" --output table
```

## Seed the reference data

```bash
cd infra/seed
pip install boto3 --break-system-packages   # if not already available
python3 seed_tables.py --stage dev --region us-east-1
```

This loads `drug_reference_seed.json` and `protocol_reference_seed.json`
into DynamoDB. **These are demo/seed datasets only** — see the `notes`
field on every record. Do not treat dosages/contraindications in these
files as clinically authoritative; replace with your agency's actual
medical-direction-approved data before any real use.

## Create a test user (Cognito)

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId from outputs> \
  --username demo@ems-copilot.test \
  --user-attributes Name=email,Value=demo@ems-copilot.test \
  --temporary-password 'TempPass123!'

aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username demo@ems-copilot.test \
  --password 'RealPass123!' \
  --permanent
```

Log in with `demo@ems-copilot.test` / `RealPass123!` from the mobile app.

## Requesting a Bedrock model

Model availability is per-account and differs by vendor, so check what
yours can actually reach before assuming a model ID works:

```bash
aws bedrock list-foundation-models --query "modelSummaries[].modelId" --output text | tr '\t' '\n'
aws bedrock list-inference-profiles --query "inferenceProfileSummaries[].inferenceProfileId" --output text
```

The stack ships on `amazon.nova-pro-v1:0`, chosen by running
`infra/tests/eval_models.py` over realistic ASR-style transcripts — it was
the cheapest candidate that never fabricated a vital, a dose, or an
intervention. Handlers call Bedrock via the provider-agnostic **Converse**
API, so any Converse-capable text model works without a code change.

Two traps:

- **Anthropic models on Bedrock need more than "enable model access"**: a
  use-case details form submitted per account, and they're
  inference-profile-only, meaning the ID needs a `us.` prefix
  (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`). Until the form is
  approved, calls fail with `ResourceNotFoundException`. Nova needs
  neither.
- **Change the model in `samconfig.toml`, not `template.yaml`.**
  `parameter_overrides` beats the template default, and CloudFormation
  reuses a parameter's previous value when you omit it — so editing
  `Default:` alone does nothing to a deployed stack. A stale pin left by
  `sam deploy --guided` will keep the Lambdas calling whatever model was
  default when you first deployed, surfacing as "this model version has
  reached the end of its life".

## Smoke-testing voice-to-PCR without a phone

The PCR flow is three calls. You need a Cognito ID token in `$TOKEN` and
the API URL in `$API` (see "Getting a token for curl" below).

```bash
# 1. Get a presigned upload URL, then PUT an audio file at it
curl -s -H "Authorization: $TOKEN" "$API/pcr/upload-url?filename=demo.m4a"
curl -s -X PUT --upload-file demo.m4a "<upload_url from above>"

# 2. Start the pipeline (returns 202 immediately -- it does NOT wait)
curl -s -X POST -H "Authorization: $TOKEN" -H "Content-Type: application/json" \
  -d '{"s3_key":"<s3_key from step 1>","encounter_id":"demo-1"}' "$API/pcr/generate"

# 3. Poll until status flips PROCESSING -> COMPLETE (10-40s typically)
curl -s -H "Authorization: $TOKEN" "$API/pcr/demo-1"
```

Step 2 deliberately returns before the work is done: HTTP APIs cap
integration time at 30 seconds and that cap can't be raised, while
Transcribe routinely takes longer. The poll in step 3 is what runs Bedrock
extraction and the drug cross-check, on the first call that finds the
transcript ready.

### Getting a token for curl

The user pool client only enables SRP auth, so `initiate-auth
--auth-flow USER_PASSWORD_AUTH` will fail. Add `ALLOW_ADMIN_USER_PASSWORD_AUTH`
to `ExplicitAuthFlows` in `template.yaml`, redeploy, then:

```bash
aws cognito-idp admin-initiate-auth \
  --user-pool-id <UserPoolId> --client-id <UserPoolClientId> \
  --auth-flow ADMIN_USER_PASSWORD_AUTH \
  --auth-parameters USERNAME=demo@ems-copilot.test,PASSWORD='RealPass123!' \
  --query 'AuthenticationResult.IdToken' --output text
```

Pass it as a bare `Authorization: <token>` header — no `Bearer` prefix.

### Automated tests

```bash
python3 infra/tests/test_pcr_logic.py      # offline, no credentials needed

# Full pipeline against the deployed stack: synthesizes the demo narration
# with Polly, logs in via Cognito SRP, uploads, polls, and asserts the
# epinephrine/propranolol interaction gets flagged. ~15 seconds.
pip install pycognito
python3 infra/tests/smoke_test_pcr.py \
  --username demo@ems-copilot.test --password '<password>'
```

`test_pcr_logic.py` covers drug-name resolution (aliases, brand names,
field slang), the interaction check, med-list merging, and media-format
handling with AWS stubbed out.

### sam local

```bash
sam local invoke ProtocolFunction --event events/protocol_query.json
```

No sample event files are included yet — write one matching the API
Gateway HTTP API v2 event shape. Note that the handlers' fallback table
names lack the `-${Stage}` suffix the real tables have, so pass
`--env-vars` with the deployed names or every DynamoDB call misses.

## Tearing down

```bash
sam delete --stack-name ems-copilot-dev
```

Note: S3 buckets with objects in them (audio, CloudTrail logs) won't
auto-delete — empty them first if `sam delete` fails on that.
