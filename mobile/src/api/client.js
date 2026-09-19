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
  getPcr: (encounterId) => request(`/pcr/${encodeURIComponent(encounterId)}`),
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
