# EMS Copilot — agent quickstart

Read this first. It's the map for picking up this scaffold and finishing it
in a ~10-hour hackathon window. Full details live in `infra/README.md`
(deployment) and `docs/HIPAA_NOTES.md` (compliance posture — read before
touching this with anything but synthetic data).

## What this is

One mobile app (Expo/React Native), one AWS backend (SAM/CloudFormation),
four features sharing a common `encounter_id` and audit trail:

1. **Voice-to-PCR** (`infra/src/pcr/`) — record → Transcribe → Bedrock
   extracts structured fields → saved to DynamoDB.
2. **Protocol/dosage assistant** (`infra/src/protocol/`) — retrieval-only
   (never free-generated) answers from a curated protocol table.
3. **Medical translator** (`infra/src/translate/`) — Translate + Polly.
4. **Drug reference/interactions** (`infra/src/drug/`) — lookup +
   contraindication flagging, shared data source for module 2's dosage
   answers.

Every module writes to the append-only `AuditLogTable` via
`infra/layers/common/python/common/audit.py`. See `docs/HIPAA_NOTES.md`
for what that trail actually guarantees and what it doesn't.

## Status: what's already built vs. stubbed

**Built and should work as-is (still needs a real deploy + testing pass):**
- Full SAM template (`infra/template.yaml`): Cognito, API Gateway (HTTP API
  w/ JWT authorizer), 4 DynamoDB tables, KMS CMK, CloudTrail, S3 audio
  bucket, IAM role scoped per-action.
- All 7 Lambda handlers with real (not pseudocode) boto3 calls to
  Transcribe, Bedrock, Comprehend Medical, Translate, Polly, DynamoDB.
- **Phase 1 (voice-to-PCR) is implemented, deployed, and verified end to
  end**: record -> presigned S3 upload -> `POST /pcr/generate` starts a
  Transcribe job -> the app polls `GET /pcr/{encounter_id}` -> first poll
  that finds the transcript ready runs Bedrock extraction + the drug
  cross-check and returns the PCR with any interaction flags. A 58-year-old
  anaphylaxis narration completes in ~10s and auto-flags
  epinephrine/propranolol. All four endpoints and the audit trail verified
  against the live `ems-copilot-dev` stack.
- Seed data for drug reference + protocols (`infra/seed/`), with a script
  to load them post-deploy.
- Expo app shell on **SDK 57** (RN 0.86, React 19): login screen (Cognito),
  home menu, all 4 feature screens wired to the API client. Both iOS and
  Android bundles build clean.

**Deliberately left as stretch goals / TODOs — prioritize in this order if
time allows:**

1. **Deploy and smoke-test end to end first**, before adding anything new.
   `sam build && sam deploy`, seed the tables, create a Cognito test user,
   fill in `mobile/src/config.js`, run `expo start`, scan the QR with Expo
   Go. Getting this loop working is the single highest-value thing to do
   early — everything else is incremental from there.
2. **Bedrock model access is per-account and varies by vendor.** Anthropic
   models on Bedrock additionally require submitting a use-case details
   form in the console and are inference-profile-only (`us.` prefix);
   until that's approved they fail with `ResourceNotFoundException`. The
   stack therefore ships on `amazon.nova-pro-v1:0`, which needs no form.
   Check what an account can actually invoke with
   `aws bedrock list-foundation-models` — the list differs per account.
3. ~~Transcribe polling is synchronous in-Lambda~~ — **done, and it had
   to be.** HTTP APIs cap integration time at 30s and that cap is not
   adjustable, so the original in-request polling 504'd regardless of
   `Globals.Function.Timeout`. Now split across `pcr/app.py` (start job)
   and `pcr/status.py` (poll + finish). Remaining sharp edge: the poll that
   finds the job done runs Bedrock inline, so a very long transcript could
   still push that one request toward 30s — move to EventBridge on
   Transcribe job completion if that ever bites.
4. ~~`TranslateScreen.js` uses React Native's `Picker`~~ — **done**, it's
   a row of Pressable language chips now. `Picker` was removed from React
   Native years ago and would have crashed that screen.
5. ~~PCR → drug-interaction cross-check~~ — **done.** The rules moved to
   `common/drugs.py`, which both `/drug/check-interaction` and
   `pcr/status.py` call, so the two can't drift. The PCR prompt now also
   extracts `patient_medications` (home meds) and interactions run across
   administered + home meds combined — that's the demo moment: "patient
   takes propranolol" + "we gave epi" flags itself.
6. **No sample API Gateway event files** for `sam local invoke` — write
   one per handler if you want faster local iteration than full deploys.
7. **MFA is optional, CORS is `*`** — fine for the demo, called out in
   `docs/HIPAA_NOTES.md` as things to tighten before anything beyond a
   hackathon.

## Commands

There is no linter or CI. Offline tests cover the pure logic in the PCR
pipeline and protocol retrieval scoring; everything else is verified by
`sam build`, a deploy, and hitting the API with `curl` + a JWT (or the app).

```bash
python3 infra/tests/test_pcr_logic.py       # unit-ish, no AWS creds needed
python3 infra/tests/test_protocol_search.py # protocol ranking + seed data
python3 infra/tests/test_drug_classes.py    # class-level interactions + RxClass parsing
python3 infra/tests/test_nasemso_ingest.py  # PDF parsing + extracted seed + retrieval floor
python3 infra/tests/test_drug_sources.py    # FDA label mining + formulary parsing + layer merge
node mobile/tools/test_streaming.mjs        # event-stream codec + SigV4 presigner

# End to end against a deployed stack: Polly speaks the demo narration, then
# it goes through Cognito SRP -> API Gateway -> Transcribe -> Bedrock ->
# drug cross-check, and asserts the interaction gets flagged. ~15s.
python3 infra/tests/smoke_test_pcr.py \
  --username demo@ems-copilot.test --password '<password>'

# Re-pick the extraction model (costs a few cents of Bedrock inference)
python3 infra/tests/eval_models.py
```

```bash
# Backend -- run from infra/
sam build                       # builds the common layer + all 6 functions
sam deploy                      # samconfig.toml: stack ems-copilot-dev, us-east-1
sam deploy --guided             # first time only, or to change stack/region
aws cloudformation describe-stacks --stack-name ems-copilot-dev \
  --query "Stacks[0].Outputs" --output table    # ApiUrl / UserPoolId / UserPoolClientId
sam logs -n ProtocolFunction --stack-name ems-copilot-dev --tail
sam delete --stack-name ems-copilot-dev         # empty the S3 buckets first if it fails

# Seed the reference tables (after deploy, once per environment)
python3 infra/seed/seed_tables.py --stage dev --region us-east-1

# Refresh drug classes from NLM RxClass into the seed file (no AWS calls,
# writes only drug_reference_seed.json -- review the diff, then re-seed)
python3 infra/seed/seed_tables.py --refresh-classes

# Re-extract the 71 NASEMSO protocols from the PDF (needs poppler-utils;
# deterministic, no model calls). The PDF is not vendored -- nasemso.org
# 403s automation, so pull it from a state EMS mirror, e.g.
# https://ems.utah.gov/wp-content/uploads/sites/34/2024/05/National-Model-EMS-Clinical-Guidelines_2022.pdf
python3 infra/seed/ingest_nasemso.py --pdf National-Model-EMS-Clinical-Guidelines_2022.pdf

# Same PDF, Appendix III: the 65-drug EMS formulary -> drug_reference_seed.json
python3 infra/seed/ingest_nasemso_meds.py --pdf National-Model-EMS-Clinical-Guidelines_2022.pdf

# Mine FDA labelling (openFDA) for contraindications, with citations. No AWS
# calls, no model; writes only `label_contraindications`. Review the diff.
python3 infra/seed/seed_tables.py --refresh-labels

# Adds lay-phrasing `symptoms` via Bedrock. Tried, measured, NOT shipped --
# it did not improve retrieval (13/18 -> 11/18 at weight 3.0, 13/18 with
# pruning and zero queries changed). Read its docstring before re-running.
python3 infra/seed/generate_symptoms.py
python3 infra/seed/generate_symptoms.py --check   # self-retrieval gate

# Mobile -- run from mobile/
npm install
npx expo start                  # scan the QR with Expo Go; no Xcode/Mac needed
```

Two things that bite when iterating:

- **`sam local invoke` needs explicit env vars.** The handlers' fallback
  table names (`ems-copilot-encounters`) have no `-${Stage}` suffix, but the
  real tables do (`ems-copilot-encounters-dev`). Locally the Globals block
  isn't applied, so pass `--env-vars` with the real names or every DynamoDB
  call 404s. There are no sample event files yet (TODO 6 below).
- **Getting a JWT for `curl` takes an extra step.** The user pool client
  only enables `ALLOW_USER_SRP_AUTH` + refresh, so
  `initiate-auth --auth-flow USER_PASSWORD_AUTH` fails. Don't weaken the
  pool for this: `pip install pycognito` and do SRP the way the app does
  (see `login()` in `infra/tests/smoke_test_pcr.py`). Pass the token as a
  bare `Authorization: <IdToken>` header — no `Bearer ` prefix.
- **`samconfig.toml` overrides the template's parameter defaults, and
  CloudFormation keeps a parameter's previous value when you omit it.**
  `sam deploy --guided` writes the defaults-at-the-time into
  `parameter_overrides`, so editing `Default:` in `template.yaml` changes
  nothing on an already-deployed stack. Change `BedrockModelId` in
  `samconfig.toml`. (This is why the stack spent a while calling a retired
  model and reporting it as "this model version has reached the end of its
  life" — which reads like a model problem and isn't.)

## Endpoints

Every route sits behind the same Cognito JWT authorizer
(`HttpApi.Auth.DefaultAuthorizer`) and the same IAM role.

| Route | Handler | Client method |
|---|---|---|
| `GET /pcr/upload-url` | `src/pcr/upload_url.py:handler` | `api.getUploadUrl` |
| `POST /pcr/generate` | `src/pcr/app.py:handler` | `api.generatePcr` |
| `GET /pcr/{encounter_id}` | `src/pcr/status.py:handler` | `api.getPcr` |
| `POST /pcr/stream-chunk` | `src/pcr/chunk.py:handler` | `api.sendChunk` |
| `GET /pcr/{encounter_id}/live` | `src/pcr/live.py:handler` | `api.getLiveTranscript` |
| `POST /pcr/finalize` | `src/pcr/finalize.py:handler` | `api.finalizePcr` |
| `POST /pcr/{encounter_id}/commit` | `src/pcr/records.py:commit_handler` | `api.commitPcr` |
| `GET /pcr/saved` | `src/pcr/records.py:list_handler` | `api.listSavedPcrs` |
| `POST /protocol/query` | `src/protocol/app.py:handler` | `api.queryProtocol` |
| `GET /protocol/list` | `src/protocol/browse.py:list_handler` | `api.listProtocols` |
| `GET /protocol/{protocol_id}` | `src/protocol/browse.py:detail_handler` | `api.getProtocol` |
| `GET /drug/list` | `src/drug/browse.py:list_handler` | `api.listDrugs` |
| `POST /translate` | `src/translate/app.py:handler` | `api.translate` |
| `POST /drug/lookup` | `src/drug/app.py:lookup_handler` | `api.lookupDrug` |
| `POST /drug/check-interaction` | `src/drug/app.py:interaction_handler` | `api.checkInteraction` |

## Architecture at a glance

```
Expo app (Cognito-authenticated)
  -> API Gateway (JWT authorizer on every route)
    -> Lambda (one per endpoint, shared "common" layer for audit+response helpers)
      -> Transcribe / Bedrock / Comprehend Medical / Translate / Polly
      -> DynamoDB: Encounters, AuditLog (append-only), Protocols, DrugReference
      -> S3: raw audio (7-day lifecycle expiry)
  CloudTrail: account-level audit, separate from the app-level AuditLog table
  KMS: one CMK encrypts everything above
```

## Key files to know

| File | What it is |
|---|---|
| `infra/template.yaml` | The entire AWS stack, one file |
| `infra/layers/common/python/common/audit.py` | Append-only audit logging — every handler calls this |
| `infra/layers/common/python/common/responses.py` | Response formatting + pulling the Cognito user ID out of the JWT |
| `infra/src/*/app.py` | The 4 feature handlers |
| `infra/src/pcr/status.py` | PCR poll target: Bedrock extraction + drug cross-check |
| `infra/src/protocol/search.py` | Protocol ranking — pure logic, no boto3, so it's testable offline |
| `infra/layers/common/python/common/drugs.py` | Drug lookup/interaction rules, shared by the drug endpoints and the PCR pipeline |
| `infra/seed/rxclass.py` | NLM RxClass client — seed-time only, never called from a Lambda |
| `infra/seed/openfda.py` | FDA label mining — seed-time only, extractive, never a model |
| `infra/seed/ingest_nasemso_meds.py` | NASEMSO Appendix III → the 65-drug EMS formulary |
| `infra/seed/ingest_nasemso.py` | NASEMSO PDF → protocol records; deterministic, verbatim, no model |
| `infra/seed/generate_symptoms.py` | Optional Bedrock pass adding lay-phrasing `symptoms` |
| `infra/seed/nasemso_protocol_seed.json` | The 71 extracted guidelines — what gets seeded by default |
| `infra/seed/*.json` | Demo drug/protocol data — **not clinically authoritative, labeled as such in the files**; includes alias rows for field slang |
| `infra/tests/smoke_test_pcr.py` | End-to-end pipeline test against a live stack (Polly-generated audio, real SRP login) |
| `infra/tests/eval_models.py` | Model-selection harness; re-run before changing `BedrockModelId` |
| `mobile/App.js` | Navigation shell + login |
| `mobile/src/screens/*.js` | The feature screens, incl. the browse + detail pairs |
| `mobile/src/components/ui.js` | Shared browse controls (pills, segmented, cards, lists) |
| `mobile/src/config.js` | **Fill this in from `sam deploy` outputs before running the app** |
| `docs/HIPAA_NOTES.md` | Compliance posture, what's real vs. aspirational, service-by-service eligibility notes |
| `infra/README.md` | Full deploy walkthrough |

## Wiring conventions (what one new endpoint touches)

All six functions share **one IAM role** (`EncounterFunctionsRole`) and
**one env-var block** (`Globals.Function.Environment`), so adding an
endpoint is a four-file change:

1. `template.yaml`: an `AWS::Serverless::Function` with
   `Role: !GetAtt EncounterFunctionsRole.Arn`, `Layers: [!Ref CommonLayer]`,
   and an `HttpApi` event (the default authorizer covers it automatically).
2. `template.yaml` again if it calls a new AWS service or table — add the
   statement to `EncounterFunctionsRole`, and for a new table also add its
   name to `Globals.Function.Environment.Variables` (handlers read table
   names from env, never hardcoded).
3. The handler: `get_user_id(event)` first, return through `ok()` / `error()`
   (never a raw dict — the CORS headers live in those helpers), and
   `log_audit_event(...)` before returning.
4. `mobile/src/api/client.js`: a method on the exported `api` object.

### Data model

- **Encounters** — PK `encounter_id`, PCR rows tagged `record_type: "PCR"`.
  Single-attribute key: a second write for the same encounter overwrites
  the first, so version it if you add an update path.
- **AuditLog** — PK `encounter_id`, SK `sort_key` = `<epoch_ms>#<uuid>`.
  The role has `PutItem` and deliberately no `UpdateItem`/`DeleteItem` —
  that IAM gap is what makes it append-only. Only a SHA-256 `payload_hash`
  is stored, never the payload. Non-encounter actions pass
  `encounter_id="N/A"`.
- **Protocols** — seeded from **`nasemso_protocol_seed.json`: 71 guidelines
  extracted from the NASEMSO National Model EMS Clinical Guidelines v3**,
  verbatim with page citations. `protocol_reference_seed.json` (the 3
  hand-written demo protocols) is still in the repo but is **no longer
  seeded** — it's the fixture `test_protocol_search.py` scores against, and
  `seed_tables.py --demo-protocols` puts it back. The two sets are
  deliberately never merged: both cover anaphylaxis, opioid overdose and
  chest pain, and seeding both puts two competing protocols in front of a
  medic for one presentation. `seed_tables.py` deletes protocol rows absent
  from the file it's seeding, so switching sets doesn't leave strays.
- **Retrieval over 71 guidelines is materially harder than over 3, and the
  scorer is a stopgap.** `search.py` now weights terms by IDF (without it,
  "burn victim from a house fire" answered with the lightning-strike
  guideline — it matched the filler better), requires a query to cover 40%
  of its terms, and makes a one-word query match a `title`/`synonyms`/
  `symptoms` field rather than anything buried in a step. It scores ~13/18
  on the benchmark in `test_nasemso_ingest.py::TestRetrievalQuality`, which
  is pinned as a **floor, not a target**. Every remaining miss is the same
  failure: the words an EMT says ("stung by a bee", "crushing substernal",
  "pulled from a lake") have a document frequency of ~0 because NASEMSO's
  prose doesn't use them. Scoring cannot bridge that — only a vocabulary
  layer (`generate_symptoms.py`) or a real semantic index (Bedrock
  Knowledge Base / OpenSearch) can, and the latter remains the documented
  right answer. **The generated-symptom route was tried and measured, and
  it does not work** — see `generate_symptoms.py`'s docstring. A model shown
  the guideline's own text can only return vocabulary that text already
  has, plus generic symptoms 10+ guidelines share; it cannot invent the
  bridge. Closing this needs field language from outside the document
  (EMT-written queries, dispatch complaint text) or a semantic index.
- **Protocols** — PK `protocol_id`. Retrieval is `scan(Limit=200)` in
  `protocol/app.py` plus token scoring in `protocol/search.py`; fine at seed
  scale, first thing to replace (Bedrock Knowledge Base / OpenSearch) if the
  table grows. Each record carries `symptoms` and `synonyms` — the phrasings
  an EMT actually uses ("stung by a bee", "narcan", "pinpoint pupils") — and
  they are **load-bearing for retrieval**: a protocol added without them is
  invisible to any query that doesn't name it directly. They are retrieval
  aids, *not* diagnostic criteria, and the prompt says so explicitly.
- **DrugReference** — PK `drug_name`, **lowercase**. `_normalize_drug_name`
  runs Comprehend Medical `InferRxNorm` then lowercases, so seed keys must
  be lowercase or every lookup misses.

### Browsing the reference libraries

- **Every library screen is browse-first, because searching a 71-guideline
  table assumes you know what's in it.** `ProtocolScreen` and `DrugScreen`
  each carry a `Segmented` mode switch: Ask/Browse and Formulary/Check
  interaction. `SavedPcrsScreen` was already a scrollable list and is
  unchanged.
- **List and detail are separate calls on purpose.** The 71 protocol
  records are ~400 KB in full because each carries verbatim steps,
  assessment and safety text. `GET /protocol/list` projects only what a
  card renders (`title`, `category`, `summary`, `step_count`,
  `source_page`); `GET /protocol/{protocol_id}` fetches the rest when a
  medic opens one. Don't "simplify" this by returning whole records from
  the list.
- **`GET /protocol/list` and `GET /protocol/{protocol_id}` coexist**
  because HTTP APIs route the path with more literal segments first, so
  "list" is never captured as a protocol id. Verified deployed: the two
  routes resolve to different integrations.
- **Browse handlers paginate the scan.** `scan(Limit=200)` elsewhere caps
  items evaluated *per page*, not in total, so it silently returns a
  partial table once the data outgrows a page. A browse list that quietly
  omits guidelines is worse than a slow one — `_scan_all` follows
  `LastEvaluatedKey`.
- **`GET /drug/list` hides alias rows and attaches them to their target.**
  The table stores field slang as its own rows so speech resolves, but a
  formulary listing seven drugs and fifteen nicknames is noise; each card
  carries its aliases instead, which doubles as "what do I call this on the
  radio". Filtering in the app searches those aliases, so typing "narcan"
  finds naloxone exactly as saying it would.
- **Interaction flags render their `basis`.** A curated clinical rule and
  one derived from RxClass classes say so differently on screen — they are
  different levels of authority and must not read identically.

### Behaviors worth knowing before you edit

- **The app streams audio straight to Amazon Transcribe.**
  `useAudioStream` (expo-audio 57, works in Expo Go) gives int16 PCM
  buffers; `src/api/transcribeStream.js` wraps them in AWS event-stream
  frames and pushes them over a WebSocket the *device* signs with SigV4,
  using temporary credentials from the Cognito identity pool
  (`src/api/awsCreds.js`). Audio never touches our backend on this path —
  the first the stack hears of an encounter is the finished transcript
  POSTed to `/pcr/finalize`. Compliance consequences are item 8 of
  `docs/HIPAA_NOTES.md`; read it before changing this.
  - `COGNITO_IDENTITY_POOL_ID` **must be filled into
    `mobile/src/config.js`** from the `IdentityPoolId` stack output, or
    recording fails at "Connecting to transcription…".
  - The event-stream codec and the presigner are covered offline by
    `node mobile/tools/test_streaming.mjs`. Run it after touching either;
    a wrong CRC or an unencoded query character just gets the socket
    closed by AWS with no usable error.
  - Sample rate is read from `stream.sampleRate` *after* `stream.start()`
    and baked into the signed URL. It can't be assumed — the hardware may
    refuse 16 kHz, and a mismatch produces garbled text, not an error.
- **Extraction is asynchronous and the client polls for it.**
  `/pcr/finalize` persists the transcript, marks the record `EXTRACTING`,
  re-invokes its own Lambda with `InvocationType="Event"`, and returns
  202; the app polls `GET /pcr/{id}` until `DRAFT`. Running Bedrock inline
  is what made long recordings fail: the request passed API Gateway's
  non-adjustable 30s ceiling and 504'd while the Lambda went on to write a
  perfectly good draft nobody ever saw. Don't move it back inline.
- **Each recording gets a unique `encounter_id`** (`${base}-${timestamp}`).
  It used to come from a per-mount attempt counter, so navigating away and
  back reused the previous encounter — and its stored transcript then
  appeared prefixed to the next recording.
- **The chunked path is still deployed and still works** (`/pcr/stream-chunk`
  -> `/pcr/{id}/live` -> `/pcr/finalize` with no `transcript` in the body).
  It's the fallback that needs no identity pool and keeps audio in the
  CMK-encrypted bucket. `api.sendChunk`/`api.getLiveTranscript` are still
  in the client; the screen no longer calls them.
  - If you revive it: `recorder.prepareToRecordAsync()` must get options on
    every call, or expo-audio's iOS side reuses one AVAudioRecorder and
    file URL and each chunk overwrites the last mid-upload. And chunk state
    is a DynamoDB map written with `UpdateItem` per key because uploads
    overlap — a whole-record `PutItem` there silently drops chunks.
- **Saved PCRs come from the sparse `ByUserSaved` GSI** (`created_by` +
  `saved_at`). Only `/commit` writes `saved_at`, so drafts never appear in
  the list. The GSI projects the flat `summary_*` / `search_text` /
  `flag_count` attributes from `build_summary_attrs`; a new list-card
  field has to be added there *and* to `NonKeyAttributes`.
- **Interaction checks run four rule layers, and the merge direction is a
  safety property.** Highest authority first: curated pairs
  (`contraindicated_with`), curated class rules
  (`curated_contraindicated_classes`), FDA labelling
  (`label_contraindications`), then RxClass classes
  (`contraindicated_classes`). Every layer only **adds** flags; none may
  remove another's, because each is blind where the others see. RxClass has
  no epinephrine/propranolol relation at all. RxClass records nitrate/PDE5
  on nitroglycerin's side only, leaving sildenafil's record empty — so amyl
  nitrite, which the formulary carries, flagged against nothing until FDA
  labelling supplied the reciprocal direction. And labelling in turn says
  nothing about epinephrine and beta blockers in its contraindications
  section. A pair matched by several layers is reported once, by the
  highest, and every flag carries `basis` plus (for label rows) the
  verbatim sentence and a DailyMed link. 69 drugs, 2346 pairs, 12 flags.
- **`curated_contraindicated_classes` is how a mechanism gets written once.**
  "Epinephrine must not meet a non-selective beta blocker" covers
  propranolol, labetalol, nadolol and sotalol — and is keyed on the
  **beta-2 antagonist** class deliberately, so beta-1 selective agents like
  metoprolol correctly do *not* fire. Over-warning costs a real drug.
  `--refresh-classes` never touches this field; it owns `classes` and
  `contraindicated_classes` only.
- **`class_exclusions` overrides a derived classification, with a reason.**
  RxClass files nitrous oxide under the MoA "Nitric Oxide Donors" — true of
  the chemistry, false of the clinical rule. Without the exclusion every
  PDE5 inhibitor's labelling told a medic to withhold Entonox from a
  patient who took Viagra. Dropping the class outright is *not* the fix:
  amyl nitrite is an organic nitrite, genuinely carries the interaction,
  and that class is the only one RxClass gives it.
- **`--refresh-labels` mines FDA labelling extractively, never with a model.**
  Each row keeps the label's own sentence and its DailyMed set id, so every
  flag traces to a line a human can read. Three guards, each of which was
  added after it produced a wrong flag against the real API: only
  single-ingredient labels whose generic name matches (searching "naloxone"
  returns pentazocine/naloxone first, "nitroglycerin" returns a homeopathic
  remedy); only the `contraindications` and `boxed_warning` sections
  (`drug_interactions` is pharmacokinetics and *negative* findings — it
  yielded a flag from vardenafil's "did not potentiate"); and a
  co-administration cue **judged near the drug mention**, which is what
  separates "do not give with X" from patient history ("reactions after
  taking aspirin") and from diluent notes ("dextrose ... allergy to corn").
- **`--refresh-classes` writes the seed file, not DynamoDB, and never
  touches `contraindicated_with`.** Class data is reviewed in a diff before
  it reaches a medic, and no Lambda makes an outbound call — RxClass is a
  terminology service, not a clinical interaction database, and it should
  not be silently authoritative in a field tool. Two traps if you touch
  `seed/rxclass.py`: `byRxcui` **ignores the `rela` query parameter** and
  returns contraindication relations mixed in with membership ones (filter
  client-side on each row's `rela`, or nitroglycerin comes back as a member
  of the PDE5 class it's merely contraindicated with, and matches itself);
  and **ATC is the wrong vocabulary** — its `G04BE` lumps alprostadil in
  with the PDE5 inhibitors, so only MoA and EPC are kept.
- Both Bedrock callers use the **Converse API** at `temperature: 0`, not
  `invoke_model` — Converse is provider-agnostic, so `BedrockModelId` can
  point at Nova, Llama, Mistral, GPT-OSS, etc. without touching code.
  `pcr/status.py` still slices the first `{` to the last `}` out of the
  reply before parsing, since models wrap JSON in prose regardless.
- **Drug names arrive from speech**, so `common/drugs.py` resolves in three
  steps: literal name, then alias rows in the table
  (`{"drug_name": "epi", "alias_of": "epinephrine"}`), then Comprehend
  Medical RxNorm. Alias rows are load-bearing, not a convenience: RxNorm
  maps "narcan" to the *brand* concept rather than naloxone, and returns no
  entity at all for "epi" or "nitro". Teach it a new nickname by seeding a
  row, not by editing code.
- **Sign-in is a bare `fetch` to Cognito `InitiateAuth`
  (`USER_PASSWORD_AUTH`), deliberately not the SDK's SRP flow.** SRP's
  pure-JS bignum math takes tens of seconds on Hermes and blocks the UI
  thread; this returns in ~350ms. Don't "fix" this by reinstating
  `amazon-cognito-identity-js` without a native crypto module — and that
  module rules out Expo Go. Tradeoff recorded in `docs/HIPAA_NOTES.md`.
- **Mobile is on Expo SDK 57, which matters for audio.** `expo-av` was
  removed after SDK 54; recording and playback use `expo-audio`
  (`useAudioRecorder` + `RecordingPresets.HIGH_QUALITY`, `createAudioPlayer`).
  `expo-file-system` is the class-based API too — `new File(uri).upload(...)`,
  not `FileSystem.uploadAsync`. Verify changes with
  `npx expo export --platform ios`, which catches import errors without a
  device. Note `amazon-cognito-identity-js` needs
  `@react-native-async-storage/async-storage` present or login fails at
  bundle time.
- **The presigned upload URL signs `Content-Type`** and returns it as
  `content_type`; the client must echo that exact value on the PUT or S3
  answers 403 `SignatureDoesNotMatch`, which looks like a permissions bug.
  The S3 client is pinned to SigV4 for the same reason.
- Audio never passes through Lambda: `GET /pcr/upload-url` returns a
  5-minute presigned PUT, the app uploads to S3 directly, then posts the
  returned `s3_key` to `/pcr/generate`. Bucket objects expire after 7 days.
- Mobile auth caches the Cognito ID token in a module-level variable in
  `src/api/auth.js` — lost on reload, with no refresh and no MFA-challenge
  branch.

## Ground rules while building on this

- Never put real patient data through this stack. Seed/demo data only,
  labeled as such. This is a hackathon compliance posture, not a
  production one — see `docs/HIPAA_NOTES.md`.
- Every new Lambda that touches `EncountersTable`, `DrugReferenceTable`, or
  `ProtocolTable` should call `log_audit_event(...)` from the common layer
  — that's the whole point of the audit-trail requirement, don't let new
  code skip it.
- Keep the protocol/dosage assistant retrieval-only (candidates come from
  DynamoDB, Bedrock only phrases/matches — see the prompt in
  `protocol/app.py`). Don't let it start free-generating dosages from
  model knowledge; that's a deliberate liability/safety boundary, not an
  oversight.
