// v265: shared Gemini fetch with retry on rate-limiting.
// Google's API answers 429/503 when the key's quota is briefly exhausted;
// a short exponential backoff usually sails through. Always returns the
// Response object ({ ok, res, status, networkError }) so callers keep their
// existing status-handling semantics.
export async function geminiFetch(url, init, tries = 3) {
  let lastStatus = 0;
  let lastRes = null;
  for (let i = 0; i < tries; i++) {
    let r;
    try {
      r = await fetch(url, init);
    } catch (e) {
      return { ok: false, res: null, status: 0, networkError: true };
    }
    if (r.ok) return { ok: true, res: r, status: r.status, networkError: false };
    lastStatus = r.status;
    lastRes = r;
    if ((r.status === 429 || r.status === 503) && i < tries - 1) {
      await new Promise(res => setTimeout(res, 1500 * 2 ** i));
      continue;
    }
    return { ok: false, res: r, status: r.status, networkError: false };
  }
  return { ok: false, res: lastRes, status: lastStatus, networkError: false };
}
