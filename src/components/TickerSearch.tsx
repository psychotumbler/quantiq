"use client";

/**
 * Reusable ticker search box with a live autocomplete dropdown — the same
 * `/api/search` suggestions the Analyze tab uses, so adding a stock feels the
 * same everywhere (Portfolio, Algo). It owns the dropdown; the parent owns the
 * text (`value`/`onChange`) and decides what a pick means (`onPick`).
 */

import { useEffect, useRef, useState } from "react";
import type { APIResponse, SearchResult } from "@/types/stock";

export function TickerSearch({
  value,
  onChange,
  onPick,
  onEnter,
  placeholder = "Search a ticker — AAPL, RELIANCE.NS…",
  inputClassName,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  /** A suggestion was chosen. */
  onPick: (result: SearchResult) => void;
  /** Enter pressed with no dropdown selection (e.g. a bare typed ticker). */
  onEnter?: () => void;
  placeholder?: string;
  inputClassName?: string;
  className?: string;
}) {
  const [suggestions, setSuggestions] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounced autocomplete.
  useEffect(() => {
    const term = value.trim();
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      if (!term) {
        setSuggestions([]);
        setOpen(false);
        return;
      }
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: controller.signal });
        const body: APIResponse<SearchResult[]> = await res.json();
        if (body.success) {
          setSuggestions(body.data);
          setOpen(body.data.length > 0);
        }
      } catch {
        // Mid-keystroke abort or failure — not worth surfacing.
      }
    }, term ? 250 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  // Close on outside click.
  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const pick = (r: SearchResult) => {
    onPick(r);
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className={`relative ${className ?? ""}`}>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setOpen(suggestions.length > 0)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          if (open && suggestions[0]) {
            e.preventDefault();
            pick(suggestions[0]);
          } else if (onEnter) {
            e.preventDefault();
            onEnter();
          }
          // else: let a surrounding form handle Enter naturally.
        }}
        placeholder={placeholder}
        aria-label="Search for a ticker"
        autoComplete="off"
        className={inputClassName}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-40 mt-1 max-h-72 w-full min-w-[15rem] overflow-auto rounded-xl border border-gray-800 bg-gray-900 py-1 shadow-2xl shadow-black/50">
          {suggestions.map((r) => (
            <li key={`${r.symbol}-${r.exchange}`}>
              <button
                type="button"
                onClick={() => pick(r)}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition hover:bg-gray-800"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="font-mono text-sm font-semibold text-emerald-400">{r.symbol}</span>
                  <span className="truncate text-xs text-gray-300">{r.name}</span>
                </span>
                <span className="shrink-0 text-xs text-gray-500">{r.exchange}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
