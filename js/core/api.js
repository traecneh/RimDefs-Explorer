// Tiny helper for calling the local helper API (if present).
// All methods gracefully reject if the API isn't available.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function jfetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : res.text();
}

export async function ping() {
  try { const r = await jfetch('/api/ping'); return !!r && r.ok; }
  catch { return false; }
}

export async function getConfig() {
  return jfetch('/api/config');
}

export async function putConfig(cfg) {
  return jfetch('/api/config', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify(cfg) });
}

export async function rebuild(body) {
  return jfetch('/api/rebuild', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body || {}) });
}

export async function status(jobId) {
  return jfetch(`/api/status?jobId=${encodeURIComponent(jobId)}`);
}

export async function manifest() {
  return jfetch('/api/data/manifest');
}
