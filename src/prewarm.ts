import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const WARM_TIMEOUT_MS = 180_000;
export const KEPT_HEAD_TOKENS = 2048;
const WARM_TAIL_TOKENS = 16;

export function needsWarm(warmPromptTokens: number | null): boolean {
  return warmPromptTokens === null || warmPromptTokens - WARM_TAIL_TOKENS < KEPT_HEAD_TOKENS;
}

export async function countTokens(port: number, payload: Payload, apiKey?: string): Promise<number | null> {
  try {
    const { stream, max_completion_tokens, ...body } = warmBody(payload);
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions/count_tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const n = r.ok ? (await r.json())?.input_tokens : null;
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

type Message = { role?: string; content?: unknown };
type Payload = { messages?: Message[]; tools?: unknown; [key: string]: unknown };

export function opensSession(payload: Payload): boolean {
  const m = payload?.messages;
  return Array.isArray(m) && m.length === 2 && m[0]?.role === "system" && m[1]?.role === "user";
}

export function headKey(payload: Payload): string {
  const { messages, stream, stream_options, max_tokens, max_completion_tokens, ...rest } = payload;
  return createHash("sha256").update(JSON.stringify([messages?.[0], rest])).digest("hex").slice(0, 32);
}

export function warmBody(payload: Payload): Payload {
  const { messages, stream, stream_options, max_tokens, ...rest } = payload;
  return { ...rest, messages: [messages![0], { role: "user", content: "." }], stream: false, max_completion_tokens: 1 };
}

type Warmed = { pid: number; keys: string[] };

export function warmedPath(dir: string, port: number) {
  return join(dir, `warmed-${port}.json`);
}

export function readWarmed(dir: string, port: number, pid: number): Set<string> {
  try {
    const w: Warmed = JSON.parse(readFileSync(warmedPath(dir, port), "utf8"));
    return new Set(w.pid === pid ? w.keys : []);
  } catch {
    return new Set();
  }
}

export function writeWarmed(dir: string, port: number, pid: number, keys: Set<string>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(warmedPath(dir, port), JSON.stringify({ pid, keys: [...keys].slice(-64) }));
}

export async function warm(port: number, payload: Payload, apiKey?: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(warmBody(payload)),
      signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
    });
    await r.text();
    return r.ok;
  } catch {
    return false;
  }
}
