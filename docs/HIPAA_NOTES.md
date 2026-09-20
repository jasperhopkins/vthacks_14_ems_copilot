# HIPAA notes for EMS Copilot

**Read this before this project touches any real patient data.** Everything
below reflects research done on 2026-09-19 against AWS's public docs and
several third-party summaries, cross-checked where possible. AWS's official
list lives at https://aws.amazon.com/compliance/hipaa-eligible-services-reference/
and is a JS-rendered page our tools could not fully scrape — **before any
real deployment, a human should load that page in a browser and re-verify
every service below against the live list**, and separately confirm which
Bedrock model IDs are currently BAA-covered (AWS updates this over time as
new models ship).

## The one-sentence version

**"HIPAA eligible" + a signed BAA gives you infrastructure that is *allowed*
to hold PHI. It does not, by itself, make your application HIPAA
*compliant*.** Compliance also requires: workforce training, access
policies, a risk assessment, breach notification procedures, signed BAAs
with every subprocessor you use, and correct configuration of every
eligible service you touch. None of that exists yet for this project. Demo
with synthetic data; treat "HIPAA-ready architecture" as the accurate
description of what's built here, not "HIPAA compliant."

## Step zero: the Business Associate Addendum (BAA)

- Any AWS account can accept AWS's BAA for free, self-service, through
  **AWS Artifact** (Artifact > Agreements > AWS Business Associate
  Addendum). No sales call needed, no cost.
- Until you've accepted it, you are **not authorized to put PHI in any AWS
  service**, eligible or not.
- The BAA only covers the services on AWS's HIPAA-eligible list. Every
  other service (or a specific non-covered *feature* of an otherwise
  covered service) is off-limits for PHI regardless of encryption/config.

## Services this architecture uses, and their eligibility status

| Service | Used for | Eligibility (as researched) | Confidence |
|---|---|---|---|
| AWS Lambda | All application logic | Eligible | High — confirmed across multiple sources |
| Amazon API Gateway | REST/HTTP API layer | Eligible | High — long-standing eligible service, but **re-verify on the live list**, we could not independently re-confirm today |
| Amazon DynamoDB | Encounters, audit log, protocol & drug reference tables | Eligible | High — confirmed |
| Amazon S3 | Audio uploads, CloudTrail log storage | Eligible | High — confirmed |
| Amazon Cognito | User auth / identity | Eligible | High — long-standing eligible service, but **re-verify on the live list** same as API Gateway |
| AWS KMS | Encryption at rest (CMK) | Eligible | High — confirmed |
| AWS CloudTrail | Infra-level audit trail | Eligible | High — confirmed |
| Amazon Transcribe | Speech-to-text for voice-to-PCR | Eligible | High — confirmed via official AWS ML blog |
| Amazon Translate | Medical translator module | Eligible | High — confirmed via official AWS ML blog |
| Amazon Polly | Spoken translation playback | Eligible | High — confirmed via official AWS ML blog |
| Amazon Comprehend | Language identification for the translator (`DetectDominantLanguage`) | Eligible | Medium — the general-purpose Comprehend service is separate from Comprehend Medical below and is reported eligible, but **re-confirm against the live list before real use**. Note what this call sees: it is handed the patient's own utterance, so it is PHI-bearing on the same footing as Translate. Only the first 1000 characters are sent (`DETECT_SAMPLE_CHARS`), which is a cost measure, not a privacy control. |
| Amazon Comprehend Medical | Drug name normalization (RxNorm) | Eligible | Medium — widely reported as eligible (it's purpose-built for PHI/clinical text) but not independently re-confirmed against the live AWS list today; **verify before real use** |
| Amazon Textract | Not currently used, but relevant if you add document/label OCR later | Eligible | High — confirmed via official 2019 AWS announcement |
| Amazon Bedrock | PCR field extraction, protocol Q&A summarization | Eligible **with caveats** | Medium — Bedrock itself is on AWS's eligible list, but coverage has been reported as model-specific and feature-specific (e.g. fine-tuning / model customization may need extra verification). **You must confirm the exact model ID you deploy (`BedrockModelId`, pinned in `infra/samconfig.toml`) is currently BAA-covered before sending it real PHI.** The deployed default is `amazon.nova-pro-v1:0` — an AWS first-party model, which keeps this question inside the AWS BAA rather than adding a third-party model provider's terms on top. Handlers call Bedrock through the provider-agnostic Converse API, so switching models is a config change; re-verify coverage (and re-run `infra/tests/eval_models.py`) when you do. |

### Bedrock-specific configuration this template already does / you should also do

- Region pinned to a HIPAA-eligible region (`us-east-1` in `samconfig.toml`)
  — Bedrock HIPAA eligibility has historically been tied to specific
  regions; confirm your target region is covered.
- Use a customer-managed KMS key (done — `EmsCopilotKmsKey`) rather than
  AWS-managed default keys, for anything Bedrock touches indirectly via
  S3/DynamoDB.
- Least-privilege IAM: the Lambda role grants only `bedrock:InvokeModel`,
  not `bedrock:*` (done — see `EncounterFunctionsRole` in `template.yaml`).
- **Not yet done, recommended before production**: disable/limit Bedrock
  model invocation logging that could capture PHI in CloudWatch, or route
  it through a log sink you control and retain per your policy instead of
  defaults. This gets sharper with the hands-free agent, which makes
  several model calls per spoken turn — see item 11 below.

## What's actually built for compliance-shaped behavior (real, not aspirational)

- **Append-only audit log** (`AuditLogTable` + `layers/common/python/common/audit.py`):
  every module logs who/what/when/which-encounter on every read and write.
  The Lambda IAM role is granted `PutItem` but explicitly *not*
  `UpdateItem`/`DeleteItem` on this table — so "append-only" is an IAM
  guarantee, not just a naming convention.
- **Encryption at rest everywhere**: every DynamoDB table and both S3
  buckets use a single customer-managed KMS key (`EmsCopilotKmsKey`) with
  rotation enabled.
- **Encryption in transit**: API Gateway is HTTPS-only by default; nothing
  here opens an unencrypted listener.
- **Account-level audit trail**: CloudTrail (`EmsCopilotTrail`) with log
  file validation enabled, multi-region, all read/write management events
  — this is your evidence of *infrastructure* access, distinct from the
  DynamoDB audit log's evidence of *application* actions.
- **Authenticated by default**: every API route requires a valid Cognito
  JWT (`DefaultAuthorizer: CognitoAuthorizer` in `template.yaml`) — there
  is no anonymous path to any PHI-adjacent endpoint.
- **Least-privilege IAM**: one shared Lambda role, but scoped per-action
  per-table (see `EncounterFunctionsRole`) rather than a blanket
  `dynamodb:*` grant.
- **Audio retention limit**: raw audio in S3 auto-expires after 7 days
  (`LifecycleConfiguration` on `AudioBucket`) — tune to your actual
  retention policy, but the point is raw audio (highest-sensitivity
  artifact here) doesn't linger by default.

## What is explicitly NOT done here (do before real PHI, not before a demo)

1. **MFA is optional, not required** (`UserPool.MfaConfiguration: OPTIONAL`
   in `template.yaml`). Flip to `REQUIRED` before this is anything but a
   demo.
2. **CORS is wide open** (`AllowOrigins: ["*"]`). Fine for a hackathon
   testing against Expo Go; restrict before production.
3. **No formal risk assessment, workforce training, incident response
   plan, or subprocessor BAAs** — these are organizational requirements,
   not something a template can satisfy.
4. **CloudWatch Logs on the Lambdas are not scrubbed of PHI.** If a
   transcript or structured PCR ever appears in a `print()`/log line, it
   lands in CloudWatch Logs unencrypted-by-default and outside the audit
   table's controls. Review every handler's logging before real use; none
   of the current handlers log PHI, but this needs to stay a standing
   review item as the code grows.
5. **No data subject access / deletion workflow** (HIPAA doesn't require
   this the way GDPR does, but most real EMS records-retention rules do
   require defined retention + deletion procedures — not built here).
6. **Comprehend Medical eligibility and the exact Bedrock model's BAA
   coverage were not independently re-verified against AWS's live list**
   in this scaffolding pass — see the table above.
7. **Self-registration is off; accounts are created by an administrator.**
   `AdminCreateUserConfig.AllowAdminCreateUserOnly` is `true`. This is not
   a nice-to-have: the user-pool id and the app client id are *not*
   secrets — a mobile app has to ship them, `mobile/src/config.js` does,
   and that file is in a public repository. The app client has no secret,
   and the API's JWT authorizer checks only issuer and audience, with no
   scopes and no group claim. So while signup was open, anyone who could
   read the repo could register, self-confirm over the auto-verified email
   address, and hold a token that satisfied the authorizer on *every*
   route — the Bedrock, Transcribe, Translate and Polly calls behind them,
   the encounter and reference tables, and the identity pool's streaming
   credentials. Closing signup is the control that makes shipping those
   identifiers safe. Create demo accounts with:

   ```bash
   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> \
     --username demo@ems-copilot.test --message-action SUPPRESS
   aws cognito-idp admin-set-user-password --user-pool-id <UserPoolId> \
     --username demo@ems-copilot.test --password '<password>' --permanent
   ```

   Note what this does *not* do: it does not authenticate that a given
   medic is who they claim to be, and it does not scope one user away from
   another's encounters. Every authenticated user can still read every
   encounter. Per-user authorization is still a TODO.

8. **Sign-in uses `USER_PASSWORD_AUTH`, not SRP.** The app sends the
   password to Cognito inside TLS rather than proving knowledge of it
   without transmitting it. This was a deliberate performance trade:
   `amazon-cognito-identity-js` implements SRP in pure JavaScript, and its
   two 3072-bit modular exponentiations cost ~150ms each on a JIT-ed V8 —
   on Hermes (no JIT, and running on the UI thread) sign-in blocked the app
   for tens of seconds. Both flows are enabled server-side
   (`ExplicitAuthFlows` in `template.yaml`), so moving back to SRP is a
   client-only change: add a native crypto module such as
   `react-native-quick-crypto` and restore the SDK path. That requires an
   EAS development build — it cannot run in Expo Go. Do this before real
   PHI, alongside making MFA required (item 1); note the current client
   also has no MFA-challenge branch, so it would need one anyway.

9. **Live transcription hands the device real AWS credentials, and sends
   audio straight to Transcribe.** This is the one place the phone holds
   anything beyond a Cognito ID token. Amazon Transcribe's streaming API
   is a SigV4-signed WebSocket, and a continuous audio stream cannot be
   proxied through API Gateway + Lambda, so the app trades its ID token at
   a Cognito identity pool (`IdentityPool` in `template.yaml`) for
   temporary credentials and signs the connection itself. What that
   changes, concretely:

   - The credentials are scoped to exactly one action
     (`transcribe:StartStreamTranscriptionWebSocket`, see
     `TranscribeStreamingRole`) on a service that persists nothing. They
     cannot reach DynamoDB, S3 or Bedrock. Unauthenticated identities are
     disabled, so a valid user-pool token is required to get them at all.
   - **On this path the audio never lands in our S3 bucket**, so it is not
     covered by the bucket's CMK encryption or its 7-day lifecycle expiry.
     It goes device -> Transcribe over TLS and is not retained by us at
     all. That is arguably better for PHI minimization, but it is a
     different story to tell an auditor than "encrypted at rest with our
     key," and it means there is no audio artifact to produce later.
   - **The backend takes the transcript from the client.** `/pcr/finalize`
     records what the device sends rather than deriving it from audio it
     processed itself. The audit trail still records who submitted it and
     hashes the payload, but the chain of custody from microphone to
     transcript now runs through the device, not through our stack.
   - The older chunked path (`/pcr/stream-chunk` -> `/pcr/{id}/live`) is
     still deployed and still routes audio through S3 with the CMK, and it
     needs no identity pool. If the credential exposure above is
     unacceptable for a given deployment, that is the fallback — delete
     the identity pool and point the app back at it.
   - **The medical translator now uses this same path**, in both
     directions, including the patient's own speech with
     `identify-language` on. Everything above applies unchanged, with one
     addition specific to it: the set of languages the app offers to
     identify between is sent to AWS in the query string of the signed
     URL, so it is visible to anything that can see the request metadata.
     That set is a fixed list of 16 languages (`common/languages.py`),
     identical for every encounter, so it reveals nothing about the
     patient — but it would if a deployment ever narrowed the options
     per-call based on who the patient is. Don't.

10. **Hands-free mode listens continuously, and the wake word does not
    change where the audio goes.** `CopilotScreen` holds one Transcribe
    stream open for the whole call and acts only on speech that begins
    "Copilot". That gating is real for *our* storage — nothing reaches the
    backend, and no tool runs, unless the medic addressed the assistant —
    but the wake word is detected **in the transcript**, so the audio has
    already gone to Amazon Transcribe by the time we can tell. What is
    actually true, and what you may say:

    - Continuous audio goes device -> Transcribe over TLS. Transcribe is
      HIPAA-eligible and retains nothing; it is not stored by us at all,
      so item 9's whole analysis applies unchanged and unimproved.
    - Only wake-word-addressed turns reach our stack, as text.
    - **You may not say "it only listens when spoken to."** Closing that
      gap needs on-device keyword spotting, which needs a native module,
      which rules out Expo Go.

    This matters more than for the Record button, because an always-on
    assistant in an ambulance hears the patient, the family, the crew and
    the radio — people who did not press anything and are not the medic.
    That is a consent question as much as a technical one, and a real
    deployment needs an answer to it (signage, a crew-facing disclosure,
    or push-to-talk) rather than a longer paragraph here.

    Two smaller mitigations that are implemented: the microphone is fed
    silence while the assistant is speaking, so it does not transcribe
    itself into the patient's narrative; and speech that arrives during
    playback is discarded rather than appended to the call transcript.

11. **An agent multiplies inferences, which multiplies item 4.** Each
    hands-free turn is several Bedrock Converse calls carrying clinical
    narrative, where a tapped PCR was one. Bedrock **model invocation
    logging** is an opt-in, account-level setting and is off on this
    account; it is not something this template can turn on or off, so it
    has to be *verified* rather than assumed. Check it, and keep it off or
    pointed at a controlled sink you retain per your own policy, before
    real PHI:

    ```bash
    aws bedrock get-model-invocation-logging-configuration --region us-east-1
    ```

    Also note the agent's request carries conversation history and the
    running call transcript from the device on every turn (see
    `infra/src/agent/app.py`). That is deliberate — the backend keeps no
    second transcript of the medic's dialogue with the assistant, only
    hashed audit rows — but it means the same content crosses the wire
    repeatedly within one call, and it extends item 9's "chain of custody
    runs through the device" to the dialogue as well as the narration.

    The action boundary itself — what the agent may and may not do, and
    why each control is structural rather than a prompt instruction — is
    `docs/AGENT_BOUNDARY.md`. Read it before adding a tool. The parts with
    direct compliance weight: every agent action is audited against the
    *clinician's* Cognito sub with `actor="AGENT"` and a turn id, so
    §164.312(b) still answers "which workforce member"; `/agent/turn`
    returns 401 rather than acting for `UNKNOWN_USER`; and every tool is
    scoped to the session's single encounter, so the agent's reach is one
    patient rather than every chart the medic's token can open.

## For the hackathon demo itself

Use synthetic patient data only (there are seed files in `infra/seed/` you
can extend with fake encounters). If you want to state a compliance
position to judges, an accurate one is:

> "This is built entirely on AWS services that are HIPAA-eligible once a
> BAA is signed, with encryption at rest/in transit, least-privilege IAM,
> Cognito auth on every endpoint, and a tamper-resistant append-only audit
> trail enforced at the IAM layer — not just structurally, that's
> demonstrable. We're not claiming HIPAA compliance for a 10-hour build;
> compliance is an organizational commitment beyond what any hackathon
> project can carry, and we ran the whole demo on synthetic data for
> exactly that reason."

That's a stronger, more credible line than an unverifiable compliance
claim, and it's true.
