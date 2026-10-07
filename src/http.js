// Shared HTTP plumbing for every provider. Keeping it separate means the provider modules
// depend on this, not on each other, and the dispatcher never has to import them back.

/** An HTTP failure that carries its status, so callers can tell 400 from 429. */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Failures worth another go. 0 means the request never got an answer (DNS, TLS, a
 * dropped socket) — retrying that is free. 429 and 5xx are the provider saying "not right
 * now", which is exactly what a short pause fixes.
 *
 * Deliberately NOT here: 400, 401, 403, 404, 422. Those never resolve themselves, and
 * retrying only burns latency and quota.
 */
const TRANSIENT = new Set([0, 408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526]);

/** Default retry policy: anything that looks temporary. */
export const isTransient = (e) => TRANSIENT.has(e.status);

/** Waits between attempts. Sleeping costs no CPU on Workers, only wall-clock time. */
export const DEFAULT_BACKOFF = [700, 2000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const errorMessage = (json, text) =>
  json?.error?.message ?? json?.error?.error?.message ?? json?.error?.status ?? String(text ?? "").slice(0, 200);

/**
 * POST JSON, parse the reply, and retry a transient failure a couple of times.
 *
 * `retries` is extra attempts, so the default sends at most 3 requests. `retryOn` lets a
 * caller refine the policy — Gemini passes one that keeps a spent daily quota from being
 * retried three times per model, which would burn the whole pool to learn what we already
 * read in the first message. A non-JSON body still throws with its real status, so a
 * Cloudflare HTML block page reads as 403 and is not retried into oblivion.
 */
export async function callJson(url, { headers, body, retries = 2, backoff = DEFAULT_BACKOFF, retryOn = isTransient }) {
  const attempts = Math.max(0, retries) + 1;
  let last;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]);

    let error;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const text = await res.text();

      let json;
      let parsed = false;
      try {
        json = JSON.parse(text);
        parsed = true;
      } catch {
        /* an HTML error page, a proxy timeout, a truncated body */
      }

      if (parsed && res.ok && !json?.error) return json;

      error = parsed
        ? new ApiError(`API ${res.status}: ${errorMessage(json, text)}`, res.status)
        : new ApiError(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`, res.status);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      error = new ApiError(`network error: ${String(e?.message ?? e)}`, 0);
    }

    if (!retryOn(error)) throw error;
    last = error;
  }

  throw last;
}

/** A rejected request shape is worth retrying differently; 429 or 5xx must surface as-is. */
export const isShapeError = (e) => e instanceof ApiError && (e.status === 400 || e.status === 422);

/** A missing credential is the only reason to try the other provider. */
export const isCredentialError = (e) => e instanceof ApiError && (e.status === 500 && /API key|secret/i.test(e.message));
