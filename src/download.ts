import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RepoFile = { path: string; size: number; blob: string };
export type RepoPlan = { repo: string; files: RepoFile[]; missing: RepoFile[] };

export const HUB = join(homedir(), ".cache/huggingface/hub");

async function fetchTree(url: string, timeoutMs: number, tries = 2): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) {
    if (tries > 1) return fetchTree(url, timeoutMs, tries - 1);
    throw new Error(e?.cause?.code ?? (e?.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : e?.message));
  }
}

export async function listRepo(repo: string, timeoutMs = 5000): Promise<RepoFile[]> {
  const r = await fetchTree(`https://huggingface.co/api/models/${repo}/tree/main?recursive=true`, timeoutMs);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${repo}`);
  const entries: any[] = await r.json();
  return entries
    .filter((e) => e.type === "file")
    .map((e) => ({ path: e.path, size: e.lfs?.size ?? e.size, blob: e.lfs?.oid ?? e.oid }));
}

const SPLIT = /-\d{5}-of-\d{5}\.gguf$/;
const isProjector = (path: string) => !path.includes("/") && path.endsWith(".gguf") && /mmproj/i.test(path);

export function pickFiles(files: RepoFile[], variant: string | undefined, languageOnly: boolean): RepoFile[] {
  if (!variant) return files.filter((f) => !f.path.includes("/") && f.path.endsWith(".safetensors"));
  const v = variant.toLowerCase();
  const model = files.filter((f) => {
    if (!f.path.endsWith(".gguf") || isProjector(f.path)) return false;
    const name = f.path.replace(SPLIT, "").replace(/\.gguf$/, "").toLowerCase();
    return f.path.includes("/") ? f.path.split("/")[0].toLowerCase() === v : name === v || name.endsWith("-" + v);
  });
  if (languageOnly) return model;
  const projectors = files.filter((f) => isProjector(f.path));
  const projector = ["BF16", "F32", "F16"].map((p) => projectors.find((f) => f.path.toUpperCase().includes(p))).find(Boolean);
  return projector ? [...model, projector] : model;
}

export function missingFiles(repo: string, files: RepoFile[], hub = HUB): RepoFile[] {
  const blobs = join(hub, `models--${repo.replace("/", "--")}`, "blobs");
  return files.filter((f) => {
    try {
      return statSync(join(blobs, f.blob)).size !== f.size;
    } catch {
      return true;
    }
  });
}

export async function planDownload(model: string, draft: string | undefined, languageOnly: boolean, hub = HUB): Promise<RepoPlan[]> {
  const [repo, variant] = model.split(":");
  const wanted: [string, string | undefined][] = [[repo, variant], ...(draft ? [[draft, undefined] as [string, undefined]] : [])];
  return Promise.all(
    wanted.map(async ([r, v]) => {
      const files = pickFiles(await listRepo(r), v, languageOnly);
      if (!files.length) throw new Error(`no files for ${v ? `${r}:${v}` : r}`);
      return { repo: r, files, missing: missingFiles(r, files, hub) };
    }),
  );
}

export const bytes = (files: RepoFile[]) => files.reduce((s, f) => s + f.size, 0);
export const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;

export function downloadLines(plan: RepoPlan[]): string[] {
  const missing = plan.flatMap((r) => r.missing);
  if (!missing.length) return [`Downloaded: all ${plan.reduce((n, r) => n + r.files.length, 0)} files in the Hugging Face cache.`];
  return [
    `Download: ${gb(bytes(missing))} of ${gb(bytes(plan.flatMap((r) => r.files)))}`,
    ...plan.map((r) => `  ${r.repo}: ${r.missing.length ? `${r.missing.length} of ${r.files.length} files, ${gb(bytes(r.missing))}` : "complete"}`),
  ];
}

export function bytesOnDisk(plan: RepoPlan[], hub = HUB): number {
  let total = 0;
  for (const r of plan) {
    const blobs = join(hub, `models--${r.repo.replace("/", "--")}`, "blobs");
    let names: string[] = [];
    try {
      names = readdirSync(blobs);
    } catch {
      continue;
    }
    for (const f of r.missing) {
      let held = 0;
      for (const n of names) {
        if (n !== f.blob && !n.startsWith(f.blob + ".")) continue;
        try {
          held = Math.max(held, statSync(join(blobs, n)).size);
        } catch {}
      }
      total += Math.min(held, f.size);
    }
  }
  return total;
}
