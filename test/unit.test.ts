import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { macosWarning, parseFamily, runtimeFor } from "../src/mac.ts";
import { recommend, diskWarnings } from "../src/recommend.ts";
import { parseModels, servesModel, parseLaterSystem, startedByUs, describe, lastLine } from "../src/server.ts";
import { providerConfig, providerName } from "../src/provider.ts";

test("chip family and runtime", () => {
  assert.equal(parseFamily("Apple M1 Pro"), 1);
  assert.equal(parseFamily("Apple M4 Max"), 4);
  assert.equal(parseFamily("Intel(R) Core(TM) i9"), null);
  assert.equal(runtimeFor(2), "splash-m1");
  assert.equal(runtimeFor(3), "splash");
  assert.equal(runtimeFor(null), null);
});

test("tier pick", () => {
  assert.equal(recommend({ family: 1, memoryGB: 32 }).pick?.model, "mlx-community/Qwen3.8-27B-GPTQ-4bit");
  assert.equal(recommend({ family: 1, memoryGB: 64 }).pick?.model, "unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_S");
  assert.equal(recommend({ family: 2, memoryGB: 48 }).pick?.model, "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M");
  assert.equal(recommend({ family: 1, memoryGB: 16 }).pick?.model, "prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0");
  assert.equal(recommend({ family: 4, memoryGB: 16 }).pick, null);
  assert.equal(recommend({ family: 1, memoryGB: 8 }).pick, null);
  assert.equal(recommend({ family: null, memoryGB: 64 }).pick, null);
});

test("disk warnings", () => {
  assert.equal(diskWarnings({ freeDiskGB: 100 }, 19).length, 0);
  assert.equal(diskWarnings({ freeDiskGB: 16 }, 0).length, 1);
  assert.equal(diskWarnings({ freeDiskGB: 20 }, 19).length, 2);
});

test("models listing", () => {
  const listing = fixture("models.json");
  const id = "mlx-community/Qwen3.8-27B-GPTQ-4bit";
  assert.deepEqual(parseModels(listing), { id, ids: [id], context: 65536, inputModalities: ["text"] });
  listing.data.push({ id: "alias" });
  assert.deepEqual(parseModels(listing)?.ids, [id, "alias"]);
  assert.equal(parseModels({ data: [{ id: "x", owned_by: "llama.cpp", context_length: 10 }] }), null);
  assert.equal(parseModels(null), null);
});

test("served model matches full ids including the quant", () => {
  const ids = ["alias", "org/repo:Q4"];
  assert.equal(servesModel("alias", ids), true);
  assert.equal(servesModel("Org/Repo:q4", ids), true);
  assert.equal(servesModel("org/repo:Q3", ids), false);
  assert.equal(servesModel("org/repo", ids), false);
  assert.equal(servesModel("org/repo:Q4", ["org/repo"]), false);
  assert.equal(servesModel("org/repo", []), false);
});

test("later system", () => {
  assert.equal(parseLaterSystem({ chat_template: { later_system: "native" } }), true);
  assert.equal(parseLaterSystem({ chat_template: { later_system: { a: "patched", b: "native" } } }), true);
  assert.equal(parseLaterSystem({ chat_template: { later_system: { a: "patched", b: "folded" } } }), false);
  assert.equal(parseLaterSystem(null), false);
});

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("provider from live 1.7.1-m1 fixtures", () => {
  const served = { ...parseModels(fixture("models.json"))!, laterSystem: parseLaterSystem(fixture("status.json")) };
  const m = providerConfig(8000, served, {}).models[0] as any;
  assert.equal(m.id, "mlx-community/Qwen3.8-27B-GPTQ-4bit");
  assert.equal(m.contextWindow, 65536);
  assert.deepEqual(m.input, ["text"]);
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.compat, { supportsMidConvoSystemMessages: true });
});

test("macOS version", () => {
  assert.equal(macosWarning("splash-m1", "27.2.1"), null);
  assert.equal(macosWarning("splash-m1", "26.4"), null);
  assert.match(macosWarning("splash-m1", "26.3.1")!, /26\.4/);
  assert.match(macosWarning("splash-m1", "15.6")!, /15\.6/);
  assert.equal(macosWarning("splash", "15.6"), null);
  assert.equal(macosWarning("splash-m1", ""), null);
});

test("log line for download progress", () => {
  assert.equal(lastLine("a\nFetching 4 files:  25%|##  | 1/4\rFetching 4 files:  50%|#### | 2/4\r\n"), "Fetching 4 files:  50%|#### | 2/4");
  assert.equal(lastLine(""), "");
  assert.equal(lastLine("x".repeat(100), 10), "xxxxxxxxx…");
});

test("provider matches splash-m1 pi", () => {
  const served = { id: "m", context: 65536, inputModalities: ["text"], laterSystem: true };
  const c = providerConfig(8000, served, {});
  assert.equal(providerName(8000), "splash");
  assert.equal(providerName(8133), "splash-8133");
  assert.equal(c.apiKey, "local");
  assert.equal(providerConfig(8000, served, { SPLASH_API_KEY: "k" }).apiKey, "$SPLASH_API_KEY");
  assert.equal(c.baseUrl, "http://127.0.0.1:8000/v1");
  assert.deepEqual(c.models[0].thinkingLevelMap, { off: "none" });
  assert.deepEqual(c.models[0].input, ["text"]);
  assert.equal(c.models[0].contextWindow, 65536);
  assert.deepEqual((c.models[0] as any).compat, { supportsMidConvoSystemMessages: true });
  assert.equal((providerConfig(8000, { ...served, laterSystem: false }, {}).models[0] as any).compat, undefined);
});

test("record description", () => {
  assert.equal(describe(null), "not running");
  assert.equal(describe({ pid: process.pid, phase: "warming", warmup: { steps_done: 2, steps: 5 } }, () => true), "warming 2/5");
  assert.equal(describe({ pid: 999999, phase: "ready" }), "not running");
  assert.equal(describe({ pid: process.pid, phase: "ready" }, () => false), "not running");
  assert.equal(describe({ pid: process.pid, phase: "ready" }, () => true), "ready");
  assert.equal(describe({ pid: 999999, phase: "failed", failure: { message: "out of memory" } }), "failed: out of memory");
});

test("ownership walks ancestors", () => {
  assert.equal(startedByUs(8000, null), false);
});

test("downloaded check", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { isDownloaded } = await import("../src/recommend.ts");
  const hub = mkdtempSync(join(tmpdir(), "hub-"));
  const snap = join(hub, "models--a--b-GGUF", "snapshots", "r1");
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, "b-UD-Q4_K_M.gguf"), "");
  assert.equal(isDownloaded("a/b-GGUF:UD-Q4_K_M", hub), true);
  assert.equal(isDownloaded("a/b-GGUF:Q4_0", hub), false);
  assert.equal(isDownloaded("a/c", hub), false);
});

test("download plan picks Splash's files", async () => {
  const { pickFiles, missingFiles, downloadLines } = await import("../src/download.ts");
  const tree = (name: string) => fixture(name).filter((e: any) => e.type === "file").map((e: any) => ({ path: e.path, size: e.lfs?.size ?? e.size, blob: e.lfs?.oid ?? e.oid }));
  const paths = (files: { path: string }[]) => files.map((f) => f.path);
  assert.deepEqual(paths(pickFiles(tree("tree-gguf.json"), "UD-Q4_K_M", true)), ["Qwen3.8-27B-UD-Q4_K_M.gguf"]);
  assert.deepEqual(paths(pickFiles(tree("tree-gguf.json"), "UD-Q4_K_M", false)), ["Qwen3.8-27B-UD-Q4_K_M.gguf", "mmproj-BF16.gguf"]);
  assert.deepEqual(paths(pickFiles(tree("tree-bonsai.json"), "Q2_0", true)), ["Ternary-Bonsai-2-27B-Q2_0.gguf"]);
  assert.deepEqual(paths(pickFiles(tree("tree-bonsai.json"), "PQ2_0", false)), ["Ternary-Bonsai-2-27B-PQ2_0.gguf", "Ternary-Bonsai-2-27B-mmproj-BF16.gguf"]);
  const mlx = pickFiles(tree("tree-mlx.json"), undefined, true);
  assert.equal(mlx.length, 3);
  assert.ok(mlx.every((f) => f.path.endsWith(".safetensors") && f.size > 5e9));

  const { mkdtempSync, mkdirSync, writeFileSync, truncateSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const hub = mkdtempSync(join(tmpdir(), "hub-"));
  const blobs = join(hub, "models--o--r", "blobs");
  mkdirSync(blobs, { recursive: true });
  const files = [{ path: "a", size: 4, blob: "x" }, { path: "b", size: 4, blob: "y" }, { path: "c", size: 4, blob: "z" }];
  writeFileSync(join(blobs, "x"), "1234");
  writeFileSync(join(blobs, "y"), "12");
  assert.deepEqual(paths(missingFiles("o/r", files, hub)), ["b", "c"]);
  const { bytesOnDisk } = await import("../src/download.ts");
  writeFileSync(join(blobs, "z.5f3a.incomplete"), "123");
  assert.equal(bytesOnDisk([{ repo: "o/r", files, missing: missingFiles("o/r", files, hub) }], hub), 2 + 3);
  truncateSync(join(blobs, "y"), 4);
  assert.deepEqual(paths(missingFiles("o/r", files, hub)), ["c"]);

  const done = { repo: "o/d", files: [files[0]], missing: [] };
  assert.deepEqual(downloadLines([done]), ["Downloaded: all 1 files in the Hugging Face cache."]);
  assert.deepEqual(downloadLines([{ repo: "o/r", files, missing: [files[2]] }, done]), ["Download: 0.0 GB of 0.0 GB", "  o/r: 1 of 3 files, 0.0 GB", "  o/d: complete"]);

  const { downloadLabel, downloadNotice } = await import("../src/download.ts");
  const big = [{ path: "w", size: 15e9, blob: "w" }];
  const draft = [{ path: "d", size: 3.85e9, blob: "d" }];
  const model = { repo: "m/q", files: big, missing: big, draft: false };
  const drafter = { repo: "i/dflash", files: draft, missing: draft, draft: true };
  assert.equal(downloadLabel([{ ...model, missing: [] }, drafter]), "draft");
  assert.equal(downloadLabel([model, { ...drafter, missing: [] }]), "model");
  assert.equal(downloadLabel([model, drafter]), "model + draft");
  assert.equal(downloadLabel([{ ...model, missing: [] }]), "");
  assert.equal(downloadNotice([{ ...model, missing: [] }, drafter]), "3.9 GB to download: draft i/dflash.");
  assert.equal(downloadNotice([model, drafter]), "18.9 GB to download: model m/q, draft i/dflash.");
});

test("runtime version", async () => {
  const { versionOf } = await import("../src/server.ts");
  assert.equal(versionOf("Splash 1.7.1-m1"), "1.7.1-m1");
  assert.equal(versionOf("Splash 1.7.2\n"), "1.7.2");
  assert.equal(versionOf(""), null);
});

test("network bytes of the server's process tree", async () => {
  const { descendants, parseSample, progressText, samples } = await import("../src/netbytes.ts");
  assert.deepEqual(samples(",bytes_in,\npython3.13.7,500,\n,bytes_in,\npython3.13.7,20,\n"), [["python3.13.7,500,"], ["python3.13.7,20,"]]);
  assert.deepEqual(samples(""), []);
  assert.deepEqual([...descendants(10, [[11, 10], [12, 11], [13, 1], [14, 12]])].sort(), [10, 11, 12, 14]);
  assert.deepEqual(parseSample("python3.13.70483,35994215,"), { pid: 70483, bytes: 35994215 });
  assert.deepEqual(parseSample("Google Chrome H.123,0,"), { pid: 123, bytes: 0 });
  assert.equal(parseSample(",bytes_in,"), null);
  assert.equal(progressText(6.8e9, 17.5e9, 12e6), "downloading 6.8 / 17.5 GB (38%), 12.0 MB/s, ~15 min left");
  assert.equal(progressText(18e9, 17.5e9, 1e6), "downloading 17.5 / 17.5 GB (99%), 1.0 MB/s");
  assert.equal(progressText(2.5e9, null, 0), "downloading 2.5 GB");
  assert.equal(progressText(0.4e9, 3.85e9, 1.1e6, "draft"), "downloading draft 0.4 / 3.9 GB (10%), 1.1 MB/s, ~53 min left");
});

test("prewarm: first request of a session, head key, warm body", async () => {
  const { opensSession, headKey, warmBody, readWarmed, writeWarmed, needsWarm } = await import("../src/prewarm.ts");
  assert.equal(needsWarm(1530), true);
  assert.equal(needsWarm(2063), true);
  assert.equal(needsWarm(2064), false);
  assert.equal(needsWarm(8090), false);
  assert.equal(needsWarm(null), false);
  const sys = { role: "system", content: "You are pi." };
  const tools = [{ type: "function", function: { name: "bash" } }];
  const a = { model: "m", stream: true, stream_options: { include_usage: true }, max_completion_tokens: 32768, reasoning_effort: "medium", tools,
    messages: [sys, { role: "user", content: [{ type: "text", text: "Look at this repository." }] }] };
  const b = { ...a, max_completion_tokens: 100, messages: [sys, { role: "user", content: "other" }] };
  assert.equal(opensSession(a), true);
  assert.equal(opensSession({ ...a, messages: [sys, a.messages[1], { role: "assistant", content: "x" }, { role: "user", content: "y" }] }), false);
  assert.equal(opensSession({ ...a, messages: [{ role: "user", content: "x" }] }), false);
  assert.equal(headKey(a), headKey(b));
  assert.notEqual(headKey(a), headKey({ ...a, tools: [] }));
  assert.notEqual(headKey(a), headKey({ ...a, reasoning_effort: "high" }));
  assert.notEqual(headKey(a), headKey({ ...a, messages: [{ role: "system", content: "You are omp." }, a.messages[1]] }));
  assert.deepEqual(warmBody(a), { model: "m", reasoning_effort: "medium", tools, max_completion_tokens: 1, stream: false,
    messages: [sys, { role: "user", content: "." }] });
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "warm-"));
  writeWarmed(dir, 8000, 11, new Set(["k1"]));
  assert.deepEqual([...readWarmed(dir, 8000, 11)], ["k1"]);
  assert.deepEqual([...readWarmed(dir, 8000, 12)], []);
  assert.deepEqual([...readWarmed(dir, 8001, 11)], []);
  writeWarmed(dir, 8000, "11@Fri Nov 27 21:04:05 2026", new Set(["k2"]));
  assert.deepEqual([...readWarmed(dir, 8000, "11@Fri Nov 27 21:04:05 2026")], ["k2"]);
  assert.deepEqual([...readWarmed(dir, 8000, "11@Sat Nov 28 09:00:00 2026")], []);
});

test("bench median and range", async () => {
  const { stats } = await import("../src/bench-report.ts");
  const values = [12, 2, 7];
  assert.deepEqual(stats(values), { median: 7, min: 2, max: 12 });
  assert.deepEqual(values, [12, 2, 7]);
  assert.deepEqual(stats([4, 3]), { median: 3.5, min: 3, max: 4 });
  assert.deepEqual(stats([0]), { median: 0, min: 0, max: 0 });
  assert.equal(stats([]), null);
});

test("bench report aligns one line per test", async () => {
  const { benchReport } = await import("../src/bench-report.ts");
  const req = (test: string, o: any) => ({ test, promptTokens: 1000, completionTokens: 1, cachedTokens: 0, ttftMs: 6850,
    timings: { prompt_per_second: 147.8 }, latency: {}, draftAcceptance: null, ...o });
  const requests = [
    req("prefill 1K", { timings: { prompt_per_second: 145.1 } }),
    req("prefill 1K", {}),
    req("prefill 1K", { cachedTokens: 16 }),
    req("prefill 8K", { promptTokens: 8181, ttftMs: 49750, timings: { prompt_per_second: 164.4 } }),
    req("replay 8K", { promptTokens: 8181, cachedTokens: 8160, ttftMs: 440, timings: { prompt_per_second: 48 } }),
    req("code", { promptTokens: 383, completionTokens: 256, timings: { predicted_per_second: 39.6 }, draftAcceptance: 0.774 }),
    req("prose", { promptTokens: 60, completionTokens: 256, timings: { predicted_per_second: 22 }, draftAcceptance: null }),
  ];
  const report = benchReport({ benchVersion: 1, durationMs: 141_000, long: false, requests, counts: [],
    environment: { packageVersion: "0.1.2", chip: "Apple M1 Pro", memoryGB: 32, macos: "27.2.1", runtime: "splash-m1",
      runtimeVersion: "1.7.3-m1", model: "org/m", context: 65536, flags: "--max-memory 21G", flagsSource: "start" },
    before: { swapGB: 0.87, freePercent: 24 }, after: { swapGB: 0.87, freePercent: 18 } } as any);
  assert.equal(report, [
    "pi-splash-server 0.1.2, bench v1",
    "Mac:     Apple M1 Pro, 32 GB, macOS 27.2.1",
    "Runtime: splash-m1 1.7.3-m1",
    "Model:   org/m, 64K context",
    "Flags:   --max-memory 21G",
    "",
    "Prefill 1K    147.8 tok/s   TTFT   6.85 s   1000 tok, 3 runs: 145.1-147.8, cache hit in run #3",
    "Prefill 8K    164.4 tok/s   TTFT  49.75 s   8181 tok",
    "Replay 8K                   TTFT   0.44 s   8160 of 8181 tok cached",
    "Decode code    39.6 tok/s   draft     77%   256 tok",
    "Decode prose   22.0 tok/s   draft       -   256 tok",
    "",
    "Memory: swap 0.9 -> 0.9 GB, free 24% -> 18%. Took 2 min 21 s.",
  ].join("\n"));
});

test("bench share url prefills the issue form", async () => {
  const { benchReport, shareUrl } = await import("../src/bench-report.ts");
  const result = { benchVersion: 1, durationMs: 1000, long: false, requests: [], counts: [],
    environment: { packageVersion: "0.1.3", chip: "Apple M1 Pro", memoryGB: 32, macos: "27.2.1", runtime: "splash-m1",
      model: "mlx-community/Qwen3.8-27B-GPTQ-4bit", context: 65536, flags: "", flagsSource: "start" },
    before: {}, after: {} } as any;
  const url = new URL(shareUrl(result));
  assert.equal(url.origin + url.pathname, "https://github.com/sady4850/pi-splash-server/issues/new");
  assert.equal(url.searchParams.get("template"), "bench.yml");
  assert.equal(url.searchParams.get("title"), "Bench: Apple M1 Pro 32 GB, Qwen3.8-27B-GPTQ-4bit");
  assert.equal(url.searchParams.get("report"), benchReport(result));
});

test("start completions: pick first, then nearest bigger, nearer smaller, other models last", async () => {
  const { loadCatalog, startCompletions } = await import("../src/catalog.ts");
  const { loadEntries, recommend } = await import("../src/recommend.ts");
  const catalog = loadCatalog();
  for (const e of loadEntries()) assert.ok(catalog.some((m) => m.model === e.model), e.model);
  const items = (gb: number, q = "") => startCompletions(q, catalog, recommend({ family: 1, memoryGB: gb }).pick, (m) => m.includes("GPTQ"));
  const at32 = items(32);
  assert.deepEqual(at32.map((i) => i.label), [
    "Qwen3.8-27B · GPTQ 4-bit", "Qwen3.8-27B · Q4_0", "Qwen3.8-27B · UD-Q4_K_M", "Qwen3.8-27B · UD-Q5_K_S",
    "Qwen3.8-27B · SLQ EAR98-Q5_K_S", "Qwen3.8-27B · MLX 4-bit", "Qwen3.8-27B · GSQ IQ3_S", "Ternary-Bonsai-2-27B · PQ2_0",
  ]);
  for (const i of at32) assert.ok(i.label.length <= 30, i.label);
  assert.equal(at32[0].value, "start mlx-community/Qwen3.8-27B-GPTQ-4bit");
  assert.equal(at32[0].description, "recommended · downloaded · 15.1 GB · others compared to this");
  assert.equal(at32[2].description, "needs download · +1.3 GB · KL wiki -64%, chat -17% · decode 11% slower");
  assert.equal(at32[5].description, "needs download · same size · KL wiki +41%, chat +90% · decode same");
  assert.equal(items(64)[6].description, "needs download · -6.9 GB · KL wiki ×8.8, chat ×3.7 · decode 2% faster");
  assert.equal(items(16)[0].label, "Ternary-Bonsai-2-27B · PQ2_0");
  assert.deepEqual(items(32, "gsq").map((i) => i.label), ["Qwen3.8-27B · GSQ IQ3_S"]);
  assert.deepEqual(items(32, "unsloth").length, 3);
  assert.deepEqual(items(32, "nothing"), []);
});

test("bench response preserves server timings, cache hits and optional draft counts", async () => {
  const { parseMeasurement } = await import("../src/bench.ts");
  const usage = { prompt_tokens: 8192, completion_tokens: 128, prompt_tokens_details: { cached_tokens: 8176 } };
  const timings = { prompt_n: 16, prompt_ms: 80, prompt_per_second: 200, predicted_n: 128, predicted_ms: 6400,
    predicted_per_second: 20, cache_n: 8176, draft_n: 100, draft_n_accepted: 75 };
  const latency = { ttft_ms: 0, wall_ms: 6500, start_to_first_token_ms: 85, first_token_to_done_ms: 6415 };
  assert.deepEqual(parseMeasurement({ usage, timings, metrics: { request_latency: latency } }), {
    promptTokens: 8192, completionTokens: 128, cachedTokens: 8176, ttftMs: 0, timings, latency, draftAcceptance: 0.75,
  });
  const plain = parseMeasurement({ usage: { ...usage, prompt_tokens_details: { cached_tokens: 0 } },
    timings: { predicted_per_second: 9 }, metrics: { request_latency: { wall_ms: 120 } } });
  assert.equal(plain.ttftMs, 120);
  assert.equal(plain.draftAcceptance, null);
  assert.equal(plain.cachedTokens, 0);
  assert.equal(plain.timings.draft_n, undefined);
});

test("bench extracts serve flags and removes private values", async () => {
  const { serverFlags } = await import("../src/bench-env.ts");
  assert.equal(serverFlags("/Users/test user/bin/splash-m1 serve --model org/m:Q4 --port 8000 --language-only --max-context 64K --max-memory 21G"),
    "--model org/m:Q4 --language-only --max-context 64K --max-memory 21G");
  assert.equal(serverFlags("splash serve --cache-dir /Users/test user/cache --api-key=secret --port=8000 --host private.local"),
    "--cache-dir [redacted] --api-key [redacted] --host [redacted]");
  assert.equal(serverFlags("splash serve --port 8123"), "");
  assert.equal(serverFlags("/Users/a b/python3 -u -P -m server.server /Users/a b/.selections/7c06 --model org/m --binary /Users/a b/bin/engine --port 8000 --serve-record /Users/a b/serve-8000.json --max-memory=22548578304 --max-context=65536"),
    "--max-memory 22548578304 --max-context 65536");
  assert.equal(serverFlags("/tmp/serve/splash --version"), null);
  assert.equal(serverFlags(""), null);
});

test("bench parses used swap and system free memory", async () => {
  const { swapGB, freeMemoryPercent } = await import("../src/bench-env.ts");
  assert.equal(swapGB("total = 8192.00M  used = 1536.00M  free = 6656.00M (encrypted)"), 1.5);
  assert.equal(swapGB("total = 2G used = 0G free = 2G"), 0);
  assert.equal(swapGB(""), null);
  assert.equal(freeMemoryPercent("Pages free: 31240\nSystem-wide memory free percentage: 41%"), 41);
  assert.equal(freeMemoryPercent("System-wide memory free percentage: 0%"), 0);
  assert.equal(freeMemoryPercent("unknown"), null);
});

test("bench sizes the full nonce-prefixed prompt with the model's counter", async () => {
  const { buildPrompt } = await import("../src/bench.ts");
  const source = readFileSync(new URL("../data/bench.txt", import.meta.url), "utf8");
  for (const [target, chars] of [[1024, 2], [8192, 8], [32768, 4]]) {
    const count = async (text: string) => Math.ceil(text.length / chars) + 32;
    const prompt = await buildPrompt(source, "bench deadbeef", target, count, target - 1);
    assert.ok(prompt.startsWith("bench deadbeef\n" + source.slice(0, 80)));
    assert.ok(await count(prompt) >= target * 0.95);
    assert.ok(await count(prompt) <= target - 1);
    assert.equal(await buildPrompt(source, "bench deadbeef", target, count, target - 1), prompt);
  }
  await assert.rejects(buildPrompt(source, "bench 1", 1024, async () => 0), /input_tokens/);
});

test("install: bin dir, launcher fallback dirs", async () => {
  const { binDir, launcherDirs } = await import("../src/install.ts");
  const { findLauncher } = await import("../src/server.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { homedir, tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.equal(binDir({ SPLASH_BIN_DIR: "/x/bin" }), "/x/bin");
  assert.equal(binDir({}, () => false), join(homedir(), ".local/bin"));
  assert.deepEqual(launcherDirs({}), ["/opt/homebrew/bin", join(homedir(), ".local/bin")]);
  assert.equal(launcherDirs({ SPLASH_BIN_DIR: "/x/bin" })[0], "/x/bin");
  const dir = mkdtempSync(join(tmpdir(), "launcher-"));
  writeFileSync(join(dir, "splash-test-launcher"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(dir, "splash-test-plain"), "", { mode: 0o644 });
  assert.equal(findLauncher("splash-test-launcher", [dir]), join(dir, "splash-test-launcher"));
  assert.equal(findLauncher("splash-test-plain", [dir]), null);
  assert.equal(findLauncher("splash-test-launcher"), null);
  const { resolveLauncher } = await import("../src/server.ts");
  const exe = (p: string) => p === "/bin/sh" || p === join(dir, "splash-test-launcher");
  assert.equal(resolveLauncher(undefined, "splash-test-launcher", [dir], exe), join(dir, "splash-test-launcher"));
  assert.equal(resolveLauncher("/bin/sh", "x", [dir], exe), "/bin/sh");
  assert.equal(resolveLauncher("/nope/splash-m1", "x", [dir], exe), null);
  assert.equal(resolveLauncher("sh", "x", [dir]), "/bin/sh");
});

test("install: phase and failure from the installer log", async () => {
  const { installPhase, progressOf, failureOf } = await import("../src/install.ts");
  assert.equal(installPhase(""), "starting");
  const downloading = "Downloading splash-1.7.3-m1-arm64-macos26.tar.gz ...\n";
  assert.equal(installPhase(downloading), "downloading");
  const bar = `${downloading}##O=#  #\r###           4.2%\r########          37.5%`;
  assert.equal(progressOf(bar), 37.5);
  assert.equal(installPhase(bar), "downloading 38%");
  assert.equal(installPhase(`${bar}\r############# 100.0%\n`), "checking and unpacking");
  assert.equal(installPhase(`${bar}\r100.0%\nSplash 1.7.3-m1\n\nInstalled. Start a model\n`), "done");
  assert.equal(failureOf(`${bar}\nsplash-m1 install: checksum mismatch (expected a, got b)\n`), "checksum mismatch (expected a, got b)");
  assert.equal(failureOf("curl: (6) Could not resolve host\n"), "curl: (6) Could not resolve host");
  assert.equal(failureOf(""), null);
});

test("install: lock is exclusive, never empty, stale when old or both pids are gone", async () => {
  const { takeLock, readLock, releaseLock, updateLock, lockHeld, installing } = await import("../src/install.ts");
  const { mkdtempSync, readdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "lock-"));
  const path = join(dir, "install.lock");
  const lock = takeLock("install", "1.7.3-m1", path);
  assert.equal(readLock(path)?.tag, "1.7.3-m1");
  assert.equal(takeLock("start", "m", path), null);
  assert.equal(installing(path)?.kind, "install");
  releaseLock({ ...lock!, started: "other" }, path);
  assert.ok(readLock(path));
  releaseLock(lock!, path);
  assert.equal(readLock(path), null);
  const now = new Date().toISOString();
  const dead = 2 ** 22 + 12345;
  writeFileSync(path, JSON.stringify({ pid: dead, child: process.pid, kind: "install", tag: "a", started: now }));
  assert.equal(takeLock("install", "b", path), null);
  writeFileSync(path, JSON.stringify({ pid: dead, child: dead, kind: "install", tag: "a", started: now }));
  assert.equal(installing(path), null);
  const taken = takeLock("install", "b", path);
  assert.equal(taken?.tag, "b");
  updateLock({ ...taken!, child: 42 }, path);
  assert.equal(readLock(path)?.child, 42);
  assert.deepEqual(readdirSync(dir), ["install.lock"]);
  const old = new Date(Date.now() - 2 * 3600e3).toISOString();
  assert.equal(lockHeld({ pid: process.pid, kind: "install", tag: "x", started: old }), false);
  writeFileSync(path, JSON.stringify({ pid: process.pid, kind: "install", tag: "x", started: old }));
  assert.equal(takeLock("start", "m", path)?.kind, "start");
  assert.equal(lockHeld({ pid: 1, kind: "install", tag: "x", started: now }, (p) => p === 2), false);
  assert.equal(lockHeld({ pid: 1, child: 2, kind: "install", tag: "x", started: now }, (p) => p === 2), true);
  assert.equal(lockHeld({ pid: 1, kind: "install", tag: "x", started: "garbage" }, () => true), false);
});

test("install: concurrent lock takers, exactly one wins", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const path = join(mkdtempSync(join(tmpdir(), "lockrace-")), "install.lock");
  const mod = new URL("../src/install.ts", import.meta.url).href;
  const code = `const { takeLock } = await import(${JSON.stringify(mod)}); const at = Number(process.argv[1]); while (Date.now() < at); const l = takeLock("install", "t", ${JSON.stringify(path)}); process.stdout.write(l ? "won" : "lost"); setTimeout(() => {}, 1500);`;
  const at = Date.now() + 1500;
  const runs = Array.from({ length: 6 }, () => new Promise<string>((resolve) => {
    const c = spawn(process.execPath, ["--input-type=module", "-e", code, String(at)]);
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("exit", () => resolve(out));
  }));
  const results = await Promise.all(runs);
  assert.equal(results.filter((r) => r === "won").length, 1, results.join(","));
});

test("install: live servers from runtime records and owned starts", async () => {
  const { liveServers } = await import("../src/install.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const runtime = mkdtempSync(join(tmpdir(), "rt-"));
  const state = mkdtempSync(join(tmpdir(), "st-"));
  writeFileSync(join(runtime, "serve-8000.json"), JSON.stringify({ pid: 10, phase: "ready" }));
  writeFileSync(join(runtime, "serve-8001.json"), JSON.stringify({ pid: 11, phase: "failed" }));
  writeFileSync(join(runtime, "serve-8002.json"), "{broken");
  writeFileSync(join(state, "owned-8003.json"), JSON.stringify({ pid: 12, model: "m" }));
  writeFileSync(join(state, "owned-8000.json"), JSON.stringify({ pid: 10, model: "m" }));
  writeFileSync(join(state, "bench-1.json"), JSON.stringify({ pid: 10 }));
  assert.deepEqual(liveServers(runtime, state, (pid) => pid === 12), [8003]);
  assert.deepEqual(liveServers(runtime, state, (pid) => pid === 10 || pid === 12), [8000, 8003]);
  assert.deepEqual(liveServers(runtime, state, () => false), []);
  assert.deepEqual(liveServers(join(runtime, "nope"), join(state, "nope")), []);
});

test("install: runs the fetched script detached with the pinned version, log to a file", async () => {
  const { runScript, readLog, checkLauncher } = await import("../src/install.ts");
  const { mkdtempSync, readdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "run-"));
  const log = join(dir, "install.log");
  const keepAlive = setInterval(() => {}, 100);
  const script = `#!/bin/sh\necho "Downloading v=$SPLASH_M1_VERSION"\nprintf '###  50.0%%\\r' >&2\nmkdir -p "$SPLASH_BIN_DIR"\nprintf '#!/bin/sh\\necho Splash %s\\n' "$SPLASH_M1_VERSION" > "$SPLASH_BIN_DIR/splash-m1"\nchmod 755 "$SPLASH_BIN_DIR/splash-m1"\necho Installed.\n`;
  const tmp = mkdtempSync(join(tmpdir(), "runtmp-"));
  const run = runScript(script, "9.9.9-m1", { PATH: process.env.PATH, SPLASH_BIN_DIR: join(dir, "bin") }, log, tmp);
  assert.ok(run.child > 0);
  assert.equal(await run.done, 0);
  const text = readLog(log);
  assert.match(text, /Downloading v=9\.9\.9-m1/);
  assert.match(text, /50\.0%/);
  assert.deepEqual(await checkLauncher(join(dir, "bin/splash-m1")), { version: "9.9.9-m1", error: null });
  assert.deepEqual(readdirSync(tmp), []);
  const failing = runScript("#!/bin/sh\necho 'splash-m1 install: download failed: x' >&2\nexit 1\n", "9.9.9-m1", { PATH: process.env.PATH }, log, tmp);
  assert.equal(await failing.done, 1);
  writeFileSync(join(dir, "lies"), "#!/bin/sh\necho Splash 9.9.9-m1\nexit 3\n", { mode: 0o755 });
  assert.equal((await checkLauncher(join(dir, "lies"))).version, null);
  writeFileSync(join(dir, "noexec"), "#!/bin/sh\n", { mode: 0o644 });
  assert.equal((await checkLauncher(join(dir, "noexec"))).version, null);
  assert.ok((await checkLauncher(join(dir, "noexec"))).error);
  clearInterval(keepAlive);
});

test("prewarm requests stop on the turn's abort signal", async () => {
  const { createServer } = await import("node:http");
  const { countTokens, warm } = await import("../src/prewarm.ts");
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const payload = { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t = Date.now();
  assert.equal(await countTokens(port, payload, undefined, ac.signal), null);
  assert.equal(await warm(port, payload, undefined, ac.signal), false);
  assert.ok(Date.now() - t < 2000);
  server.closeAllConnections();
  server.close();
});
