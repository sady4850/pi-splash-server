import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFamily, runtimeFor } from "../src/mac.ts";
import { recommend, diskWarnings } from "../src/recommend.ts";
import { parseModels, parseLaterSystem, startedByUs, describe } from "../src/server.ts";
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
  const pick = recommend({ family: 1, memoryGB: 32 }).pick;
  assert.equal(diskWarnings({ freeDiskGB: 100 }, pick, false).length, 0);
  assert.equal(diskWarnings({ freeDiskGB: 16 }, pick, true).length, 1);
  assert.equal(diskWarnings({ freeDiskGB: 20 }, pick, false).length, 2);
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
