import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Mac } from "./mac.ts";
import { runtimeFor } from "./mac.ts";

export type Entry = {
  minMemoryGB: number;
  runtimes: string[];
  model: string;
  flags: string[];
  weightsGB: number;
  evidence: string;
  note: string;
};

export function loadEntries(): Entry[] {
  const url = new URL("../data/recommendations.json", import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")).entries;
}

export function recommend(mac: Pick<Mac, "family" | "memoryGB">, entries = loadEntries()) {
  const runtime = runtimeFor(mac.family);
  const fitting = entries
    .filter((e) => runtime && e.runtimes.includes(runtime) && e.minMemoryGB <= mac.memoryGB)
    .sort((a, b) => b.minMemoryGB - a.minMemoryGB);
  return { runtime, pick: fitting[0] ?? null, smaller: fitting[1] ?? null };
}

export const SPLASH_FREE_GB = 10.7;
export const DRAFT_GB = 3.6;

export function diskWarnings(mac: Pick<Mac, "freeDiskGB">, pick: Entry | null, downloaded: boolean): string[] {
  const out: string[] = [];
  const need = (downloaded || !pick ? 0 : pick.weightsGB + DRAFT_GB) + SPLASH_FREE_GB;
  if (mac.freeDiskGB < need) {
    out.push(`Free disk ${mac.freeDiskGB.toFixed(1)} GB, need about ${need.toFixed(0)} GB.`);
  }
  const cacheGB = Math.max(0, (mac.freeDiskGB - (downloaded || !pick ? 0 : pick.weightsGB + DRAFT_GB) - SPLASH_FREE_GB) / 4);
  if (cacheGB < 4) {
    out.push(`SSD prompt cache will get about ${cacheGB.toFixed(1)} GB: new sessions re-read their prompt more often. Free ~25 GB for a useful cache.`);
  }
  return out;
}

export function isDownloaded(model: string, hub = join(homedir(), ".cache/huggingface/hub")): boolean {
  const [repo, quant] = model.split(":");
  const snapshots = join(hub, `models--${repo.replace("/", "--")}`, "snapshots");
  if (!existsSync(snapshots)) return false;
  return readdirSync(snapshots).some((rev) => {
    const files = readdirSync(join(snapshots, rev), { recursive: true }).map(String);
    return quant ? files.some((f) => f.endsWith(".gguf") && f.includes(quant)) : files.some((f) => f.endsWith(".safetensors"));
  });
}
