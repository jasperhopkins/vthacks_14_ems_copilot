// Cognito sign-in over plain fetch -- no SDK.
//
// This used to use amazon-cognito-identity-js with the SRP flow. SRP is the
// better flow on paper (the password never leaves the device), but its
// implementation is pure JavaScript: two modular exponentiations over a
// 3072-bit group, which measure ~150ms each on Node's V8 *with* a JIT.
// Hermes has no JIT and is an order of magnitude slower at bignum math, and
// it runs on the JS thread -- so signing in froze the app for tens of
// seconds before the home screen appeared.
//
// USER_PASSWORD_AUTH does no client-side crypto: one HTTPS call to Cognito,
// which returns the tokens directly. The password travels inside TLS.
// See docs/HIPAA_NOTES.md for the tradeoff, and template.yaml's
// ExplicitAuthFlows for the server side.
import { AWS_REGION, COGNITO_CLIENT_ID } from "../config";

const ENDPOINT = `https://cognito-idp.${AWS_REGION}.amazonaws.com/`;

let cachedIdToken = null;

async function cognito(target, body) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Cognito reports failures as {__type, message}; surface the readable one.
    throw new Error(data.message || data.__type || `Sign-in failed (HTTP ${res.status})`);
  }
  return data;
}

export async function login(username, password) {
  const data = await cognito("InitiateAuth", {
    AuthFlow: "USER_PASSWORD_AUTH",
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: username, PASSWORD: password },
  });

  // MFA is OPTIONAL on the pool and a fresh admin-created user can land in
  // NEW_PASSWORD_REQUIRED; neither is handled here. Fail loudly rather than
  // dereferencing an AuthenticationResult that isn't there.
  if (data.ChallengeName) {
    throw new Error(
      `Sign-in needs an unsupported challenge (${data.ChallengeName}). ` +
        "Set a permanent password with `admin-set-user-password --permanent`."
    );
  }

  cachedIdToken = data.AuthenticationResult?.IdToken;
  if (!cachedIdToken) throw new Error("Cognito returned no ID token");
  return cachedIdToken;
}

export function getIdToken() {
  return cachedIdToken;
}

export function logout() {
  cachedIdToken = null;
}
