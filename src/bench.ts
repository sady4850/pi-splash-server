import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { environment, memorySample, type BenchEnvironment, type MemorySample } from "./bench-env.ts";
import { probe, STATE_DIR } from "./server.ts";

export const BENCH_VERSION = 1;

const code = `Rewrite this TypeScript function with clearer names and add input validation. Answer only with code.

function group(a: { day: string; site: string; value: number }[], n: number) {
  const m = new Map<string, number[]>();
  const d = new Map<string, Set<string>>();
  for (const x of a) {
    const k = x.site;
    let v = m.get(k);
    if (!v) {
      v = [];
      m.set(k, v);
    }
    v.push(x.value);
    let s = d.get(k);
    if (!s) {
      s = new Set();
      d.set(k, s);
    }
    s.add(x.day);
  }
  const r = [];
  for (const [k, v] of m) {
    if (v.length < n) continue;
    let t = 0;
    let lo = v[0];
    let hi = v[0];
    for (const x of v) {
      t += x;
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
    r.push({
      site: k,
      days: d.get(k)!.size,
      count: v.length,
      mean: t / v.length,
      low: lo,
      high: hi,
    });
  }
  return r.sort((x, y) => y.mean - x.mean);
}`;

const prose = "Explain in about 250 words how a hash map handles collisions. Write plain prose.";
const nonce = () => `bench ${randomBytes(12).toString("hex")}`;
const user = (content: string) => ({ role: "user", content });

export async function buildPrompt(source: string, prefix: string, target: number, count: (prompt: string) => Promise<number>, limit = target * 1.05) {
  if (!source || limit < target * 0.95) throw new Error(`Could not fit a ${target}-token prompt`);
  let length = target * 4;
  let lower = 0;
  let upper = Infinity;
  for (let i = 0; i < 24; i++) {
    const prompt = prefix + "\n" + source.repeat(Math.ceil(length / source.length)).slice(0, length);
    const tokens = await count(prompt);
    if (!Number.isInteger(tokens) || tokens <= 0) throw new Error("Invalid input_tokens from count_tokens");
    if (tokens >= target * 0.95 && tokens <= Math.min(target * 1.05, limit)) return prompt;
    if (tokens < target * 0.95) lower = length;
    else upper = length;
    if (upper - lower <= 1 || lower >= target * 64) break;
    length = Number.isFinite(upper) ? Math.floor((lower + upper) / 2) : Math.min(length * 2, Math.ceil(length * target / tokens));
  }
  throw new Error(`Could not fit a ${target}-token prompt`);
}

function numericFields(obj: any): Record<string, number> {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([, value]) => Number.isFinite(value))) as Record<string, number>;
}

export function parseMeasurement(response: any) {
  const usage = response?.usage;
  if (!Number.isFinite(usage?.prompt_tokens) || !Number.isFinite(usage?.completion_tokens)) throw new Error("Missing token usage");
  const latency = numericFields(response.metrics?.request_latency);
  const timings = numericFields(response.timings);
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: Number(usage.prompt_tokens), completionTokens: Number(usage.completion_tokens),
    cachedTokens: Number.isFinite(cached) ? Number(cached) : null, ttftMs: latency.ttft_ms ?? latency.wall_ms ?? null,
    timings, latency,
    draftAcceptance: timings.draft_n > 0 && timings.draft_n_accepted != null ? timings.draft_n_accepted / timings.draft_n : null,
  };
}

type Group = "warm-up" | "prefill 1K" | "prefill 8K" | "replay 8K" | "code" | "prose" | "prefill 32K";
export type BenchRequest = { test: Group } & ReturnType<typeof parseMeasurement>;
export type BenchResult = {
  benchVersion: number; startedAt: string; durationMs: number; long: boolean; environment: BenchEnvironment;
  before: MemorySample; after: MemorySample; requests: BenchRequest[]; counts: { test: Group; inputTokens: number }[];
  note?: string; error?: string;
};

type Message = { role: string; content: string };
type Launcher = { name: string; path: string | null };
type Progress = (step: string) => void;

async function workloads(port: number, model: string, signal: AbortSignal, progress: Progress, result: BenchResult) {
  const { context } = result.environment;
  const url = `http://127.0.0.1:${port}/v1/chat/completions`;
  const apiKey = process.env.SPLASH_API_KEY;
  const headers = { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  const base = { model, reasoning_effort: "none", temperature: 0 };
  const source = await readFile(new URL("../data/bench.txt", import.meta.url), "utf8");
  const long = result.long && context >= 32768;
  if (result.long && !long) result.note = `Skipped 32K prefill (${context} context).`;
  let step = 0;
  let test: Group = "warm-up";

  function begin(group: Group) {
    test = group;
    progress(`${++step}/${long ? 13 : 12} ${test}`);
  }

  async function post(messages: Message[], maxTokens?: number) {
    const path = maxTokens === undefined ? "/count_tokens" : "";
    const body = maxTokens === undefined ? { ...base, messages } : { ...base, messages, stream: false, max_completion_tokens: maxTokens };
    const response = await fetch(url + path, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${path ? "count_tokens" : "chat/completions"} returned HTTP ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  async function measure(messages: Message[], maxTokens: number) {
    result.requests.push({ test, ...parseMeasurement(await post(messages, maxTokens)) });
  }

  async function prefill(group: Group, target: number) {
    begin(group);
    const prompt = await buildPrompt(source, nonce(), target, async (content) => {
      const { input_tokens } = await post([user(content)]);
      result.counts.push({ test, inputTokens: input_tokens });
      return input_tokens;
    }, context - 1);
    const messages = [user(prompt)];
    await measure(messages, 1);
    return messages;
  }

  try {
    begin("warm-up");
    await post([user("Hi")], 1);
    for (let i = 0; i < 3; i++) await prefill("prefill 1K", 1024);
    const messages = await prefill("prefill 8K", 8192);
    begin("replay 8K");
    await measure(messages, 1);
    for (const group of ["code", "prose"] as const) {
      for (let i = 0; i < 3; i++) {
        begin(group);
        await measure([{ role: "system", content: nonce() }, user(group === "code" ? code : prose)], 256);
      }
    }
    if (long) await prefill("prefill 32K", 32768);
  } catch (e) {
    result.error = `${test}: ${signal.aborted ? "aborted" : e instanceof Error ? e.message : String(e)}`;
  }
}

export async function runBench(port: number, long: boolean, signal: AbortSignal, launcher: () => Launcher, progress: Progress) {
  const start = new Date();
  progress("checking server");
  const served = await probe(port, signal);
  signal.throwIfAborted();
  if (!served) throw new Error(`No Splash server on port ${port}. Start one: /splash start`);
  progress("collecting environment");
  const env = await environment(port, launcher(), served);
  const before = await memorySample();
  const result: BenchResult = {
    benchVersion: BENCH_VERSION, startedAt: start.toISOString(), durationMs: 0, long,
    environment: env, before, after: before, requests: [], counts: [],
  };
  await workloads(port, served.id, signal, progress, result);
  result.after = await memorySample();
  result.durationMs = Date.now() - start.getTime();
  const filename = `bench-${result.startedAt}.json`;
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(join(STATE_DIR, filename), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  return { result, filename };
}
