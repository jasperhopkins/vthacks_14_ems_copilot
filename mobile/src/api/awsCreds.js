// Temporary AWS credentials for the device, via the Cognito identity pool.
//
// This is the only place the app holds real AWS credentials, and they are
// scoped to a single action: transcribe:StartStreamTranscriptionWebSocket
// (see TranscribeStreamingRole in template.yaml). Everything touching
// patient data still goes through API Gateway with the ID token. If live
// transcription is ever dropped, delete this file and the identity pool
// with it.
//
// Plain fetch, like auth.js -- the Cognito Identity API is two JSON calls
// and needs no SDK.
import { AWS_REGION, COGNITO_IDENTITY_POOL_ID, COGNITO_USER_POOL_ID } from "../config";
import { getIdToken } from "./auth";

const ENDPOINT = `https://cognito-identity.${AWS_REGION}.amazonaws.com/`;
// Re-fetch a little before expiry so a stream never opens with credentials
// that die mid-recording.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cached = null;       // { accessKeyId, secretAccessKey, sessionToken, expiresAt }
let cachedIdentityId = null;

async function identity(target, body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.__type || `${target} failed (HTTP ${res.status})`);
  }
  return data;
}

export async function getAwsCredentials() {
  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) return cached;

  const idToken = getIdToken();
  if (!idToken) throw new Error("Not signed in");
  if (!COGNITO_IDENTITY_POOL_ID) {
    throw new Error(
      "COGNITO_IDENTITY_POOL_ID is not set in src/config.js — copy IdentityPoolId from the stack outputs."
    );
  }

  const logins = {
    [`cognito-idp.${AWS_REGION}.amazonaws.com/${COGNITO_USER_POOL_ID}`]: idToken,
  };

  if (!cachedIdentityId) {
    const { IdentityId } = await identity("GetId", {
      IdentityPoolId: COGNITO_IDENTITY_POOL_ID,
      Logins: logins,
    });
    cachedIdentityId = IdentityId;
  }

  const { Credentials } = await identity("GetCredentialsForIdentity", {
    IdentityId: cachedIdentityId,
    Logins: logins,
  });

  cached = {
    accessKeyId: Credentials.AccessKeyId,
    secretAccessKey: Credentials.SecretKey,
    sessionToken: Credentials.SessionToken,
    // Expiration comes back as epoch seconds.
    expiresAt: Number(Credentials.Expiration) * 1000,
  };
  return cached;
}

export function clearAwsCredentials() {
  cached = null;
  cachedIdentityId = null;
}
