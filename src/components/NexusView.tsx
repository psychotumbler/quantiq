"use client";

/**
 * News Nexus — today's news as a map of themes, companies and deals.
 *
 * Three ways in:
 *   - the web: every active theme as a hub, the companies its headlines name
 *     around it, and companies named under several themes drawn between them;
 *   - a theme close-up: the companies named in its news, the curated list of
 *     companies that operate in it, and the second-order chain;
 *   - the deal tracker: order wins, acquisitions and fundraises, largest
 *     stated amount first, with the company's own exchange filings flagged.
 */

import { useEffect, useMemo, useState } from "react";
import type { APIResponse } from "@/types/stock";
import type { NexusRouteData } from "@/app/api/nexus/route";
import type { NexusCompany, NexusHeadline, NexusTheme } from "@/services/newsNexus";
import { useLocalStorage } from "@/lib/useLocalStorage";
import { DEFAULT_WATCHLIST } from "@/components/DashboardView";
import { Panel, SampleBadge, toneClass } from "@/components/ui/primitives";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const THEME_COLORS = [
  "#34d399", "#60a5fa", "#fbbf24", "#f472b6", "#a78bfa", "#fb923c",
  "#22d3ee", "#a3e635", "#f87171", "#e879f9", "#2dd4bf", "#facc15", "#94a3b8",
];

function toneFill(tone: number | null): string {
  if (tone === null) return "#64748b";
  if (tone > 0.15) return "#34d399";
  if (tone < -0.15) return "#f87171";
  return "#fbbf24";
}

function toneWord(tone: number | null): string {
  if (tone === null) return "no tone read";
  if (tone > 0.15) return "positive";
  if (tone < -0.15) return "negative";
  return "mixed";
}

function ago(iso: string): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function shortName(name: string): string {
  return name
    .replace(/\s*\b(limited|ltd\.?|incorporated|inc\.?|corporation|corp\.?|company|co\.?)\b\.?/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every company the payload knows about, by symbol. */
function companyIndex(data: NexusRouteData): Map<string, NexusCompany> {
  const index = new Map<string, NexusCompany>();
  for (const theme of data.themes) {
    for (const company of [...theme.companies, ...theme.exposure]) {
      const existing = index.get(company.symbol);
      if (!existing || company.mentions > existing.mentions) index.set(company.symbol, company);
    }
  }
  return index;
}

/* ------------------------------------------------------------------ */
/* Graph layout                                                        */
/* ------------------------------------------------------------------ */

interface GraphNode {
  id: string;
  kind: "theme" | "company" | "exposure";
  label: string;
  x: number;
  y: number;
  r: number;
  fill: string;
  stroke?: string;
  symbol?: string;
  themeId?: string;
  detail: string;
}

interface GraphEdge {
  from: string;
  to: string;
  color: string;
  dashed?: boolean;
  weight: number;
}

const W = 900;
const H = 620;
const CX = W / 2;
const CY = H / 2;

/** All themes as hubs on a ring; named companies around them. */
function layoutWeb(themes: NexusTheme[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const hubs = themes.slice(0, 10);
  const hubRadius = hubs.length <= 1 ? 0 : 215;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const hubPos = new Map<string, { x: number; y: number; color: string }>();

  hubs.forEach((theme, i) => {
    const angle = (i / hubs.length) * Math.PI * 2 - Math.PI / 2;
    const x = CX + Math.cos(angle) * hubRadius;
    const y = CY + Math.sin(angle) * hubRadius;
    const color = THEME_COLORS[i % THEME_COLORS.length];
    hubPos.set(theme.id, { x, y, color });
    nodes.push({
      id: `t:${theme.id}`, kind: "theme", label: theme.label, x, y,
      r: 16 + Math.min(18, Math.sqrt(theme.count) * 3), fill: color,
      themeId: theme.id,
      detail: `${theme.count} headlines · ${theme.companies.length} companies named · tone ${toneWord(theme.tone)}`,
    });
  });

  // Each company once, attached to every theme that names it.
  const companyThemes = new Map<string, { company: NexusCompany; themes: string[] }>();
  for (const theme of hubs) {
    for (const company of theme.companies.slice(0, 7)) {
      const entry = companyThemes.get(company.symbol) ?? { company, themes: [] };
      entry.themes.push(theme.id);
      if (company.mentions > entry.company.mentions) entry.company = company;
      companyThemes.set(company.symbol, entry);
    }
  }

  const perHub = new Map<string, number>();
  for (const { company, themes: ids } of companyThemes.values()) {
    let x: number;
    let y: number;
    if (ids.length > 1) {
      // Between its hubs, pulled slightly to the centre so it reads as a bridge.
      x = ids.reduce((acc, id) => acc + hubPos.get(id)!.x, 0) / ids.length;
      y = ids.reduce((acc, id) => acc + hubPos.get(id)!.y, 0) / ids.length;
      x = CX + (x - CX) * 0.8;
      y = CY + (y - CY) * 0.8;
    } else {
      const hub = hubPos.get(ids[0])!;
      const k = perHub.get(ids[0]) ?? 0;
      perHub.set(ids[0], k + 1);
      // Fan out away from the centre.
      const outward = Math.atan2(hub.y - CY, hub.x - CX);
      const spread = (k - 3) * 0.42;
      const dist = 78 + (k % 2) * 26;
      x = hub.x + Math.cos(outward + spread) * dist;
      y = hub.y + Math.sin(outward + spread) * dist;
    }
    x = Math.max(24, Math.min(W - 24, x));
    y = Math.max(20, Math.min(H - 20, y));
    nodes.push({
      id: `c:${company.symbol}`, kind: "company", label: shortName(company.name),
      x, y, r: 5 + Math.min(10, Math.sqrt(company.mentions) * 3), fill: toneFill(company.tone),
      symbol: company.symbol,
      detail: `${company.symbol} · named in ${company.mentions} headline${company.mentions === 1 ? "" : "s"} · ${toneWord(company.tone)}`,
    });
    for (const id of ids) {
      edges.push({ from: `t:${id}`, to: `c:${company.symbol}`, color: hubPos.get(id)!.color, weight: Math.min(3, 0.8 + company.mentions * 0.4) });
    }
  }
  return { nodes, edges };
}

/** One theme: named companies on the inner ring, curated exposure outside. */
function layoutTheme(theme: NexusTheme, color: string): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{
    id: `t:${theme.id}`, kind: "theme", label: theme.label, x: CX, y: CY, r: 40, fill: color,
    themeId: theme.id, detail: `${theme.count} headlines`,
  }];
  const edges: GraphEdge[] = [];
  const named = theme.companies.slice(0, 14);
  named.forEach((company, i) => {
    const angle = (i / Math.max(1, named.length)) * Math.PI * 2 - Math.PI / 2;
    const id = `c:${company.symbol}`;
    nodes.push({
      id, kind: "company", label: shortName(company.name),
      x: CX + Math.cos(angle) * 165, y: CY + Math.sin(angle) * 150,
      r: 7 + Math.min(12, Math.sqrt(company.mentions) * 4), fill: toneFill(company.tone),
      symbol: company.symbol,
      detail: `${company.symbol} · named in ${company.mentions} headline${company.mentions === 1 ? "" : "s"} · ${toneWord(company.tone)}`,
    });
    edges.push({ from: `t:${theme.id}`, to: id, color, weight: 1 + company.mentions * 0.5 });
  });
  const exposure = theme.exposure.slice(0, 12);
  exposure.forEach((company, i) => {
    const angle = ((i + 0.5) / Math.max(1, exposure.length)) * Math.PI * 2 - Math.PI / 2;
    const id = `e:${company.symbol}`;
    nodes.push({
      id, kind: "exposure", label: shortName(company.name),
      x: CX + Math.cos(angle) * 300, y: CY + Math.sin(angle) * 255,
      r: 6, fill: "#0b1220", stroke: "#64748b", symbol: company.symbol,
      detail: `${company.symbol} · operates in this theme; not named in today's news`,
    });
    edges.push({ from: `t:${theme.id}`, to: id, color: "#334155", dashed: true, weight: 1 });
  });
  return { nodes, edges };
}

function NetworkGraph({
  nodes,
  edges,
  selected,
  onTheme,
  onCompany,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string | null;
  onTheme: (id: string) => void;
  onCompany: (symbol: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const focus = hover ?? (selected ? `c:${selected}` : null);
  const linked = new Set<string>();
  if (focus) {
    linked.add(focus);
    for (const e of edges) {
      if (e.from === focus) linked.add(e.to);
      if (e.to === focus) linked.add(e.from);
    }
  }
  const hovered = hover ? byId.get(hover) : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="img"
        aria-label="Network of news themes and the companies named in them"
      >
        <defs>
          <radialGradient id="nexus-bg" cx="50%" cy="50%" r="60%">
            <stop offset="0%" stopColor="#0f1d2e" />
            <stop offset="100%" stopColor="#030712" />
          </radialGradient>
        </defs>
        <rect width={W} height={H} fill="url(#nexus-bg)" rx="12" />
        {edges.map((e, i) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const dim = focus !== null && !(linked.has(e.from) && linked.has(e.to));
          return (
            <line
              key={i}
              x1={a.x} y1={a.y} x2={b.x} y2={b.y}
              stroke={e.color}
              strokeWidth={e.weight}
              strokeDasharray={e.dashed ? "4 5" : undefined}
              opacity={dim ? 0.08 : 0.55}
            />
          );
        })}
        {nodes.map((n) => {
          const dim = focus !== null && !linked.has(n.id);
          const isTheme = n.kind === "theme";
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              opacity={dim ? 0.25 : 1}
              className="cursor-pointer"
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => (isTheme ? onTheme(n.themeId!) : onCompany(n.symbol!))}
            >
              {isTheme && <circle r={n.r + 8} fill={n.fill} opacity={0.12} />}
              <circle
                r={n.r}
                fill={n.fill}
                stroke={n.stroke ?? (isTheme ? "#030712" : "#0b1220")}
                strokeWidth={n.kind === "exposure" ? 1.5 : 2}
                strokeDasharray={n.kind === "exposure" ? "2 2" : undefined}
              />
              <text
                y={n.r + (isTheme ? 16 : 12)}
                textAnchor="middle"
                fontSize={isTheme ? 12.5 : 10}
                fontWeight={isTheme ? 700 : 500}
                fill={isTheme ? n.fill : n.kind === "exposure" ? "#64748b" : "#cbd5e1"}
                stroke="#030712"
                strokeWidth={3}
                paintOrder="stroke"
                style={{ pointerEvents: "none" }}
              >
                {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-xs rounded-lg border border-gray-700 bg-gray-950/95 px-3 py-2 text-xs shadow-xl">
          <p className="font-semibold text-gray-100">{hovered.label}</p>
          <p className="mt-0.5 text-gray-400">{hovered.detail}</p>
          <p className="mt-1 text-gray-500">Click to {hovered.kind === "theme" ? "open this theme" : "see its headlines"}</p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panels                                                              */
/* ------------------------------------------------------------------ */

function CompanyChip({
  symbol,
  name,
  onClick,
}: {
  symbol: string;
  name?: string;
  onClick: (symbol: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(symbol)}
      className="rounded border border-gray-700 bg-gray-950 px-1.5 py-0.5 font-mono text-[11px] text-emerald-300 hover:border-emerald-500"
      title={name}
    >
      {symbol.replace(/\.NS$/, "")}
    </button>
  );
}

function HeadlineRow({
  h,
  names,
  onCompany,
}: {
  h: NexusHeadline;
  names: Map<string, NexusCompany>;
  onCompany: (symbol: string) => void;
}) {
  return (
    <li className="py-3">
      <div className="flex gap-3">
        <span
          className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: toneFill(h.sentiment) }}
          title={`Tone: ${toneWord(h.sentiment)}`}
        />
        <div className="min-w-0 flex-1">
          <a
            href={h.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm leading-snug text-gray-100 hover:text-emerald-300"
          >
            {h.title}
          </a>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
            {h.official ? (
              <span className="rounded bg-sky-500/15 px-1.5 py-0.5 font-medium text-sky-300">
                Exchange filing
              </span>
            ) : (
              <span>{h.source}</span>
            )}
            <span>· {ago(h.publishedAt)}</span>
            {h.deal && (
              <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-300">
                {h.deal.kind}
                {h.deal.amount ? ` · ${h.deal.amount}` : ""}
              </span>
            )}
            {h.companies.slice(0, 5).map((s) => (
              <CompanyChip key={s} symbol={s} name={names.get(s)?.name} onClick={onCompany} />
            ))}
          </div>
        </div>
      </div>
    </li>
  );
}

function DealTracker({
  deals,
  names,
  onCompany,
}: {
  deals: NexusHeadline[];
  names: Map<string, NexusCompany>;
  onCompany: (symbol: string) => void;
}) {
  const [kind, setKind] = useState<string>("All");
  const [officialOnly, setOfficialOnly] = useState(false);
  const kinds = ["All", ...new Set(deals.map((d) => d.deal!.kind))];
  const shown = deals.filter(
    (d) => (kind === "All" || d.deal!.kind === kind) && (!officialOnly || d.official),
  );

  return (
    <Panel
      title="Deal tracker"
      subtitle="Orders, contracts, acquisitions and fundraises reported in the last few days, largest stated amount first. Amounts are as written in the headline; many deals state none."
      action={
        <label className="flex items-center gap-2 text-xs text-gray-400">
          <input
            type="checkbox"
            checked={officialOnly}
            onChange={(e) => setOfficialOnly(e.target.checked)}
            className="accent-sky-500"
          />
          Exchange filings only
        </label>
      }
    >
      <div className="mb-3 flex flex-wrap gap-2">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`rounded-full border px-3 py-1 text-xs ${
              kind === k
                ? "border-amber-400 bg-amber-400/10 text-amber-200"
                : "border-gray-700 text-gray-400 hover:text-gray-200"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-sm text-gray-500">No deals match this filter.</p>
      ) : (
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                <th className="px-2 py-2 font-medium">Company</th>
                <th className="px-2 py-2 font-medium">Deal</th>
                <th className="px-2 py-2 text-right font-medium">Amount</th>
                <th className="px-2 py-2 font-medium">Source</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800/60">
              {shown.map((d, i) => (
                <tr key={`${d.url}-${i}`} className="align-top hover:bg-gray-800/30">
                  <td className="px-2 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {d.companies.length === 0 ? (
                        <span className="text-xs text-gray-600">not identified</span>
                      ) : (
                        d.companies.slice(0, 3).map((s) => (
                          <CompanyChip key={s} symbol={s} name={names.get(s)?.name} onClick={onCompany} />
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-2 py-2.5">
                    <a
                      href={d.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-gray-200 hover:text-emerald-300"
                    >
                      {d.title}
                    </a>
                    <span className="text-xs text-gray-500">{d.deal!.kind}</span>
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-right font-mono text-amber-200">
                    {d.deal!.amount ?? <span className="text-gray-600">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-2 py-2.5 text-xs text-gray-500">
                    {d.official ? <span className="text-sky-300">NSE filing</span> : d.source}
                    <span className="block">{ago(d.publishedAt)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export function NexusView({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [data, setData] = useState<NexusRouteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeId, setThemeId] = useState<string | null>(null);
  const [company, setCompany] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [, setWatchlist] = useLocalStorage<string[]>("quantiq.watchlist", DEFAULT_WATCHLIST);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/nexus", { signal: controller.signal });
        const body: APIResponse<NexusRouteData> = await res.json();
        if (body.success) setData(body.data);
        else setError(body.error);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Could not reach the News Nexus API.");
      }
    })();
    return () => controller.abort();
  }, []);

  const names = useMemo(() => (data ? companyIndex(data) : new Map<string, NexusCompany>()), [data]);
  const theme = data?.themes.find((t) => t.id === themeId) ?? null;
  const themeColor = theme ? THEME_COLORS[(data?.themes.indexOf(theme) ?? 0) % THEME_COLORS.length] : "#34d399";

  const graph = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    return theme ? layoutTheme(theme, themeColor) : layoutWeb(data.themes);
  }, [data, theme, themeColor]);

  if (error) {
    return <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</p>;
  }
  if (!data) {
    return (
      <div className="space-y-4">
        <div className="h-24 animate-pulse rounded-xl bg-gray-900" />
        <div className="h-[520px] animate-pulse rounded-xl bg-gray-900" />
        <p className="text-center text-sm text-gray-500">Reading the news and the exchange filings…</p>
      </div>
    );
  }

  const allHeadlines = data.themes.flatMap((t) => t.headlines);
  const uniqueHeadlines = [...new Map(allHeadlines.map((h) => [h.url + h.title, h])).values()];
  const pool = theme ? theme.headlines : uniqueHeadlines.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const q = query.trim().toLowerCase();
  const visible = pool.filter(
    (h) =>
      (!company || h.companies.includes(company)) &&
      (!q || h.title.toLowerCase().includes(q) || h.companies.some((s) => s.toLowerCase().includes(q))),
  );
  const selectedCompany = company ? names.get(company) : null;
  const officialCount = data.deals.filter((d) => d.official).length;

  return (
    <div className="space-y-6">
      {/* Masthead */}
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 via-gray-900 to-emerald-950/40 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white">
              News <span className="text-emerald-400">Nexus</span>
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-400">
              Today&apos;s business news and exchange filings, sorted into themes and linked to the
              listed companies they name. Click a theme to open it, a company to see what is being
              said about it.
            </p>
          </div>
          {data.sampleData && <SampleBadge />}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Headlines read", data.headlineCount],
            ["Active themes", data.themes.length],
            ["Deals spotted", data.deals.length],
            ["From exchange filings", officialCount],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border border-gray-800 bg-gray-950/60 px-3 py-2">
              <p className="text-[11px] uppercase tracking-wider text-gray-500">{label}</p>
              <p className="font-mono text-xl font-semibold text-white">{value}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-gray-500">
          Sources: {data.sources.map((s) => `${s.name} (${s.count})`).join(" · ")}
        </p>
      </section>

      {/* Theme strip */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => { setThemeId(null); setCompany(null); }}
          className={`shrink-0 rounded-xl border px-4 py-3 text-left ${
            themeId === null ? "border-emerald-500 bg-emerald-500/10" : "border-gray-800 bg-gray-900 hover:border-gray-600"
          }`}
        >
          <p className="text-sm font-semibold text-white">All themes</p>
          <p className="text-xs text-gray-500">The full web</p>
        </button>
        {data.themes.map((t, i) => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setThemeId(t.id); setCompany(null); }}
            className={`min-w-40 shrink-0 rounded-xl border px-4 py-3 text-left transition ${
              themeId === t.id ? "bg-gray-800" : "border-gray-800 bg-gray-900 hover:border-gray-600"
            }`}
            style={themeId === t.id ? { borderColor: THEME_COLORS[i % THEME_COLORS.length] } : undefined}
          >
            <p className="flex items-center gap-2 text-sm font-semibold text-white">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: THEME_COLORS[i % THEME_COLORS.length] }} />
              {t.label}
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {t.count} headlines · {t.companies.length} cos ·{" "}
              <span className={toneClass(t.tone)}>{toneWord(t.tone)}</span>
            </p>
          </button>
        ))}
      </div>

      {data.themes.length === 0 ? (
        <p className="rounded-xl border border-dashed border-gray-800 p-8 text-center text-sm text-gray-500">
          No headlines could be read right now. The feeds may be unreachable; try again in a few minutes.
        </p>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
          <Panel
            title={theme ? `${theme.label} — who is in the news` : "The web"}
            subtitle={
              theme
                ? "Inner ring: companies named in this theme's headlines (size = mentions, colour = tone). Dashed outer ring: companies that operate in the theme but were not named today."
                : "Each hub is a theme; around it, the companies its headlines name. A company drawn between hubs is named under more than one theme."
            }
          >
            <NetworkGraph
              nodes={graph.nodes}
              edges={graph.edges}
              selected={company}
              onTheme={(id) => { setThemeId(id === themeId ? null : id); setCompany(null); }}
              onCompany={(s) => setCompany(s === company ? null : s)}
            />
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-gray-500">
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" /> positive tone</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-amber-400" /> mixed</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-red-400" /> negative</span>
              <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-slate-500" /> no tone read</span>
              <span>Tone is a finance word list, not a language model.</span>
            </div>
          </Panel>

          <div className="space-y-6">
            {selectedCompany ? (
              <Panel
                title={shortName(selectedCompany.name)}
                subtitle={`${selectedCompany.symbol}${selectedCompany.industry ? ` · ${selectedCompany.industry}` : ""}`}
                action={
                  <button type="button" onClick={() => setCompany(null)} className="text-xs text-gray-500 hover:text-gray-200">
                    Clear ×
                  </button>
                }
              >
                <p className="text-sm text-gray-300">
                  {selectedCompany.mentions > 0
                    ? `Named in ${selectedCompany.mentions} headline${selectedCompany.mentions === 1 ? "" : "s"}${theme ? " in this theme" : ""}; tone ${toneWord(selectedCompany.tone)}.`
                    : "Not named in today's news — listed because it operates in this theme."}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onAnalyze(selectedCompany.symbol)}
                    className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-gray-950 hover:bg-emerald-400"
                  >
                    Full analysis →
                  </button>
                  <button
                    type="button"
                    onClick={() => setWatchlist((list) => (list.includes(selectedCompany.symbol) ? list : [...list, selectedCompany.symbol]))}
                    className="rounded-md border border-gray-700 px-3 py-1.5 text-sm text-gray-200 hover:border-emerald-500"
                  >
                    + Watchlist
                  </button>
                </div>
              </Panel>
            ) : theme ? (
              <Panel title="Second-order map" subtitle="Who else a theme like this tends to touch. Background industry knowledge, not something today's news proved.">
                {theme.chain.length === 0 ? (
                  <p className="text-sm text-gray-500">No chain is defined for this theme.</p>
                ) : (
                  <ol className="relative space-y-4 border-l border-gray-800 pl-5">
                    {theme.chain.map((link, i) => (
                      <li key={link.stage}>
                        <span
                          className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 border-gray-900"
                          style={{ backgroundColor: themeColor, opacity: 1 - i * 0.15 }}
                        />
                        <p className="text-sm font-semibold text-gray-100">{link.stage}</p>
                        <p className="text-xs text-gray-500">{link.why}</p>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {link.examples.map((ex) => (
                            <CompanyChip key={ex.symbol} symbol={ex.symbol} name={ex.name} onClick={onAnalyze} />
                          ))}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            ) : (
              <Panel title="Most-named companies" subtitle="Across every theme today">
                <ol className="space-y-2">
                  {[...names.values()]
                    .filter((c) => c.mentions > 0)
                    .sort((a, b) => b.mentions - a.mentions)
                    .slice(0, 10)
                    .map((c, i) => (
                      <li key={c.symbol} className="flex items-center gap-3">
                        <span className="w-5 font-mono text-xs text-gray-600">{i + 1}</span>
                        <button type="button" onClick={() => setCompany(c.symbol)} className="min-w-0 flex-1 truncate text-left text-sm text-gray-200 hover:text-emerald-300">
                          {shortName(c.name)}
                        </button>
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: toneFill(c.tone) }} />
                        <span className="w-8 text-right font-mono text-xs text-gray-400">{c.mentions}</span>
                      </li>
                    ))}
                </ol>
              </Panel>
            )}

            {theme && (
              <Panel title="Companies in this theme" subtitle="Named today, then curated exposure">
                <div className="flex flex-wrap gap-1.5">
                  {theme.companies.map((c) => (
                    <CompanyChip key={c.symbol} symbol={c.symbol} name={c.name} onClick={setCompany} />
                  ))}
                </div>
                {theme.exposure.length > 0 && (
                  <>
                    <p className="mt-4 text-xs uppercase tracking-wider text-gray-600">Not named today</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5 opacity-70">
                      {theme.exposure.map((c) => (
                        <CompanyChip key={c.symbol} symbol={c.symbol} name={c.name} onClick={setCompany} />
                      ))}
                    </div>
                  </>
                )}
              </Panel>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_1.15fr]">
        <Panel
          title={
            company
              ? `Headlines naming ${shortName(names.get(company)?.name ?? company)}`
              : theme
                ? `${theme.label} headlines`
                : "Latest headlines"
          }
          subtitle={`${visible.length} shown`}
          action={
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter headlines"
              className="w-32 rounded-md border border-gray-700 bg-gray-950 px-2 py-1 text-sm text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500"
            />
          }
        >
          {visible.length === 0 ? (
            <p className="text-sm text-gray-500">Nothing matches.</p>
          ) : (
            <ul className="max-h-[560px] divide-y divide-gray-800/60 overflow-auto pr-1">
              {visible.slice(0, 60).map((h, i) => (
                <HeadlineRow key={`${h.url}-${i}`} h={h} names={names} onCompany={setCompany} />
              ))}
            </ul>
          )}
        </Panel>

        <DealTracker
          deals={theme ? theme.deals : data.deals}
          names={names}
          onCompany={(s) => setCompany(s)}
        />
      </div>

      <p className="text-xs text-gray-600">
        How this works: headlines are matched to themes by keyword and to companies by name;
        deal sizes are read from the headline text. It reports what the news says, not whether
        a company will benefit — always open the source before acting on anything here.
      </p>
    </div>
  );
}
