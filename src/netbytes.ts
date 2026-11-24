import { execFileSync, spawn } from "node:child_process";

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

export function watchBytesIn(root: number, onTotal: (bytes: number) => void): () => void {
  let tree = descendants(root);
  let total = 0;
  const refresh = setInterval(() => (tree = descendants(root)), 1000);
  const nettop = spawn("/usr/bin/nettop", ["-P", "-d", "-L", "0", "-s", "1", "-x", "-J", "bytes_in"], { stdio: ["ignore", "pipe", "ignore"] });
  let rest = "";
  nettop.stdout.on("data", (chunk: Buffer) => {
    const lines = (rest + chunk.toString()).split("\n");
    rest = lines.pop() ?? "";
    let grew = false;
    for (const line of lines) {
      const s = parseSample(line);
      if (s && s.bytes > 0 && tree.has(s.pid)) {
        total += s.bytes;
        grew = true;
      }
    }
    if (grew) onTotal(total);
  });
  nettop.on("error", () => {});
  return () => {
    clearInterval(refresh);
    nettop.kill();
  };
}

export function progressText(done: number, total: number | null, rate: number): string {
  const speed = rate > 0 ? `, ${(rate / 1e6).toFixed(1)} MB/s` : "";
  if (!total) return `downloading ${(done / 1e9).toFixed(1)} GB${speed}`;
  const pct = Math.min(99, Math.floor((100 * done) / total));
  const eta = rate > 0 && done < total ? `, ~${Math.ceil((total - done) / rate / 60)} min left` : "";
  return `downloading ${(Math.min(done, total) / 1e9).toFixed(1)} / ${(total / 1e9).toFixed(1)} GB (${pct}%)${speed}${eta}`;
}

export function downloadProgress(root: number, total: number | null, onDisk: () => number = () => 0, windowS = 5) {
  const samples: [number, number][] = [];
  let done = 0;
  const stop = watchBytesIn(root, (b) => {
    done = Math.max(b, onDisk());
    samples.push([Date.now(), b]);
    while (samples.length > 1 && Date.now() - samples[0][0] > windowS * 1000) samples.shift();
  });
  const rate = () => {
    if (samples.length < 2) return 0;
    const [[t0, b0], [t1, b1]] = [samples[0], samples[samples.length - 1]];
    if (Date.now() - t1 > windowS * 1000) return 0;
    return t1 > t0 ? ((b1 - b0) * 1000) / (t1 - t0) : 0;
  };
  return { text: () => (done > 1e6 ? progressText(done, total, rate()) : null), stop };
}
