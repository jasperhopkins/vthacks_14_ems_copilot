// Filled in from `sam deploy` outputs for the ems-copilot-dev stack.
// Re-fetch anytime with:
//   aws cloudformation describe-stacks --stack-name ems-copilot-dev \
//     --query "Stacks[0].Outputs" --output table
export const API_BASE_URL = "https://xhen351tkh.execute-api.us-east-1.amazonaws.com/dev";
export const COGNITO_USER_POOL_ID = "us-east-1_JobThuLMG";
export const COGNITO_CLIENT_ID = "783goek2ve6co2sq97mqsjbtq0";
export const AWS_REGION = "us-east-1";
// Identity pool -- needed for live transcription only. The app trades its
// Cognito ID token here for temporary credentials that can do exactly one
// thing: open a Transcribe streaming WebSocket. See awsCreds.js.
export const COGNITO_IDENTITY_POOL_ID = "us-east-1:033b6cbe-668f-4107-aa11-5f6373aa2d45";
