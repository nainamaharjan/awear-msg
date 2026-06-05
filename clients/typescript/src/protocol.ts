/**
 * Wire protocol: HTTP calls and message (de)serialization.
 *
 * Implements the three endpoints from `spec/protocol.md` using the global
 * `fetch` built into Node 20+ (spec/platform/typescript.md). Every request
 * carries `X-Protocol-Version: 1`.
 *
 * Two failure modes are distinguished, because `behavior.md` treats them
 * differently:
 *
 *  - `NetworkError` — the server is unreachable (connection refused, DNS,
 *    timeout). Callers transition to OFFLINE (behavior.md §2).
 *  - an HTTP non-2xx response — the server is reachable but rejected the
 *    request. This is returned as a normal `{status, payload}` result so the
 *    caller can apply the protocol-error handling of behavior.md §3.2 step 4
 *    (do not go offline).
 */

import type { Message } from "./store";

export const PROTOCOL_VERSION = "1";
const TIMEOUT_MS = 10_000; // a hung connection becomes a NetworkError -> OFFLINE

/** Server unreachable. Triggers the OFFLINE transition (behavior.md §2). */
export class NetworkError extends Error {}

export interface HttpResult {
  status: number;
  payload: Record<string, unknown>;
}

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<HttpResult> {
  const headers: Record<string, string> = {
    "X-Protocol-Version": PROTOCOL_VERSION,
  };
  let data: string | undefined;
  if (body !== undefined) {
    data = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: data,
      signal: controller.signal,
    });
  } catch (err) {
    // fetch rejects only for network-level failures (refused, DNS, abort/
    // timeout). A non-2xx HTTP status does NOT reject — see below.
    throw new NetworkError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text();
  return { status: resp.status, payload: decode(text) };
}

function decode(raw: string): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** POST /session — log in by name (protocol.md §4.1). */
export function postSession(server: string, name: string): Promise<HttpResult> {
  return request("POST", `${server}/session`, { name });
}

/**
 * POST /messages — send one message (protocol.md §4.2).
 * `message` must already carry id/from/to/body/sent_at (no delivery_seq).
 */
export function postMessage(
  server: string,
  message: Message,
): Promise<HttpResult> {
  return request("POST", `${server}/messages`, message);
}

/** GET /messages — poll for messages addressed to `user` (protocol.md §4.3). */
export function getMessages(
  server: string,
  user: string,
  after: number,
): Promise<HttpResult> {
  const query = new URLSearchParams({ user, after: String(after) });
  return request("GET", `${server}/messages?${query.toString()}`);
}
