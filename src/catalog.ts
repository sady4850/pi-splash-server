import { readFileSync } from "node:fs";
import type { Entry } from "./recommend.ts";

export type CatalogModel = {
  family: string; quant: string; model: string; weightsGB: number;
  klWiki?: number; klChat?: number; decodePct?: number; needs?: string; draft?: string;
};

export function loadCatalog(): CatalogModel[] {
  return JSON.parse(readFileSync(new URL("../data/models.json", import.meta.url), "utf8")).models;
}

const signed = (n: number, unit: string) => `${n > 0 ? "+" : "-"}${Math.abs(n).toFixed(unit === "%" ? 0 : 1)}${unit}`;

function kl(m: CatalogModel, base: CatalogModel | undefined) {
  if (m.klWiki == null || m.klChat == null) return "bf16 closeness not measured";
  if (!base || base.klWiki == null || base.klChat == null) return `KL wiki ${m.klWiki}, chat ${m.klChat}`;
  const change = (a: number, b: number) => {
    if (a / b >= 2) return `×${(a / b).toFixed(1)}`;
    const pct = Math.round((a / b - 1) * 100);
    return pct ? signed(pct, "%") : "same";
  };
  return `KL wiki ${change(m.klWiki, base.klWiki)}, chat ${change(m.klChat, base.klChat)}`;
}

function decode(m: CatalogModel, base: CatalogModel | undefined) {
  if (m.decodePct == null || !base || base.decodePct == null) return null;
  const pct = Math.round(((1 + m.decodePct / 100) / (1 + base.decodePct / 100) - 1) * 100);
  if (Math.abs(pct) < 2) return "decode same";
  return `decode ${Math.abs(pct)}% ${pct > 0 ? "slower" : "faster"}`;
}

export function startCompletions(query: string, catalog: CatalogModel[], pick: Entry | null, downloaded: (model: string) => boolean) {
  const q = query.trim().toLowerCase();
  const base = catalog.find((m) => m.model === pick?.model);
  const family = base?.family ?? catalog[0]?.family;
  const rank = (m: CatalogModel) => (m === base ? [0, 0] : m.family !== family ? [3, m.weightsGB]
    : base && m.weightsGB > base.weightsGB ? [1, m.weightsGB] : [2, -m.weightsGB]);
  return catalog
    .filter((m) => `${m.model} ${m.family} ${m.quant}`.toLowerCase().includes(q))
    .sort((a, b) => rank(a)[0] - rank(b)[0] || a.family.localeCompare(b.family) || rank(a)[1] - rank(b)[1])
    .map((m) => {
      const parts = m === base
        ? ["recommended", downloaded(m.model) ? "downloaded" : "needs download", `${m.weightsGB.toFixed(1)} GB`, "others compared to this", m.needs]
        : [downloaded(m.model) ? "downloaded" : "needs download",
           !base ? `${m.weightsGB.toFixed(1)} GB` : Math.abs(m.weightsGB - base.weightsGB) < 0.05 ? "same size" : signed(m.weightsGB - base.weightsGB, " GB"),
           kl(m, base), decode(m, base), m.needs];
      return { value: `start ${m.model}`, label: `${m.family} · ${m.quant}`, description: parts.filter(Boolean).join(" · ") };
    });
}
