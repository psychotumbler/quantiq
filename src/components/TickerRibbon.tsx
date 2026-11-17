"use client";

import type { MarketQuote } from "@/services/market";
import { formatChange, formatLevel, toneClass } from "@/components/ui/primitives";

function Item({ quote }: { quote: MarketQuote }) {
  const up = (quote.change ?? 0) > 0;
  const down = (quote.change ?? 0) < 0;
  return (
    <span className="flex shrink-0 items-baseline gap-2 px-5">
      <span className="text-[11px] font-semibold tracking-wider text-gray-400">
        {quote.label}
      </span>
      <span className="font-mono text-sm text-white">
        {formatLevel(quote.price)}
        {quote.unit === "%" ? "%" : ""}
      </span>
      <span className={`font-mono text-xs ${toneClass(quote.change)}`}>
        {up ? "▲" : down ? "▼" : ""} {formatChange(quote.changePercent)}
      </span>
    </span>
  );
}

/**
 * The scrolling market ribbon. The list is rendered twice so the CSS
 * animation can loop seamlessly; the copy is hidden from assistive tech.
 * Hovering pauses it, and reduced-motion users get a static scrollable row.
 */
export function TickerRibbon({
  quotes,
  sampleData,
}: {
  quotes: MarketQuote[];
  sampleData: boolean;
}) {
  const items = quotes.filter((q) => q.ribbon && q.price !== null);

  return (
    <div className="flex h-9 items-center border-b border-gray-800 bg-black">
      <span
        className={`z-10 flex h-full shrink-0 items-center px-3 text-[11px] font-bold tracking-widest ${
          sampleData ? "bg-amber-500 text-black" : "bg-emerald-500 text-black"
        }`}
      >
        {sampleData ? "SAMPLE" : "MARKETS"}
      </span>
      {items.length === 0 ? (
        <span className="px-4 text-xs text-gray-500">
          Market data unavailable right now.
        </span>
      ) : (
        <div className="ribbon-viewport relative flex-1 overflow-hidden">
          <div className="ribbon-track flex w-max items-center">
            <div className="flex items-center">
              {items.map((q) => (
                <Item key={q.symbol} quote={q} />
              ))}
            </div>
            <div className="flex items-center" aria-hidden="true">
              {items.map((q) => (
                <Item key={`${q.symbol}-copy`} quote={q} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
