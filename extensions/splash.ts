import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runBench } from "../src/bench.ts";
import { benchReport, shareUrl } from "../src/bench-report.ts";
import { loadCatalog, startCompletions } from "../src/catalog.ts";
import { detectMac, macosWarning, runtimeFor } from "../src/mac.ts";
import { DRAFT_GB, loadEntries, recommend, diskWarnings, isDownloaded } from "../src/recommend.ts";
import { bytes, bytesOnDisk, downloadLabel, downloadLines, downloadNotice, gb, planDownload } from "../src/download.ts";
import { downloadProgress } from "../src/netbytes.ts";
import { providerConfig, providerName } from "../src/provider.ts";
import {
  INSTALL_LOG, M1_REPO, appDir, archiveBytes, binDir, checkLauncher, currentVersion, failureOf, fetchScript, freeBytes, installPhase,
  installing, launcherDirs, liveServers, neededBytes, readLog, releaseLock, resetLog, runScript, scriptUrl, takeLock, updateLock, type Lock,
} from "../src/install.ts";
import { countTokens, headKey, needsWarm, opensSession, readWarmed, warm, writeWarmed } from "../src/prewarm.ts";
import {
  DEFAULT_PORT, STATE_DIR, describe, latestRelease, processId, resolveLauncher, startingOwned, stopOwned, launcherVersion, logPath, probe, readRecord,
  type ServedModel, servesModel, start, startedByUs, stop, versionOf, waitReady,
} from "../src/server.ts";

type Config = { port?: number; model?: string; flags?: string[]; stopOnExit?: boolean; keepAwake?: boolean; launcher?: string };

const INSTALL = {
  "splash-m1": "curl -fsSL https://github.com/paperniuk/splash/releases/latest/download/install-m1.sh | sh",
  splash: "brew install incoai/tap/splash",
};
const UPDATE = { ...INSTALL, splash: "brew upgrade incoai/tap/splash" };

function config(): Config {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, "config.json"), "utf8"));
  } catch {
    return {};
  }
}

export default async function (pi: ExtensionAPI) {
  const port = () => config().port ?? DEFAULT_PORT;

  const atLoad = await probe(port());
  if (atLoad) pi.registerProvider(providerName(port()), providerConfig(port(), atLoad) as any);

  async function register(ctx: any, switchTo: boolean, p = port(), known?: ServedModel) {
    const served = known ?? await probe(p);
    if (!served) return null;
    pi.registerProvider(providerName(p), providerConfig(p, served) as any);
    let switched = false;
    if (switchTo) {
      const model = ctx.modelRegistry.find(providerName(p), served.id);
      switched = !!model && (await pi.setModel(model));
      if (!switched) ctx.ui.notify(`Could not switch to ${providerName(p)}/${served.id}; pick it with /model.`, "error");
    }
    return { served, switched };
  }

  function launcher(): { name: string; path: string | null } {
    const c = config();
    const name = runtimeFor(detectMac().family) ?? "splash";
    return { name, path: resolveLauncher(c.launcher, name, launcherDirs()) };
  }

  async function doctor(): Promise<string[]> {
    const mac = detectMac();
    const { runtime, pick, smaller } = recommend(mac);
    const l = launcher();
    const installed = l.path ? versionOf(await launcherVersion(l.path)) : null;
    const [latest, plan] = await Promise.all([
      l.path ? latestRelease(l.name) : Promise.resolve(null),
      pick ? planDownload(pick.model, pick.draft, pick.flags.includes("--language-only")).catch((e: Error) => e) : Promise.resolve(null),
    ]);
    const busy = installing();
    const lines = [
      `${mac.chip}, ${mac.memoryGB} GB, macOS ${mac.macos}, ${mac.freeDiskGB.toFixed(1)} GB free`,
      busy
        ? installLine(busy)
        : !l.path
        ? `Runtime: ${runtime ?? "none"} not installed. Install: /splash install`
        : `Runtime: ${l.name} ${installed ?? "?"}${latest === installed ? ", latest" : ""} (${l.path})`,
    ];
    if (!busy && l.path && latest && latest !== installed) lines.push(`  ${latest} is out. Update: /splash update`);
    let downloadGB = 0;
    if (!pick) lines.push("No measured model fits this Mac yet.");
    else {
      lines.push(`Recommended: ${pick.model} ${pick.flags.join(" ")}`.trim());
      lines.push(`  ${pick.note}`, `  Evidence: ${pick.evidence}`);
      if (plan instanceof Error || !plan) {
        const have = isDownloaded(pick.model);
        downloadGB = have ? 0 : pick.weightsGB + DRAFT_GB;
        lines.push(`  Hugging Face Hub not reachable (${(plan as Error)?.message ?? "no plan"}), so files are not checked.`);
        lines.push(have ? "  Model looks downloaded; the draft is not checked." : `  Download: about ${downloadGB.toFixed(1)} GB with the draft.`);
      } else {
        downloadGB = bytes(plan.flatMap((r) => r.missing)) / 1e9;
        lines.push(...downloadLines(plan).map((x) => `  ${x}`));
      }
      if (smaller) lines.push(`Smaller: ${smaller.model} (${smaller.weightsGB} GB)`);
    }
    const macos = macosWarning(runtime, mac.macos);
    for (const w of [...(macos ? [macos] : []), ...diskWarnings(mac, downloadGB)]) lines.push(`Warning: ${w}`);
    return lines;
  }

  async function status(ctx: any) {
    const p = port();
    const record = readRecord(p);
    const served = await probe(p);
    const lines = [`Port ${p}: ${describe(record)}${record && startedByUs(p, record) ? " (started by pi-splash-server)" : ""}`];
    if (served) lines.push(`Model ${served.id}, ${served.context.toLocaleString()} context tokens`);
    const phase = describe(record);
    const busy = installing();
    if (served && ctx.model?.provider !== providerName(p)) lines.push("Switch to it: /splash use");
    else if (busy) lines.push(installLine(busy));
    else if (!served && (phase === "not running" || phase.startsWith("failed"))) lines.push("Start one: /splash start");
    else if (served && record && startedByUs(p, record)) lines.push("Stop it: /splash stop");
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function startCmd(model: string | undefined, ctx: any) {
    const p = port();
    const served = await probe(p);
    if (served) {
      if (model && !servesModel(model, served.ids)) {
        ctx.ui.notify(`Port ${p} serves ${served.id}, not ${model}. Switch to what runs: /splash use. Or /splash stop, then /splash start ${model}.`, "error");
        return;
      }
      if ((await register(ctx, true, p, served))?.switched) ctx.ui.notify(`Splash already serves on port ${p}; using it.`, "info");
      return;
    }
    const running = starting(p);
    if (following || running) {
      const loading = model && running && !startedByUs(p, running) ? undefined : ownedModel(p);
      if (model && (!loading || !servesModel(model, [loading]))) {
        ctx.ui.notify(`Port ${p} is starting ${loading ?? "an unknown model"}. Switch when ready: /splash use. Or /splash stop, then /splash start ${model}.`, "error");
        return;
      }
      if (following) {
        ctx.ui.notify(`Already following the start on port ${p}: ${describe(readRecord(p))}.`, "info");
      } else if (running) {
        ctx.ui.notify(`Splash is already starting on port ${p} (${describe(running)}); following it in the status bar.`, "info");
        follow(p, running.pid, loading, ctx);
      }
      return;
    }
    if (refuseWhileInstalling(ctx)) return;
    const l = launcher();
    if (!l.path) {
      ctx.ui.notify((await doctor()).join("\n"), "error");
      return;
    }
    const c = config();
    const { pick } = recommend(detectMac());
    const chosen = model || c.model || pick?.model;
    if (!chosen) {
      ctx.ui.notify("No model given and none recommended for this Mac.", "error");
      return;
    }
    const flags = c.flags ?? (chosen === pick?.model ? pick.flags : loadCatalog().some((m) => m.model === chosen) ? ["--language-only"] : []);
    if (!(await confirmDownload(chosen, flags, ctx))) return ctx.ui.notify("Not started.", "info");
    const gate = lockOrSay("start", chosen, ctx);
    if (!gate) return;
    let pid: number;
    try {
      pid = start({ launcher: l.path, model: chosen, flags, port: p, keepAwake: c.keepAwake ?? true, stopWithPid: c.stopOnExit ? process.pid : undefined });
    } finally {
      releaseLock(gate);
    }
    ctx.ui.notify(`Starting ${[chosen, ...flags].join(" ")}. Progress in the status bar; Pi stays usable. Log: ${logPath(p)}`, "info");
    follow(p, pid, chosen, ctx, flags);
  }

  function draftFor(model: string) {
    return loadEntries().find((e) => e.model === model)?.draft ?? loadCatalog().find((m) => m.model === model)?.draft;
  }

  async function confirmDownload(model: string, flags: string[], ctx: any) {
    const mac = detectMac();
    const entry = loadCatalog().find((m) => m.model === model);
    const name = entry ? `${entry.family} ${entry.quant}` : model;
    const free = (downloadGB: number) => [
      `${mac.freeDiskGB.toFixed(1)} GB free on disk, about ${Math.max(0, mac.freeDiskGB - downloadGB).toFixed(1)} GB left after. Progress shows in the status bar; Pi stays usable.`,
      ...diskWarnings(mac, downloadGB).map((w) => `Warning: ${w}`)].join("\n");
    const plan = await planDownload(model, draftFor(model), flags.includes("--language-only")).catch(() => null);
    if (plan) {
      const missing = bytes(plan.flatMap((r) => r.missing));
      const parts = plan.map((r) => `${r.draft ? "Draft" : "Model"} ${r.repo}${r.draft || !model.includes(":") ? "" : `:${model.split(":")[1]}`}: ${r.missing.length ? gb(bytes(r.missing)) : "already downloaded"}`);
      return !missing || ctx.ui.confirm(`Download ${name}, ${gb(missing)}?`,
        `From Hugging Face into ~/.cache/huggingface/hub:\n${parts.map((x) => `  ${x}`).join("\n")}\n${free(missing / 1e9)}`);
    }
    if (isDownloaded(model)) return true;
    const size = entry?.weightsGB;
    return ctx.ui.confirm(`Download ${name}?`, `${model}${size ? `, about ${(size + DRAFT_GB).toFixed(1)} GB with the draft` : ""} from Hugging Face into ~/.cache/huggingface/hub (Hugging Face not reachable now to check sizes).\n${free(size ? size + DRAFT_GB : 0)}`);
  }

  function starting(p: number) {
    const record = readRecord(p);
    const phase = describe(record);
    return record && phase !== "not running" && !phase.startsWith("failed") ? record : null;
  }

  function ownedModel(p: number): string | undefined {
    try {
      const { model } = JSON.parse(readFileSync(join(STATE_DIR, `owned-${p}.json`), "utf8"));
      return typeof model === "string" ? model : undefined;
    } catch {
      return undefined;
    }
  }

  let following: AbortController | null = null;

  async function follow(p: number, pid: number, model: string | undefined, ctx: any, flags?: string[]) {
    const abort = (following = new AbortController());
    let progress: ReturnType<typeof downloadProgress> | null = null;
    try {
      if (model) {
        const draft = draftFor(model);
        const f = flags ?? config().flags ?? recommend(detectMac()).pick?.flags ?? [];
        const plan = await planDownload(model, draft, f.includes("--language-only")).catch(() => null);
        const missing = plan ? bytes(plan.flatMap((r) => r.missing)) : null;
        if (abort.signal.aborted) return;
        if (plan && missing) ctx.ui.notify(downloadNotice(plan), "info");
        if (missing !== 0) progress = downloadProgress(pid, missing, plan ? () => bytesOnDisk(plan) : undefined, plan ? downloadLabel(plan) : "");
      } else {
        progress = downloadProgress(pid, null);
      }
      const record = await waitReady(p, abort.signal, (t) => ctx.ui.setStatus("splash", `splash: ${t}`), progress?.text);
      if (abort.signal.aborted) return;
      ctx.ui.setStatus("splash", undefined);
      if (record?.phase === "ready") {
        const r = await register(ctx, true, p);
        if (!r) ctx.ui.notify(`Splash on port ${p} said ready but does not answer. Log: ${logPath(p)}`, "error");
        else if (r.switched) ctx.ui.notify(`Splash ready: ${r.served.id}, ${r.served.context.toLocaleString()} context tokens (back: /model)`, "info");
      } else {
        ctx.ui.notify(`Splash did not start: ${describe(record)}. Log: ${logPath(p)}`, "error");
      }
    } catch (e: any) {
      try {
        ctx.ui.setStatus("splash", undefined);
        ctx.ui.notify(`Lost track of the Splash start: ${e?.message ?? e}. Log: ${logPath(p)}`, "error");
      } catch {}
    } finally {
      progress?.stop();
      if (following === abort) following = null;
    }
  }

  function unfollow(ctx?: any) {
    following?.abort();
    following = null;
    ctx?.ui.setStatus("splash", undefined);
  }

  let bench: { abort: AbortController; done: Promise<void> } | null = null;
  let mac: ReturnType<typeof detectMac> | undefined;

  async function benchmark(long: boolean, ctx: any, signal: AbortSignal) {
    const p = port();
    const progress = (text: string) => ctx.ui.setStatus("splash", `splash: bench ${text}`);
    try {
      const { result, filename } = await runBench(p, long, signal, launcher, progress);
      const share = result.error ? "" : "\nShare: /splash bench share opens a prefilled GitHub issue, you check it and submit";
      ctx.ui.notify(`${benchReport(result)}\nJSON: ~/.pi/agent/splash/${filename}${share}`, result.error ? "error" : "info");
    } catch (e) {
      ctx.ui.notify(`Splash bench: ${signal.aborted ? "aborted" : e instanceof Error ? e.message : String(e)}`, "error");
    } finally {
      bench = null;
      ctx.ui.setStatus("splash", undefined);
    }
  }

  function shareCmd(ctx: any) {
    let files: string[] = [];
    try {
      files = readdirSync(STATE_DIR);
    } catch {}
    const latest = files.filter((f) => /^bench-.*\.json$/.test(f)).sort().pop();
    if (!latest) return ctx.ui.notify("No bench results yet. Run /splash bench first.", "error");
    const url = shareUrl(JSON.parse(readFileSync(join(STATE_DIR, latest), "utf8")));
    execFile("/usr/bin/open", [url], (e) => {
      if (e) ctx.ui.notify(`Could not open the browser. Open this link:\n${url}`, "error");
      else ctx.ui.notify(`Opened a prefilled GitHub issue for ${latest}. Check it and press Submit.`, "info");
    });
  }

  async function stopCmd(ctx: any) {
    bench?.abort.abort();
    const p = port();
    const record = readRecord(p);
    if (!record || describe(record) === "not running") {
      const launching = startingOwned(p);
      if (!launching) return ctx.ui.notify("No Splash server running.", "info");
      unfollow(ctx);
      const stopped = await stopOwned(p, launching);
      return ctx.ui.notify(stopped ? "Stopped the Splash start." : "The Splash start did not stop within 60 s.", stopped ? "info" : "error");
    }
    if (!startedByUs(p, record) && !(await ctx.ui.confirm("Stop Splash?", `The server on port ${p} was not started by pi-splash-server.`))) return;
    unfollow(ctx);
    const stopped = await stop(p, record);
    const onIt = stopped && ctx.model?.provider === providerName(p) ? ` The session is still on ${ctx.model.provider}/${ctx.model.id}; switch with /model.` : "";
    ctx.ui.notify(stopped ? `Splash stopped.${onIt}` : "Splash did not stop within 60 s.", "info");
  }

  function offer(command: string, what: string, ctx: any) {
    ctx.ui.setEditorText(`!!${command}`);
    ctx.ui.notify(`${what}: the command is in the editor, press Enter to run it (or copy it to a terminal). Then /splash doctor.\n${command}`, "info");
  }

  function installLine(lock: Lock) {
    return lock.kind === "start"
      ? `Another session is starting Splash (${lock.tag}) right now; try again in a moment.`
      : `Runtime: installing splash-m1 ${lock.tag}: ${installPhase(readLog())}. Log: ${INSTALL_LOG}`;
  }

  function refuseWhileInstalling(ctx: any) {
    const busy = installing();
    if (busy) ctx.ui.notify(busy.kind === "start" ? installLine(busy) : `splash-m1 ${busy.tag} is being installed (${installPhase(readLog())}). Start when it is done: /splash start`, "error");
    return !!busy;
  }

  function lockOrSay(kind: Lock["kind"], tag: string, ctx: any): Lock | null {
    try {
      const lock = takeLock(kind, tag);
      if (!lock && !refuseWhileInstalling(ctx)) ctx.ui.notify("Another session holds the Splash install lock; try again in a moment.", "error");
      return lock;
    } catch (e: any) {
      ctx.ui.notify(`Could not create the lock in ${STATE_DIR}: ${e?.message ?? e}`, "error");
      return null;
    }
  }

  let install: { stop: () => void } | null = null;
  let closed = false;

  async function installCmd(update: boolean, ctx: any) {
    const runtime = runtimeFor(detectMac().family);
    if (!runtime) {
      ctx.ui.notify("Splash runs on Apple silicon only.", "error");
      return;
    }
    const busy = installing();
    if (busy) return ctx.ui.notify(installLine(busy), busy.kind === "start" ? "error" : "info");
    const l = launcher();
    if (runtime === "splash" && !l.path) return offer(INSTALL.splash, "Install splash", ctx);
    const installed = l.path ? versionOf(await launcherVersion(l.path)) : null;
    if (l.path && !update) {
      ctx.ui.notify(`${l.name} ${installed ?? "?"} is installed (${l.path}). Newer release: /splash update`, "info");
      return;
    }
    const latest = await latestRelease(runtime);
    if (l.path && latest && latest === installed) {
      ctx.ui.notify(`${l.name} ${installed} is the latest release.`, "info");
      return;
    }
    if (runtime === "splash") {
      const running = await probe(port());
      return offer(UPDATE.splash, `Update splash ${installed ?? "?"} to ${latest ?? "the latest release"}${running ? "; restart the server afterwards (/splash stop, /splash start)" : ""}`, ctx);
    }
    const macos = macosWarning(runtime, detectMac().macos);
    if (macos) return ctx.ui.notify(macos, "error");
    if (!latest) return ctx.ui.notify(`GitHub did not answer with the latest splash-m1 release. Try again, or run in a terminal:\n${INSTALL["splash-m1"]}`, "error");
    if (refuseWhileServing(ctx, update)) return;
    if (!ctx.hasUI) {
      process.stderr.write(`splash-m1 ${latest}: run in a terminal: ${INSTALL["splash-m1"]}\n`);
      return;
    }

    const app = appDir();
    const bin = binDir();
    const size = await archiveBytes(latest);
    const free = freeBytes(app);
    if (size && free !== null && free < neededBytes(size)) {
      return ctx.ui.notify(`Installing splash-m1 needs about ${gb(neededBytes(size))} free on disk, ${gb(free)} is free.`, "error");
    }
    const onPath = (process.env.PATH ?? "").split(":").includes(bin);
    const ok = await ctx.ui.confirm(
      update ? `Update splash-m1 ${installed ?? "?"} to ${latest}?` : `Install splash-m1 ${latest}?`,
      [
        `Runs the official installer of ${M1_REPO} ${latest}:`,
        `  ${scriptUrl(latest)}`,
        `It downloads ${size ? `${Math.round(size / 1e6)} MB` : "the release archive"}, checks its SHA-256, unpacks it into`,
        `  ${join(app, latest)}`,
        `and writes ${join(bin, "splash-m1")}${onPath ? "" : " (not on PATH: Pi finds it there, a terminal does not)"}.`,
        "Progress in the status bar; Pi stays usable.",
      ].join("\n"),
      ctx.mode === "rpc" ? { timeout: 120000 } : undefined,
    );
    if (ok !== true) return ctx.ui.notify("Not installed.", "info");

    const lock = lockOrSay("install", latest, ctx);
    if (!lock) return;
    let handedOff = false;
    try {
      resetLog();
      if (refuseWhileServing(ctx, update)) return;
      const now = launcher();
      if (now.path && versionOf(await launcherVersion(now.path)) === latest) return ctx.ui.notify(`splash-m1 ${latest} is already installed (${now.path}).`, "info");
      let script: string;
      try {
        script = await fetchScript(scriptUrl(latest));
      } catch (e: any) {
        return ctx.ui.notify(`Could not download the installer: ${e?.message ?? e}\nRun in a terminal instead: ${INSTALL["splash-m1"]}`, "error");
      }
      if (closed) return;
      const run = runScript(script, latest);
      handedOff = true;
      followInstall(run.done, lock, latest, bin, update, ctx);
      updateLock({ ...lock, child: run.child });
    } finally {
      if (!handedOff) releaseLock(lock);
    }
  }

  function refuseWhileServing(ctx: any, update: boolean) {
    const ports = liveServers();
    if (!ports.length) return false;
    const which = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(", ")}`;
    ctx.ui.notify(`Splash runs on ${which}. Stop it first${ports.includes(port()) ? " (/splash stop)" : ""}: the installer replaces the files a running server loads from. Then /splash ${update ? "update" : "install"}.`, "error");
    return true;
  }

  function followInstall(done: Promise<number | null>, lock: Lock, tag: string, bin: string, update: boolean, ctx: any) {
    let live = true;
    const show = () => {
      try {
        if (live) ctx.ui.setStatus("splash-install", `splash: installing ${tag}: ${installPhase(readLog())}`);
      } catch {}
    };
    const timer = setInterval(show, 1000);
    install = { stop: () => { live = false; clearInterval(timer); } };
    queueMicrotask(show);
    done.then(async (code) => {
      clearInterval(timer);
      releaseLock(lock);
      if (!live) return;
      install = null;
      const target = join(bin, "splash-m1");
      const check = existsSync(target) ? await checkLauncher(target) : { version: null, error: `${target} is missing` };
      try {
        ctx.ui.setStatus("splash-install", undefined);
        if (code === 0 && check.version === tag) {
          const lines = [`splash-m1 ${tag} ${update ? "updated" : "installed"} (${target}). Next: /splash start`];
          const used = launcher().path;
          if (used !== target) {
            const other = used ? (await checkLauncher(used)).version : null;
            if (other !== tag) lines.push(`Warning: /splash start will use ${used ?? "nothing"} (${other ?? "unknown version"}), ${config().launcher ? "\"launcher\" in ~/.pi/agent/splash/config.json" : "found first on PATH"}. Remove it or point "launcher" at ${target}.`);
          }
          ctx.ui.notify(lines.join("\n"), lines.length > 1 ? "error" : "info");
        } else {
          const cur = currentVersion();
          const state = cur === tag
            ? `The ${tag} files are in place, but ${target} --version ${check.error ? `failed: ${check.error}` : `reports ${check.version}`}.`
            : `Installed runtime unchanged (${cur ?? "none"}).`;
          ctx.ui.notify(`splash-m1 install failed: ${failureOf(readLog()) ?? `exit ${code}`}\n${state}\nLog: ${INSTALL_LOG}\nRetry: /splash ${update ? "update" : "install"}, or in a terminal: ${INSTALL["splash-m1"]}`, "error");
        }
      } catch {}
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    if ((await register(ctx, false)) || following) return;
    const p = port();
    const running = starting(p);
    if (running && startedByUs(p, running)) follow(p, running.pid, ownedModel(p), ctx);
  });

  pi.on("session_shutdown", async () => {
    closed = true;
    install?.stop();
    unfollow();
    bench?.abort.abort();
    await bench?.done;
  });

  const warming = new Set<string>();

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    const p = port();
    if (ctx.model?.provider !== providerName(p) || !opensSession(event.payload) || bench) return;
    const pid = readRecord(p)?.pid;
    const server = pid ? processId(pid) : null;
    if (!server) return;
    const key = headKey(event.payload);
    if (readWarmed(STATE_DIR, p, server).has(key) || warming.has(key)) return;
    const remember = () => {
      try {
        writeWarmed(STATE_DIR, p, server, readWarmed(STATE_DIR, p, server).add(key));
      } catch {}
    };
    const signal: AbortSignal | undefined = ctx.signal;
    const count = await countTokens(p, event.payload, process.env.SPLASH_API_KEY, signal);
    if (count === null || signal?.aborted) return;
    if (!needsWarm(count)) return remember();
    warming.add(key);
    try {
      ctx.ui.setStatus("splash", "splash: caching the system prompt for new sessions");
      if (await warm(p, event.payload, process.env.SPLASH_API_KEY, signal)) remember();
    } finally {
      warming.delete(key);
      if (!following) ctx.ui.setStatus("splash", undefined);
    }
  });

  pi.registerCommand("splash", {
    description: "Local Splash server: status, doctor, start [model], bench [--long | share], stop, use, log, install, update",
    getArgumentCompletions: (prefix: string) => {
      const start = /^\s*start(?:\s+(\S*))?$/.exec(prefix);
      if (start) {
        mac ??= detectMac();
        const items = startCompletions(start[1] ?? "", loadCatalog(), recommend(mac).pick, (m) => isDownloaded(m));
        return items.length ? items : null;
      }
      const items = ["doctor", "start", "bench", "bench --long", "bench share", "stop", "use", "log", "install", "update"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s === "start" ? "start " : s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      switch (cmd) {
        case undefined:
          return status(ctx);
        case "doctor":
          return ctx.ui.notify((await doctor()).join("\n"), "info");
        case "start":
          return startCmd(rest[0], ctx);
        case "bench": {
          if (rest.length === 1 && rest[0] === "share") return shareCmd(ctx);
          if (rest.length && !(rest.length === 1 && rest[0] === "--long")) return ctx.ui.notify("Usage: /splash bench [--long | share]", "error");
          if (bench) return ctx.ui.notify("A Splash bench is already running.", "info");
          const abort = new AbortController();
          bench = { abort, done: benchmark(rest[0] === "--long", ctx, abort.signal) };
          return;
        }
        case "stop":
          return stopCmd(ctx);
        case "use": {
          const r = await register(ctx, true);
          if (!r) return ctx.ui.notify(`No ready Splash server on port ${port()}.`, "error");
          if (r.switched) ctx.ui.notify(`Using Splash: ${r.served.id}, ${r.served.context.toLocaleString()} context tokens (back: /model)`, "info");
          return;
        }
        case "log": {
          let text = "";
          try {
            text = readFileSync(logPath(port()), "utf8").split("\n").slice(-30).join("\n");
          } catch {}
          return ctx.ui.notify(text || "No log yet.", "info");
        }
        case "install":
          return installCmd(false, ctx);
        case "update":
          return installCmd(true, ctx);
        default:
          return ctx.ui.notify(`Unknown: /splash ${cmd}`, "error");
      }
    },
  });
}
