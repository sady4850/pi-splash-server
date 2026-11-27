import { spawn, execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandOutput } from "./mac.ts";

export const DEFAULT_PORT = 8000;
export const RUNTIME_DIR = join(homedir(), "Library/Application Support/Splash/runtime");
export const STATE_DIR = join(homedir(), ".pi/agent/splash");

export type Phase = "starting" | "loading" | "warming" | "ready" | "recovering" | "failed";
export type Record = {
  pid: number;
  phase: Phase;
  warmup?: { steps_done: number; steps: number };
  failure?: { kind?: string; message?: string };
};
export type ServedModel = { id: string; context: number; inputModalities: string[]; laterSystem: boolean };
type ListedModel = ServedModel & { ids: string[] };

export function findLauncher(name: string, dirs: string[] = [], isExecutable = executable): string | null {
  try {
    const found = execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {}
  return dirs.map((d) => join(d, name)).find(isExecutable) ?? null;
}

export function resolveLauncher(configured: string | undefined, name: string, dirs: string[], isExecutable = executable): string | null {
  if (!configured) return findLauncher(name, dirs, isExecutable);
  if (!configured.includes("/")) return findLauncher(configured, [], isExecutable);
  return isExecutable(configured) ? configured : null;
}

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function launcherVersion(path: string): Promise<string> {
  return commandOutput(path, ["--version"], 10000);
}

export const RELEASES: { [runtime: string]: string } = { "splash-m1": "paperniuk/splash", splash: "incoai/splash" };

export function versionOf(text: string): string | null {
  return /Splash\s+(\S+)/.exec(text)?.[1] ?? null;
}

export async function latestRelease(runtime: string, timeoutMs = 5000): Promise<string | null> {
  try {
    const r = await fetch(`https://github.com/${RELEASES[runtime]}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    return /\/releases\/tag\/([^/?#]+)/.exec(r.headers.get("location") ?? "")?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readRecord(port: number): Record | null {
  try {
    return JSON.parse(readFileSync(join(RUNTIME_DIR, `serve-${port}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isSplash(pid: number) {
  if (!alive(pid)) return false;
  try {
    return /splash/i.test(execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

export function processId(pid: number): string | null {
  try {
    const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return started ? `${pid}@${started}` : null;
  } catch {
    return null;
  }
}

export function describe(record: Record | null, live = isSplash): string {
  if (!record) return "not running";
  if (record.phase !== "failed" && !live(record.pid)) return "not running";
  switch (record.phase) {
    case "warming":
      return record.warmup ? `warming ${record.warmup.steps_done}/${record.warmup.steps}` : "warming";
    case "failed":
      return `failed: ${record.failure?.message ?? record.failure?.kind ?? "unknown"}`;
    default:
      return record.phase;
  }
}

const base = (port: number) => `http://127.0.0.1:${port}`;

async function getJSON(url: string, abort?: AbortSignal): Promise<any> {
  try {
    const timeout = AbortSignal.timeout(2000);
    const r = await fetch(url, {
      headers: process.env.SPLASH_API_KEY ? { authorization: `Bearer ${process.env.SPLASH_API_KEY}` } : {},
      signal: abort ? AbortSignal.any([timeout, abort]) : timeout,
    });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function servesModel(requested: string, served: string[]): boolean {
  return served.some((id) => id.toLowerCase() === requested.toLowerCase());
}

export function parseModels(listing: any): Omit<ListedModel, "laterSystem"> | null {
  if (!Array.isArray(listing?.data)) return null;
  const m = listing.data[0];
  if (!m || m.owned_by !== "splash" || !Number.isInteger(m.context_length) || m.context_length <= 0) return null;
  const ids = listing.data.map((entry: any) => entry?.id).filter((id: unknown) => typeof id === "string");
  return { id: m.id, ids, context: m.context_length, inputModalities: m.input_modalities ?? ["text"] };
}

export function parseLaterSystem(status: any): boolean {
  const outcome = status?.chat_template?.later_system;
  const outcomes = outcome && typeof outcome === "object" ? Object.values(outcome) : [outcome];
  return outcomes.every((o) => o === "native" || o === "patched");
}

export async function probe(port: number, signal?: AbortSignal): Promise<(ListedModel & { instanceModel?: string }) | null> {
  const model = parseModels(await getJSON(`${base(port)}/v1/models`, signal));
  if (!model) return null;
  const status = await getJSON(`${base(port)}/status`, signal);
  if (status?.ready === false) return null;
  return { ...model, instanceModel: typeof status?.instance?.model === "string" ? status.instance.model : undefined,
    laterSystem: parseLaterSystem(status) };
}

export type StartOptions = { launcher: string; model: string; flags: string[]; port: number; keepAwake: boolean; stopWithPid?: number };

export function logPath(port: number) {
  return join(STATE_DIR, `serve-${port}.log`);
}

export function start(o: StartOptions): number {
  mkdirSync(STATE_DIR, { recursive: true });
  const out = openSync(logPath(o.port), "w");
  const args = [o.launcher, "serve", "--model", o.model, ...o.flags, "--port", String(o.port)];
  const [cmd, ...rest] = o.keepAwake ? ["/usr/bin/caffeinate", "-i", ...args] : args;
  const env = { ...process.env, ...(o.stopWithPid ? { SPLASH_APP_PID: String(o.stopWithPid) } : {}) };
  const child = spawn(cmd, rest, { detached: true, stdio: ["ignore", out, out], env });
  closeSync(out);
  child.on("error", (e) => {
    try {
      appendFileSync(logPath(o.port), `pi-splash-server: could not run ${cmd}: ${e.message}\n`);
    } catch {}
  });
  child.unref();
  writeFileSync(join(STATE_DIR, `owned-${o.port}.json`), JSON.stringify({ pid: child.pid, model: o.model, flags: o.flags, started: new Date().toISOString() }));
  return child.pid!;
}

export function ownedPid(port: number): number | null {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `owned-${port}.json`), "utf8")).pid;
  } catch {
    return null;
  }
}

export function ownedFlags(port: number): string[] | null {
  try {
    const { flags } = JSON.parse(readFileSync(join(STATE_DIR, `owned-${port}.json`), "utf8"));
    return Array.isArray(flags) && flags.every((f) => typeof f === "string") ? flags : null;
  } catch {
    return null;
  }
}

export function parentPid(pid: number): number | null {
  try {
    const out = execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return out ? Number(out) : null;
  } catch {
    return null;
  }
}

export function startedByUs(port: number, record: Record | null, parent = parentPid): boolean {
  const owner = ownedPid(port);
  if (!owner || !record) return false;
  for (let pid: number | null = record.pid, i = 0; pid && pid > 1 && i < 8; pid = parent(pid), i++) {
    if (pid === owner) return true;
  }
  return false;
}

export function lastLine(log: string, width = 80): string {
  const line = log.split(/[\r\n]/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
  return line.length > width ? line.slice(0, width - 1) + "…" : line;
}

function logTail(port: number, bytes = 4096): string {
  try {
    const fd = openSync(logPath(port), "r");
    try {
      const size = fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(bytes, size));
      readSync(fd, buf, 0, buf.length, size - buf.length);
      return buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

export async function waitReady(port: number, signal: AbortSignal, onPhase: (text: string) => void, starting?: () => string | null): Promise<Record | null> {
  let last = "";
  const t0 = Date.now();
  while (!signal.aborted) {
    const record = readRecord(port);
    const phase = describe(record);
    const text = phase === "starting" || phase === "not running" ? (starting?.() ?? ["starting", lastLine(logTail(port))].filter(Boolean).join(": ")) : phase;
    if (text !== last) {
      onPhase(text);
      last = text;
    }
    if (record?.phase === "ready" && (await probe(port))) return record;
    if (record?.phase === "failed") return record;
    const pid = ownedPid(port);
    const owner = pid !== null && isSplash(pid);
    if (!owner && (!record || !alive(record.pid)) && Date.now() - t0 > 5000) return record;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

async function signalAndWait(pid: number, target: number): Promise<boolean> {
  try {
    process.kill(target, "SIGINT");
  } catch {
    return !alive(pid);
  }
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return !alive(pid);
}

function forgetOwned(port: number) {
  if (existsSync(join(STATE_DIR, `owned-${port}.json`))) rmSync(join(STATE_DIR, `owned-${port}.json`));
}

export async function stop(port: number, record: Record, live = isSplash): Promise<boolean> {
  const gone = !live(record.pid) || (await signalAndWait(record.pid, record.pid));
  if (gone) forgetOwned(port);
  return gone;
}

export function startingOwned(port: number, live = isSplash): number | null {
  const pid = ownedPid(port);
  return pid !== null && live(pid) ? pid : null;
}

export async function stopOwned(port: number, pid: number): Promise<boolean> {
  const gone = await signalAndWait(pid, -pid);
  if (gone) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    forgetOwned(port);
  }
  return gone;
}
