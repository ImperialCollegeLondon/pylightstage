/** Shared HTTP boundary. Commands are never retried: they may already have run. */
async function request(path, operation, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned an invalid response (${response.status}).`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${operation} returned an invalid response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(typeof payload.error === "string"
      ? payload.error : `${operation} failed (${response.status}).`);
  }
  return payload;
}

function post(path, operation, payload) {
  return request(path, operation, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function loadConfiguration() {
  return request("/api/config", "Configuration request");
}

export async function readServer(action) {
  const payload = await request(
    `/api/inspect?action=${encodeURIComponent(action)}`, "Server inspection",
  );
  return payload.result;
}

export function controlFixture(payload) {
  return post("/api/fixture", "Fixture control", payload);
}

export async function requestMode(payload) {
  return (await post("/api/mode", "Mode request", payload)).result;
}

export async function sequenceRequest(payload, file = null) {
  const result = file
    ? await request(`/api/sequences/import?filename=${encodeURIComponent(file.name)}`, "Sequence import", {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
    })
    : await post("/api/sequences", "Sequence request", payload);
  return result.result;
}

export async function triggerCamera() {
  return (await post("/api/capture", "Camera capture", {})).result;
}
