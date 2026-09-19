// Filled in from `sam deploy` outputs for the ems-copilot-dev stack.
// Re-fetch anytime with:
//   aws cloudformation describe-stacks --stack-name ems-copilot-dev \
//     --query "Stacks[0].Outputs" --output table
export const API_BASE_URL = "https://xhen351tkh.execute-api.us-east-1.amazonaws.com/dev";
export const COGNITO_USER_POOL_ID = "us-east-1_JobThuLMG";
export const COGNITO_CLIENT_ID = "783goek2ve6co2sq97mqsjbtq0";
export const AWS_REGION = "us-east-1";
