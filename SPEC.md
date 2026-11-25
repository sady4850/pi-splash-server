# pi-splash-server: spec

A Pi package that runs a local [Splash](https://github.com/incoai/splash) server
from inside Pi and picks the model and flags for the Mac it runs on. On M1/M2 it
uses the [splash-m1](https://github.com/paperniuk/splash) fork, on M3 and newer
official Splash.

Status: 0.1.0 in private testing, 2026-11-25.

Name: `pi-splash-server` (decided 2026-11-25). `pi-splash` on npm is a startup
splash screen for Pi (mavam/pi-splash), unrelated.

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
- No installing Splash itself: the package puts the one-line install for the
  chip into the editor and the user runs it.
- No change to Pi's prompts, tools or compaction.

## Commands

All under one command, `/splash`, with argument completion.

| Command | Does |
| --- | --- |
| `/splash` | Status: runtime found, server phase, model, context, port, who started it. Offers the next action (start, stop, use). |
| `/splash doctor` | Chip, memory, free disk, runtime and version (and whether a newer release is out); the recommended model and flags with the evidence behind them; what is left to download, file by file; warnings (disk, memory, macOS version). Read-only. |
| `/splash start [model]` | Start a server in the background with the recommended or given model and flags, show its phases until ready, then register the provider and switch the session to it. |
| `/splash stop` | Stop the server. Asks first when the package did not start it. |
| `/splash use` | Register the running server as the provider and switch the session to it (for a server started outside Pi). |
| `/splash log` | Last lines of the server log the package wrote. |
| `/splash install` | Puts the runtime's install command (`curl ... install-m1.sh \| sh` or `brew install incoai/tap/splash`) into the editor as a `!!` line (Pi runs it without sending output to the model). The user sees it and presses Enter; the package runs nothing itself. Says so when the runtime is already there. |
| `/splash update` | Same with the update command, when `releases/latest` differs from `<launcher> --version`. Reminds to restart a running server. |

## Mac detection (`src/mac.ts`)

- Chip: `sysctl -n machdep.cpu.brand_string` ("Apple M1 Pro"). Family = the
  number after M. M1/M2 -> runtime `splash-m1`, M3+ -> `splash`.
- Memory: `os.totalmem()` in GiB.
- Free disk: `statfs` of the home volume.
- macOS version: `sw_vers -productVersion` (splash-m1 needs 26.4+).

## Recommendation (`data/recommendations.json`)

Data, not code, so a new measurement is a JSON change. Each entry:
`minMemoryGB`, `runtimes`, `model`, `flags`, `weightsGB`, `draft` (the
DFlash2 repo Splash pairs with the family, `install/families.py`), `evidence`
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

## Download check (`src/download.ts`)

- Files Splash fetches, as `install/upstream.py` picks them: MLX repo -> root
  `*.safetensors`; GGUF `:VARIANT` -> the root file whose name ends in
  `-VARIANT` (or the `VARIANT/` folder of split parts), plus without
  `--language-only` the root `mmproj` projector, BF16 before F32 before F16
  (Splash reads the header; the name is close enough); the draft's
  `*.safetensors`.
- Sizes and blob IDs from `GET huggingface.co/api/models/R/tree/main?recursive=true`
  (5 s, one retry); a file counts as present when
  `~/.cache/huggingface/hub/models--R/blobs/<sha256>` has its size, so a broken
  download shows as missing. Hub unreachable -> say so, fall back to
  `weightsGB` + draft and the old "any safetensors/gguf" guess.
- Disk warnings use the bytes actually missing.
- The missing total is what start-up download progress will count against.

## Updates

Doctor reads the latest tag from the `releases/latest` redirect of
`paperniuk/splash` (splash-m1) or `incoai/splash` (no API rate limit) and,
when it differs from `<launcher> --version`, prints the update command. The
package still never installs Splash itself.

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
  first can take tens of minutes. While the record says `starting`, the status
  shows `downloading 6.8 / 17.5 GB (38%), 12.0 MB/s, ~15 min left` (total =
  the doctor plan's missing bytes; no total when the Hub is unreachable), or
  the log's last line before any bytes arrive. The status names what is
  missing, `model`, `draft` or `model + draft` (`downloading draft 0.4 / 3.9
  GB ...`), and the start notice names the repos: a model already on disk
  with a missing draft otherwise looks like the model downloading again.
- Download bytes come from `nettop -P -d -L 2 -s 1`, run once per tick
  (streaming `-L 0` block-buffers into a pipe: nothing for 12+ s), first
  sample absolute as the baseline, then 1 s deltas, summed over the server's
  process tree (the download runs in a
  grandchild, `install/models.py prepare`). Not from the HF cache: under Xet a
  blob stays at 0 bytes for minutes, then jumps (measured: 0 B on disk for
  40 s of a 270 MB download), and the log holds only tqdm's file count
  (`Fetching 1 files 0/1`), no byte bar, when stderr is a file.
- Xet sends chunks compressed, so network bytes undercount the file: 224 MB
  received for a 269 MB bf16 safetensors file (83%). Done is therefore
  max(network bytes, bytes of the missing blobs on disk), as Splash's own
  `_download_progress` does: low while a file assembles, exact once it lands;
  capped at 99% until the record leaves `starting`. Xet writes assembled
  ranges in jumps (268 -> 604 MB on disk while the network showed ~390 MB),
  so the amount can sit still for a minute; speed and ETA come from network
  bytes alone and move every second.
- `/splash start` returns at once: Pi gives a command no abort signal
  (`ctx.signal` is undefined outside streaming) and runs nothing else until
  it returns, so a start that waited for a download blocked Pi for its whole
  length. A background follower (one per port) plans the download, shows
  progress with `ctx.ui.setStatus`, registers and switches on ready; it stops
  on `/splash stop` and `session_shutdown`.
- `/splash start` while a server is already starting (record alive, not
  ready) follows it instead of spawning a second one.
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
- Resumable download: a broken download restarts from zero. huggingface_hub
  1.28 (in splash-m1 1.7.1-m1) writes each file to a per-process
  `<blob>.<uuid>.incomplete` and deletes it on failure; the Xet cache keeps
  no chunks. Measured: the DFlash2 draft (3.85 GB) on a direct route at
  ~0.8 MB/s took ~65 min, the day before the same route broke after 15 min
  and lost it all. Doctor could warn when the ETA is long and offer a
  resumable fetch (`curl -C -` of the resolve URL into the blob path).
- omp plugin on the same core (separate thin package, omp's API differs).

## Tests

- Unit: chip parsing, tier pick, record parsing, provider definition against
  fixtures of `/v1/models` and `/status` saved from a real 1.7.1-m1 server.
- Manual on M1 Pro 32 GB: doctor, start from cold, start while running, use,
  stop (owned and not owned), Pi print-mode tasks on a small repo: a cold first
  session, a new session on a warm server, a `-c` follow-up that edits a file,
  a new session after a server restart.
  Passed 2026-11-25 on splash-m1 1.7.3-m1, installed from the git repo.

## Open questions

- README headline needs Splash vs mlx-lm (pi-mlx-models) on the same Pi tasks
  on M1: not measured yet.
- Whether to ask splash-m1 / Inco to link it, after it works.
