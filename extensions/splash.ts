import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectMac, macosWarning, runtimeFor } from "../src/mac.ts";
import { DRAFT_GB, loadEntries, recommend, diskWarnings, isDownloaded } from "../src/recommend.ts";
import { bytes, bytesOnDisk, downloadLabel, downloadLines, downloadNotice, gb, planDownload } from "../src/download.ts";
import { downloadProgress } from "../src/netbytes.ts";
import { providerConfig, providerName } from "../src/provider.ts";
import {
  DEFAULT_PORT, STATE_DIR, describe, findLauncher, latestRelease, launcherVersion, logPath, probe, readRecord,
  start, startedByUs, stop, versionOf, waitReady,
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

  async function register(ctx: any, switchTo: boolean) {
    const p = port();
    const served = await probe(p);
    if (!served) return null;
    pi.registerProvider(providerName(p), providerConfig(p, served) as any);
    if (switchTo) {
      const model = ctx.modelRegistry.find(providerName(p), served.id);
      if (model && !(await pi.setModel(model))) ctx.ui.notify("Could not switch to the Splash model", "error");
    }
    return served;
  }

  function launcher(): { name: string; path: string | null } {
    const c = config();
    const name = runtimeFor(detectMac().family) ?? "splash";
    return { name, path: c.launcher ?? findLauncher(name) };
  }

  async function doctor(): Promise<string[]> {
    const mac = detectMac();
    const { runtime, pick, smaller } = recommend(mac);
    const l = launcher();
    const installed = l.path ? versionOf(launcherVersion(l.path)) : null;
    const [latest, plan] = await Promise.all([
      l.path ? latestRelease(l.name) : Promise.resolve(null),
      pick ? planDownload(pick.model, pick.draft, pick.flags.includes("--language-only")).catch((e: Error) => e) : Promise.resolve(null),
    ]);
    const lines = [
      `${mac.chip}, ${mac.memoryGB} GB, macOS ${mac.macos}, ${mac.freeDiskGB.toFixed(1)} GB free`,
      !l.path
        ? `Runtime: ${runtime ?? "none"} not installed. Install: /splash install`
        : `Runtime: ${l.name} ${installed ?? "?"}${latest === installed ? ", latest" : ""} (${l.path})`,
    ];
    if (l.path && latest && latest !== installed) lines.push(`  ${latest} is out. Update: /splash update`);
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
    if (served && ctx.model?.provider !== providerName(p)) lines.push("Switch to it: /splash use");
    else if (!served && (phase === "not running" || phase.startsWith("failed"))) lines.push("Start one: /splash start");
    else if (served && record && startedByUs(p, record)) lines.push("Stop it: /splash stop");
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function startCmd(model: string | undefined, ctx: any) {
    const p = port();
    if (await probe(p)) {
      await register(ctx, true);
      ctx.ui.notify(`Splash already serves on port ${p}; using it.`, "info");
      return;
    }
    if (following) {
      ctx.ui.notify(`Already following the start on port ${p}: ${describe(readRecord(p))}.`, "info");
      return;
    }
    const running = readRecord(p);
    const phase = describe(running);
    if (running && phase !== "not running" && !phase.startsWith("failed")) {
      ctx.ui.notify(`Splash is already starting on port ${p} (${phase}); following it in the status bar.`, "info");
      follow(p, running.pid, ownedModel(p), ctx);
      return;
    }
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
    const flags = c.flags ?? (chosen === pick?.model ? pick.flags : []);
    const pid = start({ launcher: l.path, model: chosen, flags, port: p, keepAwake: c.keepAwake ?? true, stopWithPid: c.stopOnExit ? process.pid : undefined });
    ctx.ui.notify(`Starting ${[chosen, ...flags].join(" ")}. Progress in the status bar; Pi stays usable. Log: ${logPath(p)}`, "info");
    follow(p, pid, chosen, ctx, flags);
  }

  function ownedModel(p: number): string | undefined {
    try {
      return JSON.parse(readFileSync(join(STATE_DIR, `owned-${p}.json`), "utf8")).model;
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
        const draft = loadEntries().find((e) => e.model === model)?.draft;
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
        const served = await register(ctx, true);
        ctx.ui.notify(`Splash ready: ${served?.id}, ${served?.context.toLocaleString()} context tokens (back: /model)`, "info");
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

  async function stopCmd(ctx: any) {
    const p = port();
    const record = readRecord(p);
    if (!record || describe(record) === "not running") {
      ctx.ui.notify("No Splash server running.", "info");
      return;
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

  async function installCmd(update: boolean, ctx: any) {
    const runtime = runtimeFor(detectMac().family);
    if (!runtime) {
      ctx.ui.notify("Splash runs on Apple silicon only.", "error");
      return;
    }
    const l = launcher();
    if (!l.path) return offer(INSTALL[runtime], `Install ${runtime}`, ctx);
    const installed = versionOf(launcherVersion(l.path));
    if (!update) {
      ctx.ui.notify(`${l.name} ${installed ?? "?"} is installed (${l.path}). Newer release: /splash update`, "info");
      return;
    }
    const latest = await latestRelease(l.name);
    if (latest && latest === installed) {
      ctx.ui.notify(`${l.name} ${installed} is the latest release.`, "info");
      return;
    }
    const running = await probe(port());
    offer(UPDATE[l.name as keyof typeof UPDATE], `Update ${l.name} ${installed ?? "?"} to ${latest ?? "the latest release"}${running ? "; restart the server afterwards (/splash stop, /splash start)" : ""}`, ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    await register(ctx, false);
  });

  pi.on("session_shutdown", async () => unfollow());

  pi.registerCommand("splash", {
    description: "Local Splash server: status, doctor, start [model], stop, use, log, install, update",
    getArgumentCompletions: (prefix: string) => {
      const items = ["doctor", "start", "stop", "use", "log", "install", "update"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
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
        case "stop":
          return stopCmd(ctx);
        case "use": {
          const served = await register(ctx, true);
          return ctx.ui.notify(served ? `Using ${served.id} (back: /model)` : `No ready Splash server on port ${port()}.`, served ? "info" : "error");
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
