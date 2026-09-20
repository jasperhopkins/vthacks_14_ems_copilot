import { API_BASE_URL } from "../config";
import { getIdToken } from "./auth";

async function request(path, { method = "GET", body } = {}) {
  const token = getIdToken();
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

export const api = {
  getUploadUrl: (filename) => request(`/pcr/upload-url?filename=${encodeURIComponent(filename)}`),
  generatePcr: (s3Key, encounterId) =>
    request("/pcr/generate", { method: "POST", body: { s3_key: s3Key, encounter_id: encounterId } }),
  // Poll target -- generatePcr only starts the job (see src/pcr/status.py).
  // Doubles as the detail view for a saved PCR.
  getPcr: (encounterId) => request(`/pcr/${encodeURIComponent(encounterId)}`),

  // --- Chunked capture (fallback path) --------------------------------
  // Not used by the app any more: PcrScreen streams to Transcribe
  // directly. Kept because the endpoints are deployed and are the only
  // capture path that works without the identity pool.
  sendChunk: (encounterId, s3Key, seq) =>
    request("/pcr/stream-chunk", { method: "POST", body: { encounter_id: encounterId, s3_key: s3Key, seq } }),
  getLiveTranscript: (encounterId) =>
    request(`/pcr/${encodeURIComponent(encounterId)}/live`),

  // Hands the finished transcript to Bedrock extraction. Returns 202
  // immediately (the model call runs asynchronously -- a long transcript
  // would blow API Gateway's 30s ceiling), so poll getPcr until the status
  // is DRAFT. Omit `transcript` to use the chunked path's stitched text.
  finalizePcr: (encounterId, transcript) =>
    request("/pcr/finalize", {
      method: "POST",
      body: { encounter_id: encounterId, transcript },
    }),

  // --- The durable PCR store ------------------------------------------
  // Nothing appears in listSavedPcrs until commitPcr files it.
  commitPcr: (encounterId, pcr, crewNotes) =>
    request(`/pcr/${encodeURIComponent(encounterId)}/commit`, {
      method: "POST",
      body: { pcr, crew_notes: crewNotes },
    }),
  listSavedPcrs: ({ q, flagged, from, to, limit, cursor } = {}) => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (flagged) params.set("flagged", "true");
    if (from) params.set("from", String(from));
    if (to) params.set("to", String(to));
    if (limit) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return request(`/pcr/saved${qs ? `?${qs}` : ""}`);
  },
  // --- Browsing the reference libraries -------------------------------
  // The list calls return card-shaped rows only; the full protocol record
  // is ~6 KB and there are 71 of them, so detail is a second request.
  listProtocols: () => request("/protocol/list"),
  getProtocol: (protocolId) => request(`/protocol/${encodeURIComponent(protocolId)}`),
  listDrugs: () => request("/drug/list"),
  listInteractions: () => request("/drug/interactions"),

  queryProtocol: (query, weightKg, encounterId) =>
    request("/protocol/query", {
      method: "POST",
      body: { query, patient_weight_kg: weightKg, encounter_id: encounterId },
    }),
  translate: (text, sourceLang, targetLang, encounterId) =>
    request("/translate", {
      method: "POST",
      body: { text, source_lang: sourceLang, target_lang: targetLang, encounter_id: encounterId },
    }),
  lookupDrug: (drugName, encounterId) =>
    request("/drug/lookup", { method: "POST", body: { drug_name: drugName, encounter_id: encounterId } }),
  checkInteraction: (drugs, encounterId) =>
    request("/drug/check-interaction", { method: "POST", body: { drugs, encounter_id: encounterId } }),
};
