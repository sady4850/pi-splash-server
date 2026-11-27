import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { alive, RUNTIME_DIR, STATE_DIR, versionOf } from "./server.ts";

export const M1_REPO = "paperniuk/splash";
export const INSTALL_LOG = join(STATE_DIR, "install.log");
const LOCK = join(STATE_DIR, "install.lock");

export type InstallEnv = { [key: string]: string | undefined };

export function scriptUrl(tag: string, base = `https://github.com/${M1_REPO}/releases/download/${tag}`) {
  return `${base}/install-m1.sh`;
}

export function archiveUrl(tag: string, base = `https://github.com/${M1_REPO}/releases/download/${tag}`) {
  return `${base}/splash-${tag}-arm64-macos26.tar.gz`;
}

export function appDir(env: InstallEnv = process.env) {
  return env.SPLASH_M1_HOME || join(homedir(), "Library/Application Support/Splash-M1");
}

export function writable(dir: string) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function binDir(env: InstallEnv = process.env, canWrite = writable) {
  if (env.SPLASH_BIN_DIR) return env.SPLASH_BIN_DIR;
  return existsSync("/opt/homebrew/bin") && canWrite("/opt/homebrew/bin") ? "/opt/homebrew/bin" : join(homedir(), ".local/bin");
}

export function launcherDirs(env: InstallEnv = process.env) {
  return [...(env.SPLASH_BIN_DIR ? [env.SPLASH_BIN_DIR] : []), "/opt/homebrew/bin", join(homedir(), ".local/bin")];
}

export function currentVersion(env: InstallEnv = process.env): string | null {
  try {
    return readlinkSync(join(appDir(env), "current"));
  } catch {
    return null;
  }
}

export async function archiveBytes(tag: string, timeoutMs = 10000): Promise<number | null> {
  try {
    const r = await fetch(archiveUrl(tag), { method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
    const n = Number(r.headers.get("content-length"));
    return r.ok && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function neededBytes(archive: number) {
  return archive * 5 + 5e8;
}

export function freeBytes(dir: string) {
  for (let d = dir; ; d = join(d, "..")) {
    try {
      const fs = statfsSync(d);
      return fs.bavail * fs.bsize;
    } catch {
      if (d === "/") return null;
    }
  }
}

export type Lock = { pid: number; child?: number; kind: "install" | "start"; tag: string; started: string };
const MAX_LOCK_MS = 60 * 60 * 1000;

export function readLock(path = LOCK): Lock | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function lockHeld(lock: Lock | null, isAlive = alive, now = Date.now()) {
  if (!lock || !(now - Date.parse(lock.started) < MAX_LOCK_MS)) return false;
  return isAlive(lock.pid) || (!!lock.child && isAlive(lock.child));
}

export function installing(path = LOCK): Lock | null {
  const lock = readLock(path);
  return lockHeld(lock) ? lock : null;
}

function tempBeside(path: string) {
  return `${path}.${process.pid}.${Math.random().toString(36).slice(2)}`;
}

export function takeLock(kind: Lock["kind"], tag: string, path = LOCK): Lock | null {
  mkdirSync(dirname(path), { recursive: true });
  const lock: Lock = { pid: process.pid, kind, tag, started: new Date().toISOString() };
  const tmp = tempBeside(path);
  writeFileSync(tmp, JSON.stringify(lock));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(tmp, path);
        return lock;
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e;
      }
      if (lockHeld(readLock(path))) return null;
      const stale = `${tmp}.stale`;
      try {
        renameSync(path, stale);
      } catch {
        continue;
      }
      const taken = readLock(stale);
      if (lockHeld(taken)) {
        try {
          linkSync(stale, path);
        } catch {}
        rmSync(stale, { force: true });
        return null;
      }
      rmSync(stale, { force: true });
    }
    return null;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function updateLock(lock: Lock, path = LOCK) {
  const tmp = tempBeside(path);
  writeFileSync(tmp, JSON.stringify(lock));
  renameSync(tmp, path);
}

export function releaseLock(lock: Lock, path = LOCK) {
  const held = readLock(path);
  if (held && held.pid === lock.pid && held.started === lock.started) rmSync(path, { force: true });
}

export function resetLog(path = INSTALL_LOG) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "");
}

export function isSplash(pid: number) {
  if (!alive(pid)) return false;
  try {
    return /splash/i.test(execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }));
  } catch {
    return false;
  }
}

function pidIn(file: string): number | null {
  try {
    const pid = JSON.parse(readFileSync(file, "utf8")).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function liveServers(runtimeDir = RUNTIME_DIR, stateDir = STATE_DIR, isAlive = isSplash): number[] {
  const ports = new Set<number>();
  for (const [dir, re] of [[runtimeDir, /^serve-(\d+)\.json$/], [stateDir, /^owned-(\d+)\.json$/]] as const) {
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {}
    for (const f of files) {
      const m = re.exec(f);
      const pid = m && pidIn(join(dir, f));
      if (m && pid && isAlive(pid)) ports.add(Number(m[1]));
    }
  }
  return [...ports].sort((a, b) => a - b);
}

export function progressOf(log: string): number | null {
  const all = [...log.matchAll(/(\d{1,3}(?:\.\d)?)%/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

export function installPhase(log: string): string {
  if (/^Installed\./m.test(log)) return "done";
  const pct = progressOf(log);
  if (pct === null) return /Downloading/.test(log) ? "downloading" : "starting";
  return pct >= 100 ? "checking and unpacking" : `downloading ${pct.toFixed(0)}%`;
}

export function failureOf(log: string): string | null {
  const lines = log.split(/[\r\n]/).map((l) => l.trim()).filter(Boolean);
  return lines.filter((l) => l.startsWith("splash-m1 install:")).pop()?.replace("splash-m1 install: ", "") ?? lines.pop() ?? null;
}

export async function fetchScript(url: string, timeoutMs = 15000): Promise<string> {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const text = await r.text();
  if (!text.startsWith("#!/bin/sh")) throw new Error(`${url} is not a shell script`);
  return text;
}

export type Run = { child: number; done: Promise<number | null> };

export function runScript(script: string, tag: string, env: InstallEnv = process.env, log = INSTALL_LOG, tmp = tmpdir()): Run {
  const dir = mkdtempSync(join(tmp, "pi-splash-install-"));
  const file = join(dir, "install-m1.sh");
  writeFileSync(file, script, { mode: 0o600 });
  mkdirSync(dirname(log), { recursive: true });
  const out = openSync(log, "w");
  const path = [env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin"].filter(Boolean).join(":");
  const cleanup = '/bin/sh "$1"; code=$?; rm -rf "$2"; exit $code';
  const child = spawn("/bin/sh", ["-c", cleanup, "install", file, dir], { detached: true, stdio: ["ignore", out, out], env: { ...env, PATH: path, SPLASH_M1_VERSION: tag } });
  closeSync(out);
  child.unref();
  const done = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(127));
    child.on("exit", (code) => resolve(code));
  });
  return { child: child.pid!, done };
}

export function checkLauncher(path: string, timeout = 20000): Promise<{ version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { timeout, encoding: "utf8" }, (e, stdout, stderr) => {
      const version = versionOf(stdout);
      if (!e && version) return resolve({ version, error: null });
      const why = e ? (e.killed ? `no answer in ${timeout / 1000} s` : (e as any).code === "EACCES" ? "not executable" : e.message.split("\n")[0]) : "no version in the output";
      resolve({ version: null, error: [why, stderr.trim().split("\n").pop()].filter(Boolean).join(": ") });
    });
  });
}

export function readLog(path = INSTALL_LOG) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
