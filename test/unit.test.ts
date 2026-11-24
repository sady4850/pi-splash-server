import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { macosWarning, parseFamily, runtimeFor } from "../src/mac.ts";
import { recommend, diskWarnings } from "../src/recommend.ts";
import { parseModels, parseLaterSystem, startedByUs, describe, lastLine } from "../src/server.ts";
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
  const m = parseModels(JSON.parse(readFileSync(new URL("./fixtures/models.json", import.meta.url), "utf8")));
  assert.deepEqual(m, { id: "mlx-community/Qwen3.8-27B-GPTQ-4bit", context: 65536, inputModalities: ["text"] });
  assert.equal(parseModels({ data: [{ id: "x", owned_by: "llama.cpp", context_length: 10 }] }), null);
  assert.equal(parseModels(null), null);
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
  assert.equal(describe({ pid: process.pid, phase: "warming", warmup: { steps_done: 2, steps: 5 } }), "warming 2/5");
  assert.equal(describe({ pid: 999999, phase: "ready" }), "not running");
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
});

test("runtime version", async () => {
  const { versionOf } = await import("../src/server.ts");
  assert.equal(versionOf("Splash 1.7.1-m1"), "1.7.1-m1");
  assert.equal(versionOf("Splash 1.7.2\n"), "1.7.2");
  assert.equal(versionOf(""), null);
});

test("network bytes of the server's process tree", async () => {
  const { descendants, parseSample, progressText } = await import("../src/netbytes.ts");
  assert.deepEqual([...descendants(10, [[11, 10], [12, 11], [13, 1], [14, 12]])].sort(), [10, 11, 12, 14]);
  assert.deepEqual(parseSample("python3.13.70483,35994215,"), { pid: 70483, bytes: 35994215 });
  assert.deepEqual(parseSample("Google Chrome H.123,0,"), { pid: 123, bytes: 0 });
  assert.equal(parseSample(",bytes_in,"), null);
  assert.equal(progressText(6.8e9, 17.5e9, 12e6), "downloading 6.8 / 17.5 GB (38%), 12.0 MB/s, ~15 min left");
  assert.equal(progressText(18e9, 17.5e9, 1e6), "downloading 17.5 / 17.5 GB (99%), 1.0 MB/s");
  assert.equal(progressText(2.5e9, null, 0), "downloading 2.5 GB");
});
