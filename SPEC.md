# pi-splash-server: spec

A Pi package that runs a local [Splash](https://github.com/incoai/splash) server
from inside Pi and picks the model and flags for the Mac it runs on. On M1/M2 it
uses the [splash-m1](https://github.com/paperniuk/splash) fork, on M3 and newer
official Splash.

Status: draft, 2026-11-24.

## Why

- `splash-m1 pi` / `splash pi` already writes a correct Pi provider, but the
  server has to be started by hand in another terminal, with flags the user has
  to know (`--max-memory`, `--max-context`, `--language-only`).
- Which checkpoint fits and how close it stays to bf16 depends on the Mac.
  Splash suggests by memory tier only (`install/suggested-models.tsv`), and the
  splash-m1 README asks for reports from 16, 24 and 32 GB Macs.
- Pi already has this experience for llama.cpp (built-in `/llama`: load,
  unload, download, live state). Nothing does it for Splash. Existing packages:
  `@cltec/pi-splash-stats` (passive stats only), `@taoc/pi-mlx-models`
  (mlx-lm launcher), `@jmcombs/pi-omlx`.

## Non-goals

- No own inference, no fork of Splash or Pi. The package drives the installed
  `splash-m1` or `splash` launcher.
- No installing Splash itself in v1: the package tells the user the one-line
  install for their chip and checks it is there.
- No change to Pi's prompts, tools or compaction.

## Commands

All under one command, `/splash`, with argument completion.

| Command | Does |
| --- | --- |
| `/splash` | Status: runtime found, server phase, model, context, port, who started it. Offers the next action (start, stop, use). |
| `/splash doctor` | Chip, memory, free disk, runtime and version; the recommended model and flags with the evidence behind them; warnings (disk, memory, macOS version). Read-only. |
| `/splash start [model]` | Start a server in the background with the recommended or given model and flags, show its phases until ready, then register the provider and switch the session to it. |
| `/splash stop` | Stop the server. Asks first when the package did not start it. |
| `/splash use` | Register the running server as the provider and switch the session to it (for a server started outside Pi). |
| `/splash log` | Last lines of the server log the package wrote. |

## Mac detection (`src/mac.ts`)

- Chip: `sysctl -n machdep.cpu.brand_string` ("Apple M1 Pro"). Family = the
  number after M. M1/M2 -> runtime `splash-m1`, M3+ -> `splash`.
- Memory: `os.totalmem()` in GiB.
- Free disk: `statfs` of the home volume.
- macOS version: `sw_vers -productVersion` (splash-m1 needs 26.4+).

## Recommendation (`data/recommendations.json`)

Data, not code, so a new measurement is a JSON change. Each entry:
`minMemoryGB`, `runtimes`, `model`, `flags`, `weightsGB`, `evidence`
(`measured` with the Mac it was measured on, or `extrapolated`), `note`.
The pick is the entry with the highest `minMemoryGB` at or below the Mac's
memory for its runtime. Doctor prints the pick and the next tier down.

First table, Qwen3.8-27B (from docs/quants.md and the splash-m1 README):

| Memory | Model | Flags | Evidence |
| --- | --- | --- | --- |
| 64 GB+ | `unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_S` | none | closeness M1 Pro; speed M1 Pro, M2 Max |
| 36 GB+ | `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M` | none | closeness M1 Pro; speed M1 Pro, M2 Max |
| 32 GB | `mlx-community/Qwen3.8-27B-GPTQ-4bit` | `--language-only --max-context 64K --max-memory 21G` | measured M1 Pro 32 GB, Pi tasks 4/4 |
| 24 GB | `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF:IQ3_S` | `--language-only` | closeness measured; fit on 24 GB not verified |
| 16 GB | `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` | `--language-only`, needs `iogpu.wired_limit_mb` | splash-m1 README, capped run |

Numbers are refreshed when docs/quants.md is (1.7.1-m1 re-run in progress).

## Server lifecycle (`src/server.ts`)

- Launcher: `splash-m1` or `splash` on PATH, by chip. Missing -> doctor prints
  the install line (`curl ... install-m1.sh | sh` or
  `brew install incoai/tap/splash`).
- Start: `caffeinate -i <launcher> serve --model M <flags> --port P`, detached
  (own process group, `unref`), stdout/stderr to
  `~/.pi/agent/splash/serve-P.log`, rewritten on each start. `caffeinate -i` keeps the Mac from idle
  sleep while it serves (measured need: overnight runs). Never from the
  extension factory, only from a command (Pi rule for long-lived resources).
- Progress: poll `~/Library/Application Support/Splash/runtime/serve-P.json`
  (written by Splash: `starting`, `loading`, `warming {steps_done, steps}`,
  `ready`, `recovering`, `failed {failure}`) every second, show it with
  `ctx.ui.setStatus`, until `ready`, `failed` or process exit. First start on
  M1 Pro takes ~130 s (90 s ANE calibration), later ~45 s; model download
  first can take tens of minutes. While the record says `starting` (download,
  Hub check) the status shows the log's last line.
- Ownership: the package writes `~/.pi/agent/splash/owned-P.json` with the pid
  it started. It never stops a server it did not start without a confirm. The
  server outlives Pi by default (load is 45-130 s, several Pi sessions share
  it); setting `stopOnExit` (off) changes that.
- One server per port; a running Splash on the port is reused, not restarted.

## Provider (`src/provider.ts`)

Same model definition `install/clients.py _pi` writes, so a session started
with `splash-m1 pi` and one started here are interchangeable:

- name `splash` on port 8000, `splash-P` on another port;
- `baseUrl` `http://127.0.0.1:P/v1`, `api: openai-completions`, apiKey
  `$SPLASH_API_KEY` when set, else `local`;
- model from `GET /v1/models` (first entry, `owned_by: splash`): `id`,
  `contextWindow = context_length`, `input` from `input_modalities`,
  `reasoning: true`, `thinkingLevelMap: {off: "none"}`, `maxTokens 32768`;
- `compat.supportsMidConvoSystemMessages` when `GET /status`
  `chat_template.later_system` is `native` or `patched` (otherwise Pi folds
  later system messages into the first and the whole prompt is re-read).

1.7.1 lists `reasoning: {thinks, efforts: [low, medium, xhigh], default}` in
`/v1/models`; the server accepts every Pi level (none ... max, checked live),
so the map stays `{off: "none"}` as `clients.py` writes it.

Registered when the extension loads (async factory, so `--model splash/...`
and `--list-models` see it) and at `session_start` when a server answers, and again after
`/splash start`. Session switch with `pi.setModel`.

## Settings

`~/.pi/agent/splash/config.json`, all optional: `port` (8000), `model` and
`flags` (override the recommendation), `stopOnExit` (false), `keepAwake`
(true), `launcher` (path).

## Experiments, not in v1

- Head prewarm: Splash 1.7.1 keeps state at a shared prompt head only from the
  second repeat on (measured: a new session's first request misses, later ones
  hit at 0.6-0.8 s). Two 1-token requests with Pi's system prompt and tools
  right after ready would make the first real session hit. Saves ~9 s for Pi
  (1.5K-token head), ~60-80 s for omp (9.3K). Ship only if measured.
- Disk check for the SSD prompt cache: Splash keeps 10 GiB free and takes a
  quarter of the rest; with 16 GB free we got a 1.6 GiB cache. Doctor warns
  under ~25 GB free.
- omp plugin on the same core (separate thin package, omp's API differs).

## Tests

- Unit: chip parsing, tier pick, record parsing, provider definition against
  fixtures of `/v1/models` and `/status` saved from a real 1.7.1-m1 server.
- Manual on M1 Pro 32 GB: doctor, start from cold, start while running, use,
  stop (owned and not owned), Pi tasks from `pi_m1/run.sh`.

## Open questions

- Package name: `pi-splash` on npm is taken (a startup splash screen), working
  name `pi-splash-server`. Also free: `pi-splash-m1`, `pi-splash-local`.
- README headline needs Splash vs mlx-lm (pi-mlx-models) on the same Pi tasks
  on M1: not measured yet.
- Whether to ask splash-m1 / Inco to link it, after it works.
