"use client";

/**
 * News Intelligence.
 *
 * The ordering principle is materiality, not recency. A feed sorted by time
 * tells you what happened most recently; this tells you what matters most,
 * which is the only ordering a decision can use.
 *
 * Every number on this screen is traceable. Click into a story and it shows
 * the trigger phrase that classified it, the name that matched, and the
 * reasons the score landed where it did - because a signal you cannot
 * interrogate is one you should not act on.
 */

import { useEffect, useMemo, useState } from "react";
import type { APIResponse } from "@/types/stock";
import type { IntelRouteData } from "@/app/api/intel/route";
import type { ArticleUnderstanding } from "@/nlp/understand";
import { Panel, SampleBadge, Tile, toneClass } from "@/components/ui/primitives";

const EVENT_COLORS: Record<string, string> = {
  "order-win": "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  "order-cancel": "bg-rose-500/15 text-rose-300 border-rose-500/30",
  "m&a": "bg-violet-500/15 text-violet-300 border-violet-500/30",
  "approval": "bg-sky-500/15 text-sky-300 border-sky-500/30",
  "enforcement": "bg-red-500/15 text-red-300 border-red-500/30",
  "legal": "bg-red-500/15 text-red-300 border-red-500/30",
  "fundraise": "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "earnings": "bg-blue-500/15 text-blue-300 border-blue-500/30",
  "expansion": "bg-teal-500/15 text-teal-300 border-teal-500/30",
  "policy": "bg-indigo-500/15 text-indigo-300 border-indigo-500/30",
};
const chip = (t?: string) => EVENT_COLORS[t ?? ""] ?? "bg-gray-700/40 text-gray-300 border-gray-600/40";

const dirTone = (d: string) => d === "positive" ? "text-emerald-400" : d === "negative" ? "text-red-400" : "text-gray-400";
const dirArrow = (d: string) => d === "positive" ? "▲" : d === "negative" ? "▼" : "•";

function money(usdM: number): string {
  return usdM >= 1000 ? `$${(usdM / 1000).toFixed(usdM >= 10000 ? 0 : 1)}bn` : `$${usdM.toFixed(usdM < 10 ? 1 : 0)}m`;
}

function ScoreDot({ score }: { score: number }) {
  const color = score >= 65 ? "bg-emerald-500" : score >= 35 ? "bg-amber-500" : "bg-gray-600";
  return (
    <div className="flex shrink-0 flex-col items-center gap-1">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg ${color}/15 border ${color.replace("bg-", "border-")}/40`}>
        <span className="font-mono text-sm font-bold text-gray-100">{score}</span>
      </div>
    </div>
  );
}

function StoryCard({ a, onAnalyze }: { a: ArticleUnderstanding; onAnalyze: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  const subjects = a.implications.filter((i) => i.relation === "subject");
  const peers = a.implications.filter((i) => i.relation === "sector-peer");

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/60 p-4 transition hover:border-gray-700">
      <div className="flex gap-3">
        <ScoreDot score={a.materiality.score} />
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
            {a.event && (
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chip(a.event.type)}`}>
                {a.event.label}
              </span>
            )}
            {a.amount && !a.amount.isValuation && (
              <span className="rounded border border-gray-600/40 bg-gray-700/40 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-gray-200">
                {money(a.amount.usdMillion)}
              </span>
            )}
            {a.isRoundup && (
              <span className="rounded border border-gray-600/40 px-1.5 py-0.5 text-[10px] text-gray-500">round-up</span>
            )}
            <span className="text-[10px] text-gray-500">{a.source}</span>
          </div>

          <a href={a.url} target="_blank" rel="noopener noreferrer"
             className="block text-sm font-medium leading-snug text-gray-100 hover:text-emerald-300">
            {a.title}
          </a>

          <p className="mt-1.5 text-xs leading-relaxed text-gray-400">{a.summary}</p>

          {(subjects.length > 0 || peers.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {subjects.map((i) => (
                <button key={i.symbol} type="button" onClick={() => onAnalyze(i.symbol)}
                  className="flex items-center gap-1 rounded-full border border-gray-700 bg-gray-950 px-2 py-0.5 text-xs hover:border-emerald-500">
                  <span className={dirTone(i.direction)}>{dirArrow(i.direction)}</span>
                  <span className="font-mono font-semibold text-gray-100">{i.symbol.replace(/\.NS$/, "")}</span>
                </button>
              ))}
              {peers.slice(0, 4).map((i) => (
                <button key={i.symbol} type="button" onClick={() => onAnalyze(i.symbol)}
                  title={i.why}
                  className="flex items-center gap-1 rounded-full border border-dashed border-gray-700 px-2 py-0.5 text-xs text-gray-500 hover:border-gray-500">
                  <span className={dirTone(i.direction)}>{dirArrow(i.direction)}</span>
                  <span className="font-mono">{i.symbol.replace(/\.NS$/, "")}</span>
                </button>
              ))}
            </div>
          )}

          <button type="button" onClick={() => setOpen(!open)}
            className="mt-2 text-[11px] text-gray-500 hover:text-gray-300">
            {open ? "hide reasoning" : "why this score?"}
          </button>

          {open && (
            <div className="mt-2 space-y-2 rounded-lg border border-gray-800 bg-gray-950/60 p-3 text-xs">
              <div>
                <span className="text-gray-500">Score drivers</span>
                <ul className="mt-1 space-y-0.5">
                  {a.materiality.drivers.map((d, i) => (
                    <li key={i} className="text-gray-300">· {d}</li>
                  ))}
                </ul>
              </div>
              {a.event && (
                <div>
                  <span className="text-gray-500">Classified by</span>
                  <p className="mt-0.5 font-mono text-[11px] text-amber-300">&ldquo;{a.event.trigger}&rdquo;</p>
                </div>
              )}
              {peers.length > 0 && (
                <div>
                  <span className="text-gray-500">Read-across</span>
                  <p className="mt-0.5 text-gray-400">{peers[0].why}</p>
                </div>
              )}
              {a.primary.length > 0 && (
                <div>
                  <span className="text-gray-500">Matched as</span>
                  <p className="mt-0.5 text-gray-400">
                    {a.primary.map((p) => `${p.matchedAs} → ${p.symbol} (salience ${p.salience})`).join(" · ")}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function IntelView({ onAnalyze }: { onAnalyze: (symbol: string) => void }) {
  const [data, setData] = useState<IntelRouteData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [eventFilter, setEventFilter] = useState<string>("all");
  const [minScore, setMinScore] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/intel", { signal: controller.signal });
        const body: APIResponse<IntelRouteData> = await res.json();
        if (body.success) { setData(body.data); setError(null); }
        else setError(body.error);
      } catch (e) {
        if ((e as Error).name !== "AbortError") setError("Could not reach the intelligence API.");
      } finally { setLoading(false); }
    })();
    return () => controller.abort();
  }, []);

  const eventTypes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of data?.articles ?? []) {
      if (a.event) counts.set(a.event.type, (counts.get(a.event.type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const visible = useMemo(() => {
    let list = data?.articles ?? [];
    if (eventFilter !== "all") list = list.filter((a) => a.event?.type === eventFilter);
    if (minScore > 0) list = list.filter((a) => a.materiality.score >= minScore);
    return list.slice(0, 60);
  }, [data, eventFilter, minScore]);

  const s = data?.stats;

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-xl border border-gray-800 bg-gradient-to-br from-gray-900 via-gray-900 to-emerald-950/30 p-5">
        <h1 className="text-2xl font-bold tracking-tight text-white">
          News <span className="text-emerald-400">Intelligence</span>
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-400">
          Every source, read and ranked by how much it matters — not by what happened most recently.
          Each story is resolved to the listed companies it actually affects, with the event, the amount
          and the reasoning shown.
        </p>
        {data?.sampleData && <div className="mt-3"><SampleBadge /></div>}
        {s && (
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Tile label="Headlines scanned" value={s.rawHeadlines.toLocaleString()} sub={`${s.uniqueHeadlines.toLocaleString()} unique`} />
            <Tile label="Events found" value={s.withEvent.toLocaleString()} />
            <Tile label="Linked to companies" value={s.withCompany.toLocaleString()} />
            <Tile label="High materiality" value={s.highMateriality.toLocaleString()} tone={1} />
            <Tile label="Sources live" value={`${s.feedsOk}/${s.feedsTried}`} sub={`${(s.elapsedMs / 1000).toFixed(1)}s sweep`} />
          </div>
        )}
      </section>

      {error && <p className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">{error}</p>}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-28 animate-pulse rounded-xl bg-gray-900" />)}
        </div>
      ) : (
        <>
          {(data?.sectors.length ?? 0) > 0 && (
            <Panel title="Sector pulse" subtitle="Where today's material news is concentrated.">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {data!.sectors.slice(0, 8).map((sec) => (
                  <div key={sec.sector} className="rounded-lg border border-gray-800 bg-gray-950 p-3">
                    <p className="truncate text-xs font-medium text-gray-200">{sec.sector}</p>
                    <p className="mt-1 font-mono text-lg text-gray-100">{sec.articles}</p>
                    <p className="text-[10px] text-gray-500">{sec.highMateriality} material</p>
                    {sec.topEvent && <p className="mt-1 truncate text-[10px] text-gray-500">{sec.topEvent}</p>}
                    <p className={`text-[10px] ${toneClass(sec.netDirection)}`}>
                      {sec.netDirection > 0 ? "net positive" : sec.netDirection < 0 ? "net negative" : "mixed"}
                    </p>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          <Panel
            title="What matters right now"
            subtitle="Ranked by materiality: event weight, deal size against company size, source trust and how clearly one company is the subject."
          >
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => setEventFilter("all")}
                className={`rounded-md border px-2.5 py-1 text-xs ${eventFilter === "all" ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-gray-700 text-gray-400"}`}>
                All
              </button>
              {eventTypes.slice(0, 7).map(([t, n]) => (
                <button key={t} type="button" onClick={() => setEventFilter(t)}
                  className={`rounded-md border px-2.5 py-1 text-xs ${eventFilter === t ? "border-emerald-500 bg-emerald-500/10 text-emerald-300" : "border-gray-700 text-gray-400"}`}>
                  {t} <span className="text-gray-600">{n}</span>
                </button>
              ))}
              <label className="ml-auto flex items-center gap-2 text-xs text-gray-500">
                min score
                <input type="range" min={0} max={80} step={10} value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))} className="w-24 accent-emerald-500" />
                <span className="w-6 font-mono text-gray-300">{minScore}</span>
              </label>
            </div>

            <div className="space-y-3">
              {visible.length === 0 ? (
                <p className="py-8 text-center text-sm text-gray-500">Nothing matches that filter.</p>
              ) : (
                visible.map((a) => <StoryCard key={a.id} a={a} onAnalyze={onAnalyze} />)
              )}
            </div>
          </Panel>

          {(data?.companies.length ?? 0) > 0 && (
            <Panel title="Companies in the news" subtitle="Ranked by the most material story each is the subject of.">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wider text-gray-500">
                      <th className="px-2 py-2 font-medium">Company</th>
                      <th className="px-2 py-2 font-medium">Sector</th>
                      <th className="px-2 py-2 text-right font-medium">Stories</th>
                      <th className="px-2 py-2 text-right font-medium">Top score</th>
                      <th className="px-2 py-2 text-right font-medium">Tone</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800/60">
                    {data!.companies.slice(0, 20).map((c) => (
                      <tr key={c.symbol} className="hover:bg-gray-800/30">
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => onAnalyze(c.symbol)}
                            className="font-mono font-semibold text-emerald-400 hover:underline">
                            {c.symbol.replace(/\.NS$/, "")}
                          </button>
                          <span className="block max-w-[220px] truncate text-xs text-gray-500">{c.name}</span>
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-400">{c.industry || "—"}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-300">{c.articles}</td>
                        <td className="px-2 py-2 text-right font-mono text-gray-100">{c.topMateriality}</td>
                        <td className={`px-2 py-2 text-right font-mono ${toneClass(c.netDirection)}`}>
                          {c.netDirection > 0 ? "+" : ""}{c.netDirection.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <p className="text-xs text-gray-600">
            Event labels come from trigger phrases, company links from name resolution with a salience
            test, and amounts from the text — all of it shown per story under &ldquo;why this score?&rdquo;.
            Read-across to sector peers is inferred from shared industry classification, not from a
            supply-chain graph, so treat it as a prompt to look rather than a conclusion. Nothing here
            is a recommendation.
          </p>
        </>
      )}
    </div>
  );
}
