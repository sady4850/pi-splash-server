# pi-splash-server

Run a local [Splash](https://github.com/incoai/splash) server from inside
[Pi](https://pi.dev), with the model and flags picked for your Mac. On M1/M2 it
drives [splash-m1](https://github.com/paperniuk/splash), on M3 and newer
official Splash.

![Pi fixing a bug with Qwen3.8-27B served by Splash on an M1 Pro](https://raw.githubusercontent.com/sady4850/pi-splash-server/main/media/screenshot.png)

Splash itself already writes a Pi provider (`splash-m1 pi`), but the server has
to be started by hand with flags you have to know. This package starts it in
the background, shows download and load progress in Pi's status bar, and
switches the session to it when it is ready.

## Against plain mlx-lm

Ten Pi tasks over a small repository (explain it, find a script, edit the
README, new sessions, `-c` follow-ups, server restarts), one run each, on an
M1 Pro 32 GB with the same weights, `mlx-community/Qwen3.8-27B-GPTQ-4bit`,
thinking on. Splash is splash-m1 1.7.3-m1 started by this package, with its
DFlash2 draft; mlx-lm is `mlx_lm.server` 0.32.2 started the way
`@taoc/pi-mlx-models` starts it, with no draft. All answers were right on both.

| | Splash | mlx-lm |
|---|---|---|
| Decode | 24.5 tok/s | 9.3 tok/s |
| Prompt processing | 91-166 tok/s | 48-55 tok/s |
| All ten tasks, Pi wall time | 329 s | 1,057 s |
| First task on a cold server, start included | 125 s | 418 s |
| First token of a new session on a running server | 0.7-0.8 s | 0.6-1.0 s |
| Server start until the first token | ~62 s | ~35 s |

mlx-lm answers at once and loads the model on the first request; Splash loads,
warms up and checks its Neural Engine split before it says ready, then wins
from the first task on. The draft model is a large part of the decode gap and
exists only on the Splash side.

## Requirements

- Apple silicon Mac. M1/M2 need macOS 26.4 or newer (splash-m1).
- The Splash runtime. `/splash install` puts the install command for your
  chip into Pi's editor as a `!!` shell line; you see it and press Enter:
  - M1/M2: `curl -fsSL https://github.com/paperniuk/splash/releases/latest/download/install-m1.sh | sh`
  - M3 and newer: `brew install incoai/tap/splash`
- Disk for the model: 11-23 GB depending on the tier (weights plus a 3.9 GB
  draft model), and some more for Splash's SSD prompt cache (~25 GB free is
  comfortable).

## Install

```bash
pi install npm:pi-splash-server
```

Update with `pi update`. To try it without installing:
`pi -e npm:pi-splash-server`.

## Use

In Pi:

```text
/splash doctor     chip, memory, disk, runtime, recommended model and flags, what is left to download
/splash start      start the recommended model in the background and switch to it
/splash            status and the next step
/splash use        switch to a Splash server started outside Pi
/splash stop       stop the server
/splash log        last lines of the server log
/splash install    put the runtime's install command into the editor
/splash update     same for a newer runtime release
```

`start` and `use` switch the session to the Splash model; `/model` switches
back, the server keeps running. The first start downloads the model (the
status bar shows what, how much and how fast). Loading takes about one to two
minutes; the first start also calibrates the Neural Engine on M1/M2. The
server outlives Pi, so the next Pi session finds it ready.

The first session on a server sends one extra one-token request with Pi's
system prompt and tools before its own. Splash keeps a state where that
request ends, so every later new session starts from it: its first token
comes in about 1 s instead of about 10 s on an M1 Pro. Splash 1.7.3 would not
keep such a state for a system prompt and tools under 2,048 tokens, as Pi's
are, unless the first message is a few words long.

## What it picks

Qwen3.8-27B, by memory:

| Memory | Model | Flags |
| --- | --- | --- |
| 64 GB+ | `unsloth/Qwen3.8-27B-GGUF:UD-Q5_K_S` | |
| 36 GB+ | `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_M` | |
| 32 GB | `mlx-community/Qwen3.8-27B-GPTQ-4bit` | `--language-only --max-context 64K --max-memory 21G` |
| 24 GB | `ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF:IQ3_S` | `--language-only` |
| 16 GB | `prism-ml/Ternary-Bonsai-2-27B-gguf:PQ2_0` | `--language-only` |

`/splash doctor` shows the evidence for each pick (measured on which Mac, or
not yet). The table lives in `data/recommendations.json`; reports from 16, 24
and 64 GB Macs are welcome.

## Settings

All optional, in `~/.pi/agent/splash/config.json`:

| Key | Default | |
| --- | --- | --- |
| `port` | `8000` | Server port. The provider is `splash`, or `splash-<port>` on another port. |
| `model` | recommended | Model to start, e.g. `mlx-community/Qwen3.8-27B-GPTQ-4bit` or `repo:VARIANT` for GGUF. |
| `flags` | recommended | Extra `serve` flags, replacing the recommended ones. |
| `stopOnExit` | `false` | Stop the server when Pi exits. |
| `keepAwake` | `true` | Keep the Mac from idle sleep while the server runs (`caffeinate -i`). |
| `launcher` | on PATH | Path to `splash-m1` or `splash`. |

## omp

The extension also loads in [omp](https://github.com/can1357/oh-my-pi):
`omp plugin install pi-splash-server`. If your omp config already has a
provider named `splash`, rename it: the extension registers its own `splash`.

## License

MIT
