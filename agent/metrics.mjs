// Mesures de la session : délais de chaque étape et consommation de chaque service facturé.
// Les prix servent à une estimation, à vérifier sur les pages tarifaires.
const PRICES = {
  voicePerMinute: 0.05,            // gpt-live-1
  backendInputPerM: 0.10,          // gpt-6-luna, entrée
  backendCachedInputPerM: 0.01,
  backendOutputPerM: 0.50,
  webSearchPerCall: 0.01,          // 10 $ / 1 000 recherches
  textSearchPerCall: 0.032,        // Places Text Search, palier Pro (estimation)
};

export function createMetrics() {
  let counts, timings, usage;

  function reset() {
    counts = {};
    timings = {};
    usage = { voiceSeconds: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
  }
  reset();

  return {
    reset,
    count(name, n = 1) {
      counts[name] = (counts[name] || 0) + n;
    },
    time(name, ms) {
      (timings[name] ||= []).push(Math.round(ms));
    },
    voiceSeconds(seconds) {
      usage.voiceSeconds = seconds;
    },
    backendUsage(u) {
      if (!u) return;
      usage.inputTokens += u.input_tokens || 0;
      usage.cachedTokens += u.input_tokens_details?.cached_tokens || 0;
      usage.outputTokens += u.output_tokens || 0;
    },
    summary() {
      const stats = Object.fromEntries(Object.entries(timings).map(([name, list]) => {
        const sorted = [...list].sort((a, b) => a - b);
        return [name, { n: list.length, median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) }];
      }));
      const uncached = usage.inputTokens - usage.cachedTokens;
      const cost = {
        voice: (usage.voiceSeconds / 60) * PRICES.voicePerMinute,
        backend: (uncached * PRICES.backendInputPerM + usage.cachedTokens * PRICES.backendCachedInputPerM + usage.outputTokens * PRICES.backendOutputPerM) / 1e6,
        webSearch: (counts.web_search || 0) * PRICES.webSearchPerCall,
        googlePlaces: (counts.google_text_search || 0) * PRICES.textSearchPerCall,
      };
      const round = (x) => Math.round(x * 10000) / 10000;
      return {
        counts,
        timings_ms: stats,
        usage,
        estimated_cost_usd: { ...Object.fromEntries(Object.entries(cost).map(([k, v]) => [k, round(v)])), total: round(Object.values(cost).reduce((a, b) => a + b, 0)) },
      };
    },
  };
}
