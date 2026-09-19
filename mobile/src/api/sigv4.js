// SigV4 presigning for Amazon Transcribe's streaming WebSocket.
//
// Transcribe streaming is not behind our API Gateway -- the device talks
// to it directly, because a continuous audio stream cannot be proxied
// through request/response Lambdas. That means the phone has to sign the
// connection itself, with temporary credentials from the Cognito identity
// pool (see awsCreds.js and the IdentityPool in template.yaml).
//
// This is a *presigned* request: everything, including the signature, goes
// in the query string, because the WebSocket handshake gives us no way to
// set an Authorization header.
//
// js-sha256 rather than the AWS SDK: the signing here is four HMACs over a
// few hundred bytes, unlike the SRP bignum math that made SDK sign-in
// unusable on Hermes (see auth.js). It measures in single-digit
// milliseconds.
import { sha256 } from "js-sha256";

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "transcribe";

// encodeURIComponent leaves !'()* alone; AWS's canonical form requires
// them percent-encoded, and an unencoded character silently breaks the
// signature match rather than erroring usefully.
function rfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function amzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secretKey, dateStamp, region) {
  const kDate = sha256.hmac.array(`AWS4${secretKey}`, dateStamp);
  const kRegion = sha256.hmac.array(kDate, region);
  const kService = sha256.hmac.array(kRegion, SERVICE);
  return sha256.hmac.array(kService, "aws4_request");
}

/**
 * @returns a wss:// URL valid for `expiresIn` seconds.
 */
export function presignTranscribeWebSocket({
  credentials,
  region,
  sampleRate,
  languageCode = "en-US",
  expiresIn = 300,
  now = new Date(),
}) {
  // Port 8443 is part of the host header, and therefore part of what gets
  // signed -- dropping it produces a signature mismatch.
  const host = `transcribestreaming.${region}.amazonaws.com:8443`;
  const path = "/stream-transcription-websocket";
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;

  const params = {
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${credentials.accessKeyId}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
    "language-code": languageCode,
    "media-encoding": "pcm",
    "sample-rate": String(sampleRate),
    // Stops the tail of the live transcript from rewriting itself on every
    // frame, which reads as flicker on screen.
    "enable-partial-results-stabilization": "true",
    "partial-results-stability": "medium",
  };
  if (credentials.sessionToken) params["X-Amz-Security-Token"] = credentials.sessionToken;

  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`)
    .join("&");

  // A presigned request signs an empty body.
  const canonicalRequest = [
    "GET", path, canonicalQuery, `host:${host}\n`, "host", sha256(""),
  ].join("\n");

  const stringToSign = [ALGORITHM, stamp, scope, sha256(canonicalRequest)].join("\n");
  const signature = sha256.hmac.hex(
    signingKey(credentials.secretAccessKey, dateStamp, region),
    stringToSign
  );

  return `wss://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
