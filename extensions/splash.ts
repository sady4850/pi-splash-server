import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { detectMac, runtimeFor } from "../src/mac.ts";
import { recommend, diskWarnings, isDownloaded } from "../src/recommend.ts";
import { providerConfig, providerName } from "../src/provider.ts";
import {
  DEFAULT_PORT, STATE_DIR, describe, findLauncher, launcherVersion, logPath, probe, readRecord,
  start, startedByUs, stop, waitReady,
} from "../src/server.ts";

type Config = { port?: number; model?: string; flags?: string[]; stopOnExit?: boolean; keepAwake?: boolean; launcher?: string };

const INSTALL = {
  "splash-m1": "curl -fsSL https://github.com/paperniuk/splash/releases/latest/download/install-m1.sh | sh",
  splash: "brew install incoai/tap/splash",
};

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

  function doctor(): string[] {
    const mac = detectMac();
    const { runtime, pick, smaller } = recommend(mac);
    const l = launcher();
    const lines = [
      `${mac.chip}, ${mac.memoryGB} GB, macOS ${mac.macos}, ${mac.freeDiskGB.toFixed(1)} GB free`,
      l.path ? `Runtime: ${l.name} ${launcherVersion(l.path)} (${l.path})` : `Runtime: ${runtime ?? "none"} not installed. Install: ${INSTALL[(runtime ?? "splash") as keyof typeof INSTALL]}`,
    ];
    if (!pick) lines.push("No measured model fits this Mac yet.");
    else {
      lines.push(`Recommended: ${pick.model} ${pick.flags.join(" ")}`.trim());
      lines.push(`  ${pick.note}`, `  Evidence: ${pick.evidence}`);
      lines.push(isDownloaded(pick.model) ? "  Already downloaded." : `  Download: ${pick.weightsGB} GB + draft.`);
      if (smaller) lines.push(`Smaller: ${smaller.model} (${smaller.weightsGB} GB)`);
    }
    for (const w of diskWarnings(mac, pick, pick ? isDownloaded(pick.model) : false)) lines.push(`Warning: ${w}`);
    return lines;
  }

  async function status(ctx: any) {
    const p = port();
    const record = readRecord(p);
    const served = await probe(p);
    const lines = [`Port ${p}: ${describe(record)}${record && startedByUs(p, record) ? " (started by pi-splash)" : ""}`];
    if (served) lines.push(`Model ${served.id}, ${served.context.toLocaleString()} context tokens`);
    ctx.ui.notify(lines.join("\n"), "info");
  }

  async function startCmd(model: string | undefined, ctx: any) {
    const p = port();
    if (await probe(p)) {
      await register(ctx, true);
      ctx.ui.notify(`Splash already serves on port ${p}; using it.`, "info");
      return;
    }
    const l = launcher();
    if (!l.path) {
      ctx.ui.notify(doctor().join("\n"), "error");
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
    start({ launcher: l.path, model: chosen, flags, port: p, keepAwake: c.keepAwake ?? true, stopWithPid: c.stopOnExit ? process.pid : undefined });
    ctx.ui.notify(`Starting ${chosen} ${flags.join(" ")}. Log: ${logPath(p)}`, "info");
    const record = await waitReady(p, ctx.signal ?? new AbortController().signal, (t) => ctx.ui.setStatus("splash", `splash: ${t}`));
    ctx.ui.setStatus("splash", undefined);
    if (record?.phase === "ready") {
      const served = await register(ctx, true);
      ctx.ui.notify(`Splash ready: ${served?.id}, ${served?.context.toLocaleString()} context tokens`, "info");
    } else {
      ctx.ui.notify(`Splash did not start: ${describe(record)}. Log: ${logPath(p)}`, "error");
    }
  }

  async function stopCmd(ctx: any) {
    const p = port();
    const record = readRecord(p);
    if (!record || describe(record) === "not running") {
      ctx.ui.notify("No Splash server running.", "info");
      return;
    }
    if (!startedByUs(p, record) && !(await ctx.ui.confirm("Stop Splash?", `The server on port ${p} was not started by pi-splash.`))) return;
    ctx.ui.notify((await stop(p, record)) ? "Splash stopped." : "Splash did not stop within 60 s.", "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    await register(ctx, false);
  });

  pi.registerCommand("splash", {
    description: "Local Splash server: status, doctor, start [model], stop, use, log",
    getArgumentCompletions: (prefix: string) => {
      const items = ["doctor", "start", "stop", "use", "log"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s }));
      return items.length ? items : null;
    },
    handler: async (args: string, ctx: any) => {
      const [cmd, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
      switch (cmd) {
        case undefined:
          return status(ctx);
        case "doctor":
          return ctx.ui.notify(doctor().join("\n"), "info");
        case "start":
          return startCmd(rest[0], ctx);
        case "stop":
          return stopCmd(ctx);
        case "use": {
          const served = await register(ctx, true);
          return ctx.ui.notify(served ? `Using ${served.id}` : `No ready Splash server on port ${port()}.`, served ? "info" : "error");
        }
        case "log": {
          let text = "";
          try {
            text = readFileSync(logPath(port()), "utf8").split("\n").slice(-30).join("\n");
          } catch {}
          return ctx.ui.notify(text || "No log yet.", "info");
        }
        default:
          return ctx.ui.notify(`Unknown: /splash ${cmd}`, "error");
      }
    },
  });
}
