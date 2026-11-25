import { execFile, execFileSync } from "node:child_process";

export function descendants(root: number, table = processTable()): Set<number> {
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

function processTable(): [number, number][] {
  try {
    return execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number) as [number, number]);
  } catch {
    return [];
  }
}

export function parseSample(line: string): { pid: number; bytes: number } | null {
  const m = /\.(\d+),(\d+),?$/.exec(line.trim());
  return m ? { pid: Number(m[1]), bytes: Number(m[2]) } : null;
}

export function samples(output: string): string[][] {
  const out: string[][] = [];
  for (const line of output.split("\n")) {
    if (line.trim() === ",bytes_in,") out.push([]);
    else if (out.length && line.trim()) out[out.length - 1].push(line);
  }
  return out;
}

export function watchBytesIn(root: number, onTotal: (bytes: number) => void): () => void {
  let total = 0;
  let first = true;
  let stopped = false;
  (async () => {
    while (!stopped) {
      const tree = descendants(root);
      const out = await new Promise<string>((resolve) =>
        execFile("/usr/bin/nettop", ["-P", "-d", "-L", "2", "-s", "1", "-x", "-J", "bytes_in"], { timeout: 10000 }, (_e, stdout) => resolve(stdout ?? "")),
      );
      if (!out) await new Promise((r) => setTimeout(r, 1000));
      const taken = samples(out);
      for (const sample of first ? taken : taken.slice(-1)) {
        for (const line of sample) {
          const s = parseSample(line);
          if (s && s.bytes > 0 && tree.has(s.pid)) total += s.bytes;
        }
      }
      if (taken.length) first = false;
      if (!stopped) onTotal(total);
    }
  })();
  return () => {
    stopped = true;
  };
}

export function progressText(done: number, total: number | null, rate: number, label = ""): string {
  const speed = rate > 0 ? `, ${(rate / 1e6).toFixed(1)} MB/s` : "";
  const what = label ? `downloading ${label}` : "downloading";
  if (!total) return `${what} ${(done / 1e9).toFixed(1)} GB${speed}`;
  const pct = Math.min(99, Math.floor((100 * done) / total));
  const eta = rate > 0 && done < total ? `, ~${Math.ceil((total - done) / rate / 60)} min left` : "";
  return `${what} ${(Math.min(done, total) / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB (${pct}%)${speed}${eta}`;
}

export function downloadProgress(root: number, total: number | null, onDisk: () => number = () => 0, label = "", windowS = 5) {
  const samples: [number, number][] = [];
  let net = 0;
  let seen = false;
  const stop = watchBytesIn(root, (b) => {
    net = b;
    seen = true;
  });
  const text = () => {
    const now = Date.now();
    if (seen) samples.push([now, net]);
    while (samples.length > 2 && now - samples[0][0] > windowS * 1000) samples.shift();
    const [[t0, b0], [t1, b1]] = [samples[0] ?? [now, 0], samples[samples.length - 1] ?? [now, 0]];
    const rate = t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
    const done = Math.max(net, onDisk());
    return done > 1e6 ? progressText(done, total, rate, label) : null;
  };
  return { text, stop };
}
