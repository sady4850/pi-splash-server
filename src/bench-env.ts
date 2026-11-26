import { readFileSync } from "node:fs";
import { commandOutput, detectMac } from "./mac.ts";
import { launcherVersion, ownedFlags, readRecord, startedByUs, versionOf, type ServedModel } from "./server.ts";

export function swapGB(text: string): number | null {
  const match = /\bused\s*=\s*([\d.]+)\s*([KMGT])\b/i.exec(text);
  return match ? Number(match[1]) * 1024 ** ("KMGT".indexOf(match[2].toUpperCase()) - 2) : null;
}

export function freeMemoryPercent(text: string): number | null {
  const match = /system-wide memory free percentage:\s*(\d+)%/i.exec(text);
  return match ? Number(match[1]) : null;
}

function publicModel(id?: string): string | undefined {
  return id && /^[\w-][\w.-]*(?:\/[\w-][\w.-]*)?(?::[\w.-]+)?$/.test(id) ? id : undefined;
}

export function serverFlags(command: string): string | null {
  const serve = /(?:^|\s)(?:serve|-m server\.server)(?:\s+|$)/.exec(command);
  if (!serve) return null;
  const internal = serve[0].includes("server.server");
  const args = command.slice(serve.index + serve[0].length).trim();
  const flags = [];
  for (const arg of args.split(/\s+(?=--?[a-z])/i)) {
    const option = /^(--?[\w-]+)(?:[=\s]+(.*))?$/.exec(arg);
    if (!option) {
      if (arg && !internal) flags.push(publicModel(arg) ?? "[redacted]");
      continue;
    }
    if (option[1] === "--port" || (internal && /^--(?:model|binary|serve-record)$/.test(option[1]))) continue;
    const [, name, value] = option;
    flags.push(name);
    if (value) {
      const privateFlag = /key|token$|password|secret|host|user|path|dir|listen|bind|serial|address|url|header/i.test(name);
      const safe = /^[\w.+:%-]+$/.test(value) || (/^--(?:model|draft-model)$/.test(name) && publicModel(value) === value);
      flags.push(safe && !privateFlag ? value : "[redacted]");
    }
  }
  return flags.join(" ");
}

export async function memorySample() {
  const [swap, free] = await Promise.all([commandOutput("sysctl", ["-n", "vm.swapusage"]), commandOutput("memory_pressure", ["-Q"])]);
  return { swapGB: swapGB(swap), freePercent: freeMemoryPercent(free) };
}

export async function environment(port: number, launcher: { name: string; path: string | null }, served: ServedModel & { instanceModel?: string }) {
  const record = readRecord(port);
  const pid = record?.pid;
  const owned = startedByUs(port, record) ? ownedFlags(port) : null;
  const [display, batt, power, therm, command, version] = await Promise.all([
    commandOutput("system_profiler", ["SPDisplaysDataType"]), commandOutput("pmset", ["-g", "batt"]),
    commandOutput("pmset", ["-g"]), commandOutput("pmset", ["-g", "therm"]),
    pid ? commandOutput("ps", ["-o", "args=", "-p", String(pid)]) : "",
    launcher.path ? launcherVersion(launcher.path) : "",
  ]);
  const { chip, memoryGB, macos } = detectMac();
  const cores = /Total Number of Cores:\s*(\d+)/i.exec(display);
  const low = /^\s*lowpowermode\s+([01])\b/im.exec(power);
  const warning = /\bthermal(?: warning)?\s*level\s*[:=]\s*(\w+)/i.exec(therm)?.[1];
  return {
    packageVersion: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string,
    chip, memoryGB, macos, gpuCores: cores ? Number(cores[1]) : undefined,
    power: /'AC Power'/.test(batt) ? "AC" : /'Battery Power'/.test(batt) ? "battery" : undefined,
    lowPower: low ? low[1] === "1" : undefined,
    thermalWarning: warning && !/^(0|none|normal|nominal)$/i.test(warning) ? warning : undefined,
    runtime: launcher.name, runtimeVersion: versionOf(version),
    model: publicModel(served.instanceModel) ?? publicModel(served.id) ?? "[local model]", context: served.context, flags: owned ? serverFlags(["serve", ...owned].join(" ")) : serverFlags(command),
    flagsSource: owned ? "start" : "server process",
  };
}

export type BenchEnvironment = Awaited<ReturnType<typeof environment>>;
export type MemorySample = Awaited<ReturnType<typeof memorySample>>;
