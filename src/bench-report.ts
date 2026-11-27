import type { BenchRequest, BenchResult } from "./bench.ts";

export function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1] };
}

function present(values: (number | null | undefined)[]) {
  return values.filter((v): v is number => v != null && Number.isFinite(v));
}

function median(values: (number | null | undefined)[]) {
  return stats(present(values))?.median ?? null;
}

const fixed = (n: number | null, digits: number) => n == null ? "-" : n.toFixed(digits);

function spread(values: (number | null | undefined)[], digits: number) {
  const numbers = present(values);
  const range = stats(numbers);
  if (numbers.length < 2 || !range) return "";
  return `${numbers.length} runs: ${range.min.toFixed(digits)}-${range.max.toFixed(digits)}`;
}

const labels: Record<BenchRequest["test"], string> = {
  "warm-up": "Warm-up", "prefill 1K": "Prefill 1K", "prefill 8K": "Prefill 8K", "prefill 32K": "Prefill 32K",
  "replay 8K": "Replay 8K", code: "Decode code", prose: "Decode prose",
};

function row(test: BenchRequest["test"], runs: BenchRequest[]): string[] {
  const label = labels[test];
  const tokens = (values: number[]) => `${Math.round(median(values) ?? 0)} tok`;
  if (test === "code" || test === "prose") {
    const speed = runs.map(r => r.timings.predicted_per_second);
    const accepted = median(runs.map(r => r.draftAcceptance));
    const tail = [tokens(runs.map(r => r.completionTokens)), spread(speed, 1)].filter(Boolean).join(", ");
    return [label, fixed(median(speed), 1), "tok/s", "draft", accepted == null ? "-" : `${Math.round(accepted * 100)}%`, tail];
  }
  const ttft = `${fixed(median(runs.map(r => r.ttftMs / 1000)), 2)} s`;
  const prompt = tokens(runs.map(r => r.promptTokens));
  if (test === "replay 8K") {
    const cached = Math.round(median(runs.map(r => r.cachedTokens)) ?? 0);
    return [label, "", "", "TTFT", ttft, `${cached} of ${prompt} cached`];
  }
  const speed = runs.map(r => r.timings.prompt_per_second);
  const hits = runs.flatMap((r, i) => (r.cachedTokens ?? 0) > 0 ? [`#${i + 1}`] : []);
  const tail = [prompt, spread(speed, 1), hits.length && `cache hit in run ${hits.join(", ")}`].filter(Boolean).join(", ");
  return [label, fixed(median(speed), 1), "tok/s", "TTFT", ttft, tail];
}

function align(rows: string[][], right: number[]) {
  const widths = rows[0].map((_, c) => Math.max(...rows.map(r => r[c].length)));
  const gaps = ["", "  ", " ", "   ", " ", "   "];
  return rows.map(r => r.map((cell, c) => gaps[c] + (right.includes(c) ? cell.padStart(widths[c]) : cell.padEnd(widths[c])))
    .join("").trimEnd());
}

function contextLabel(tokens: number) {
  return tokens % 1024 === 0 ? `${tokens / 1024}K` : tokens.toLocaleString("en-US");
}

export function benchReport(result: BenchResult): string {
  const { environment: env, requests, before, after } = result;
  const mac = [
    env.chip, env.gpuCores && `${env.gpuCores}-core GPU`, `${env.memoryGB} GB`, `macOS ${env.macos}`,
    env.power && `on ${env.power}`, env.lowPower != null && `Low Power Mode ${env.lowPower ? "on" : "off"}`,
    env.thermalWarning && `thermal warning ${env.thermalWarning}`,
  ].filter(Boolean);
  const header: [string, string][] = [
    ["Mac:", mac.join(", ")],
    ["Runtime:", `${env.runtime} ${env.runtimeVersion ?? "unknown version"}`],
    ["Model:", `${env.model}, ${contextLabel(env.context)} context`],
    [env.flagsSource === "start" ? "Flags:" : "Server process flags:", env.flags === null ? "unavailable" : env.flags || "(none)"],
  ];
  const width = Math.max(...header.map(([key]) => key.length)) + 1;

  const tests = Array.from(new Set(requests.map(r => r.test)), test => row(test, requests.filter(r => r.test === test)));
  const seconds = Math.round(result.durationMs / 1000);
  const memory = [];
  if (before.swapGB != null || after.swapGB != null) memory.push(`swap ${before.swapGB?.toFixed(1) ?? "?"} -> ${after.swapGB?.toFixed(1) ?? "?"} GB`);
  if (before.freePercent != null || after.freePercent != null) memory.push(`free ${before.freePercent ?? "?"}% -> ${after.freePercent ?? "?"}%`);

  return [
    `pi-splash-server ${env.packageVersion}, bench v${result.benchVersion}`,
    ...header.map(([key, value]) => key.padEnd(width) + value),
    "",
    ...(tests.length ? align(tests, [1, 4]) : []),
    "",
    ...[result.note, result.error && `Stopped: ${result.error}`].filter(Boolean),
    `${memory.length ? `Memory: ${memory.join(", ")}. ` : ""}Took ${Math.floor(seconds / 60)} min ${seconds % 60} s.`,
  ].join("\n");
}

export const ISSUES_URL = "https://github.com/sady4850/pi-splash-server/issues/new";

export function shareUrl(result: BenchResult): string {
  const { chip, memoryGB, model } = result.environment;
  const params = new URLSearchParams({
    template: "bench.yml",
    title: `Bench: ${chip} ${memoryGB} GB, ${model.split("/").pop()}`,
    report: benchReport(result),
  });
  return `${ISSUES_URL}?${params}`;
}
