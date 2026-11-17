"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";

const EVENT = "quantiq-storage";

function subscribe(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EVENT, callback);
  };
}

/**
 * State persisted in `localStorage` and shared across components and tabs.
 *
 * Built on `useSyncExternalStore` so the server render and first client
 * render agree (both see `initial`) and the stored value arrives without a
 * setState-in-effect. Storage failures (private mode, quota) degrade to
 * in-memory behaviour for the session rather than throwing.
 */
export function useLocalStorage<T>(
  key: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    () => null,
  );

  const value = useMemo<T>(() => {
    if (raw === null) return initial;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return initial;
    }
    // `initial` is a constant per call site; keying on it would re-parse on
    // every render when callers pass a literal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw]);

  const setValue = useCallback(
    (next: T | ((previous: T) => T)) => {
      try {
        const stored = window.localStorage.getItem(key);
        const previous = stored === null ? initial : (JSON.parse(stored) as T);
        const resolved =
          typeof next === "function" ? (next as (p: T) => T)(previous) : next;
        window.localStorage.setItem(key, JSON.stringify(resolved));
        window.dispatchEvent(new Event(EVENT));
      } catch {
        // Nothing to do: the value simply does not persist.
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [value, setValue];
}
