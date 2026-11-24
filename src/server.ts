import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function findLauncher(name: string): string | null {
  try {
    return execFileSync("/usr/bin/which", [name], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

export function launcherVersion(path: string): string {
  try {
    return execFileSync(path, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return "";
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

export function describe(record: Record | null): string {
  if (!record) return "not running";
  if (record.phase !== "failed" && !alive(record.pid)) return "not running";
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

async function getJSON(url: string, timeoutMs = 2000): Promise<any> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function parseModels(listing: any): Omit<ServedModel, "laterSystem"> | null {
  const m = listing?.data?.[0];
  if (!m || m.owned_by !== "splash" || !Number.isInteger(m.context_length) || m.context_length <= 0) return null;
  return { id: m.id, context: m.context_length, inputModalities: m.input_modalities ?? ["text"] };
}

export function parseLaterSystem(status: any): boolean {
  const outcome = status?.chat_template?.later_system;
  const outcomes = outcome && typeof outcome === "object" ? Object.values(outcome) : [outcome];
  return outcomes.every((o) => o === "native" || o === "patched");
}

export async function probe(port: number): Promise<ServedModel | null> {
  const model = parseModels(await getJSON(`${base(port)}/v1/models`));
  if (!model) return null;
  return { ...model, laterSystem: parseLaterSystem(await getJSON(`${base(port)}/status`)) };
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
  child.unref();
  writeFileSync(join(STATE_DIR, `owned-${o.port}.json`), JSON.stringify({ pid: child.pid, model: o.model, started: new Date().toISOString() }));
  return child.pid!;
}

export function ownedPid(port: number): number | null {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `owned-${port}.json`), "utf8")).pid;
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

export async function waitReady(port: number, signal: AbortSignal, onPhase: (text: string) => void): Promise<Record | null> {
  let last = "";
  const t0 = Date.now();
  while (!signal.aborted) {
    const record = readRecord(port);
    const phase = describe(record);
    const text = phase === "starting" || phase === "not running" ? `starting: ${lastLine(logTail(port))}` : phase;
    if (text !== last) {
      onPhase(text);
      last = text;
    }
    if (record?.phase === "ready" && (await probe(port))) return record;
    if (record?.phase === "failed") return record;
    const pid = ownedPid(port);
    if (pid && !alive(pid) && Date.now() - t0 > 5000) return record;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export async function stop(port: number, record: Record): Promise<boolean> {
  try {
    process.kill(record.pid, "SIGINT");
  } catch {
    return true;
  }
  for (let i = 0; i < 60; i++) {
    if (!alive(record.pid)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const gone = !alive(record.pid);
  if (gone && existsSync(join(STATE_DIR, `owned-${port}.json`))) rmSync(join(STATE_DIR, `owned-${port}.json`));
  return gone;
}
