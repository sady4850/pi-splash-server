import { execFile, execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function commandOutput(cmd: string, args: string[], timeout = 5000): Promise<string> {
  try {
    return (await exec(cmd, args, { timeout, encoding: "utf8" })).stdout.trim();
  } catch {
    return "";
  }
}

export type Mac = {
  chip: string;
  family: number | null;
  memoryGB: number;
  freeDiskGB: number;
  macos: string;
};

export function parseFamily(chip: string): number | null {
  const m = /Apple M(\d+)/.exec(chip);
  return m ? Number(m[1]) : null;
}

export function runtimeFor(family: number | null): "splash-m1" | "splash" | null {
  if (family === null) return null;
  return family <= 2 ? "splash-m1" : "splash";
}

export function macosWarning(runtime: string | null, version: string): string | null {
  if (runtime !== "splash-m1" || !version) return null;
  const [major, minor = 0] = version.split(".").map(Number);
  return major > 26 || (major === 26 && minor >= 4) ? null : `splash-m1 needs macOS 26.4 or newer; this Mac runs ${version}.`;
}

function run(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "";
  }
}

export function detectMac(): Mac {
  const chip = run("sysctl", ["-n", "machdep.cpu.brand_string"]) || "unknown";
  const fs = statfsSync(homedir());
  return {
    chip,
    family: parseFamily(chip),
    memoryGB: Math.round(totalmem() / 2 ** 30),
    freeDiskGB: (fs.bavail * fs.bsize) / 1e9,
    macos: run("sw_vers", ["-productVersion"]),
  };
}
