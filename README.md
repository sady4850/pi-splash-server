# pi-splash-server

Run a local [Splash](https://github.com/incoai/splash) server from inside
[Pi](https://pi.dev), with the model and flags picked for your Mac. On M1/M2 it
drives [splash-m1](https://github.com/paperniuk/splash), on M3 and newer
official Splash.

Draft. See [SPEC.md](SPEC.md).

```bash
pi install /path/to/pi-splash
```

In Pi:

```text
/splash doctor     chip, memory, disk, runtime, recommended model and flags
/splash start      start the recommended model in the background and switch to it
/splash            status
/splash use        use a server started outside Pi
/splash stop       stop it
/splash log        last lines of the server log
```

Settings, all optional, in `~/.pi/agent/splash/config.json`:
`port`, `model`, `flags`, `stopOnExit`, `keepAwake`, `launcher`.
