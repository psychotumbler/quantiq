/**
 * Data-source registry — the single place the app resolves a market-data
 * source. Import `getProvider()` rather than a vendor module directly.
 */

import type { DataProvider, ProviderId } from "@/services/provider";
import { yahooProvider } from "@/services/yahooFinance";
import { fixtureProvider } from "@/services/fixtureProvider";
import { finnhubConfigured, finnhubProvider } from "@/services/finnhub";
import { liveProvider } from "@/services/liveProvider";

export type { DataProvider, ProviderId } from "@/services/provider";

/** Implemented providers. */
const PROVIDERS: Partial<Record<ProviderId, DataProvider>> = {
  live: liveProvider,
  finnhub: finnhubProvider,
  yahoo: yahooProvider,
  fixture: fixtureProvider,
};

/**
 * The provider used when `QUANTIQ_DATA_PROVIDER` is not set.
 *
 * `live` as soon as a Finnhub key is configured; otherwise `fixture`, which is
 * **sample data** and says so in the UI. Evaluated per call rather than at
 * import so a key added to `.env.local` takes effect on the next request.
 */
export function defaultProviderId(): ProviderId {
  return finnhubConfigured() ? "live" : "fixture";
}

/** @deprecated Use `defaultProviderId()`. Kept for existing imports. */
export const DEFAULT_PROVIDER: ProviderId = "fixture";

/** Providers that must never be mistaken for a live market-data source. */
const SAMPLE_DATA_PROVIDERS: readonly ProviderId[] = ["fixture"];

/** True when `id` serves sample data rather than real quotes. */
export function isSampleData(id: ProviderId): boolean {
  return SAMPLE_DATA_PROVIDERS.includes(id);
}

/** Warn once per process rather than on every request. */
let warnedAboutDefault = false;

/**
 * Resolve a provider.
 *
 * Selection order: explicit argument, then the `QUANTIQ_DATA_PROVIDER`
 * environment variable, then the default. An unrecognised or unimplemented
 * value warns and falls back rather than throwing, so a typo in `.env` cannot
 * take the app down.
 */
export function getProvider(id?: ProviderId): DataProvider {
  const requested = id ?? (process.env.QUANTIQ_DATA_PROVIDER as ProviderId);
  const fallbackId = defaultProviderId();
  const fallback = PROVIDERS[fallbackId] as DataProvider;

  if (requested && !PROVIDERS[requested]) {
    console.warn(
      `[services] Unknown data provider "${requested}". Falling back to "${fallbackId}".`,
    );
    return fallback;
  }

  const resolved = PROVIDERS[requested ?? fallbackId] as DataProvider;

  if (isSampleData(resolved.id) && !warnedAboutDefault) {
    warnedAboutDefault = true;
    console.warn(
      `[services] Serving SAMPLE DATA from "${resolved.id}". This is not live ` +
        `market data. Set FINNHUB_API_KEY in .env.local for the live provider.`,
    );
  }

  return resolved;
}

/** All implemented providers, for diagnostics and a future source picker. */
export function listProviders(): DataProvider[] {
  return Object.values(PROVIDERS).filter(
    (provider): provider is DataProvider => provider !== undefined,
  );
}
