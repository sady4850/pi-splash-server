import type { BenchRequest, BenchResult } from "./bench.ts";

export function stats(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { median, min: sorted[0], max: sorted[sorted.length - 1] };
}

function cell(values: (number | null | undefined)[], digits: number, scale = 1): string {
  const numbers = values.filter((v): v is number => v != null);
  const range = stats(numbers);
  if (!range) return "-";
  const format = (n: number) => (n * scale).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: digits });
  const median = format(range.median);
  return numbers.length > 1 && range.min !== range.max ? `${median} (${format(range.min)}-${format(range.max)})` : median;
}

function row(test: BenchRequest["test"], runs: BenchRequest[]) {
  const decode = test === "code" || test === "prose";
  const hits = runs.flatMap((r, i) => (r.cachedTokens ?? 0) > 0 ? [i + 1] : []);
  const cached = cell(runs.map(r => r.cachedTokens), 1);
  const columns = [
    test, cell(runs.map(r => decode ? r.completionTokens : r.promptTokens), 1),
    decode ? "-" : cell(runs.map(r => r.ttftMs), 2, 0.001),
    test.startsWith("prefill") ? cell(runs.map(r => r.timings.prompt_per_second), 1) : "-",
    decode ? cell(runs.map(r => r.timings.predicted_per_second), 1) : "-",
    decode ? cell(runs.map(r => r.draftAcceptance), 1, 100) : "-",
    test.startsWith("prefill") && hits.length ? `${cached} cache hit #${hits.join(",#")}` : cached,
  ];
  return `| ${columns.join(" | ")} |`;
}

export function benchReport(result: BenchResult): string {
  const { environment: env, requests, before, after } = result;
  const mac = [
    env.chip, env.gpuCores && `${env.gpuCores}-core GPU`, `${env.memoryGB} GB`, `macOS ${env.macos}`,
    env.power && `on ${env.power}`, env.lowPower != null && `Low Power Mode ${env.lowPower ? "on" : "off"}`,
    env.thermalWarning && `thermal warning ${env.thermalWarning}`,
  ].filter(Boolean);
  const seconds = Math.round(result.durationMs / 1000);
  const memory = [];
  if (before.swapGB != null || after.swapGB != null) memory.push(`Swap: ${before.swapGB?.toFixed(1) ?? "?"} -> ${after.swapGB?.toFixed(1) ?? "?"} GB.`);
  if (before.freePercent != null || after.freePercent != null) memory.push(`Free memory: ${before.freePercent ?? "?"}% -> ${after.freePercent ?? "?"}%.`);
  memory.push(`Took ${Math.floor(seconds / 60)} min ${seconds % 60} s.`);

  return [
    `pi-splash-server bench v${result.benchVersion} (pi-splash-server ${env.packageVersion})`,
    `Mac: ${mac.join(", ")}`, `Runtime: ${env.runtime} ${env.runtimeVersion ?? "unknown version"}`,
    `Model: ${env.model}, ${env.context.toLocaleString("en-US")} context`, `${env.flagsSource === "start" ? "Flags" : "Server process flags"}: ${env.flags === null ? "unavailable" : env.flags || "(none)"}`,
    "", "Median (min-max) across repeats.", "",
    "| test | tokens | TTFT s | prefill tok/s | decode tok/s | draft accepted % | cached |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...Array.from(new Set(requests.map(r => r.test)), test => row(test, requests.filter(r => r.test === test))),
    "", ...[result.note, result.error && `Stopped: ${result.error}`].filter(Boolean), memory.join(" "),
  ].join("\n");
}
