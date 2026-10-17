// Infos pratiques du point de départ (écran « Infos pratiques ») :
// - météo maintenant, dans 4 h et dans 24 h (Open-Meteo : vraies prévisions, gratuites, sans clé) ;
// - petit guide de conversation dans la langue principale du pays (petit modèle, sortie structurée),
//   mémorisé par pays dans la base pour ne pas le redemander. Pas de guide si la langue est le
//   français ou si aucune langue n'est nettement majoritaire.

import { EXTRACTOR_MODEL } from "./prompts.mjs";

export const PHRASES = [
  "Oui / Non", "Bonjour", "Au revoir", "Merci", "S'il vous plaît", "Excusez-moi",
  "C'était délicieux !", "Vous êtes très sympa !", "C'est joli !", "Génial !", "Je suis fatigué",
];

const WEATHER_WORDS = [
  [[0], "ciel dégagé"], [[1], "plutôt ensoleillé"], [[2], "partiellement nuageux"], [[3], "couvert"],
  [[45, 48], "brouillard"], [[51, 53, 55, 56, 57], "bruine"], [[61, 80], "averses"], [[63, 81], "pluie"],
  [[65, 66, 67, 82], "fortes pluies"], [[71, 73, 75, 77, 85, 86], "neige"], [[95, 96, 99], "orages"],
];
const sky = (code) => WEATHER_WORDS.find(([codes]) => codes.includes(code))?.[1] || "temps variable";
const WIND_DIRECTIONS = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
const windFrom = (deg) => (Number.isFinite(deg) ? WIND_DIRECTIONS[Math.round(deg / 45) % 8] : null);

const INSTRUCTIONS = `Tu prépares un petit guide de conversation pour un voyageur francophone (un homme).
1. Détermine la langue majoritaire parlée par les habitants du pays indiqué.
   Si c'est le français, ou si aucune langue n'est nettement majoritaire (plusieurs langues d'importance comparable), skip = true, language = null et phrases vide.
2. Sinon, traduis chaque expression française dans cette langue, telle qu'on la dit couramment et poliment, dans le même ordre. Le voyageur est un homme : forme masculine quand elle diffère.
3. Alphabet non latin (grec, hébreu, arabe, cyrillique, chinois, japonais, coréen, thaï…) : local = seulement la transcription phonétique pour un francophone, la syllabe accentuée marquée d'un accent aigu si utile (ex. grec « Ευχαριστώ » → « efkharistó », hébreu « תודה » → « toda »), jamais l'écriture d'origine. latin_script = false.
   Alphabet latin : local = la traduction écrite normalement, avec ses accents. latin_script = true.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["skip", "language", "latin_script", "phrases"],
  properties: {
    skip: { type: "boolean" },
    language: { type: ["string", "null"], description: "Nom de la langue en français (« grec », « hébreu »), ou null." },
    latin_script: { type: "boolean" },
    phrases: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["fr", "local"],
        properties: { fr: { type: "string" }, local: { type: "string" } },
      },
    },
  },
};

export function createPractical({ apiKey, metrics, storage }) {
  // Météo à trois moments : maintenant, dans 4 h, dans 24 h
  async function weather(position) {
    const params = new URLSearchParams({
      latitude: position.lat.toFixed(3),
      longitude: position.lng.toFixed(3),
      current: "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day",
      hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day",
      timezone: "auto",
      forecast_days: "3",
    });
    const url = `https://api.open-meteo.com/v1/forecast?${params}`;
    let response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (response.status >= 500) {
      // Indisponibilité passagère d'Open-Meteo : un nouvel essai un peu plus tard
      await new Promise((r) => setTimeout(r, 2000));
      response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    }
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
    const data = await response.json();
    metrics?.count("weather");
    const { current, hourly } = data;
    // Heure locale du lieu : l'index horaire correspondant à « maintenant », puis + 4 et + 24
    const nowIndex = Math.max(0, hourly.time.findIndex((t) => t >= current.time.slice(0, 13)));
    const at = (offset, label) => {
      const i = Math.min(hourly.time.length - 1, nowIndex + offset);
      return {
        label,
        time: hourly.time[i],
        temperature: Math.round(offset ? hourly.temperature_2m[i] : current.temperature_2m),
        rain_probability: hourly.precipitation_probability[i] ?? null,
        rain_mm: Math.round((offset ? hourly.precipitation[i] : current.precipitation) * 10) / 10,
        wind_kmh: Math.round(offset ? hourly.wind_speed_10m[i] : current.wind_speed_10m),
        wind_from: windFrom(offset ? hourly.wind_direction_10m[i] : current.wind_direction_10m),
        sky: sky(offset ? hourly.weather_code[i] : current.weather_code),
        code: offset ? hourly.weather_code[i] : current.weather_code, // icône animée de la fenêtre météo
        is_day: Boolean(offset ? hourly.is_day[i] : current.is_day),
      };
    };
    return { generatedAt: Date.now(), timezone: data.timezone, points: [at(0, "Maintenant"), at(4, "Dans 4 h"), at(24, "Dans 24 h")] };
  }

  // Guide de conversation du pays : mémorisé dans la base (un seul appel au modèle par pays)
  const pending = new Map();
  async function phrasebook(country) {
    if (!country) return null;
    const saved = storage.get(country);
    if (saved) return saved;
    if (pending.has(country)) return pending.get(country);
    const request = generate(country).finally(() => pending.delete(country));
    pending.set(country, request);
    return request;
  }

  async function generate(country) {
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "low" },
        instructions: INSTRUCTIONS,
        input: `Pays : ${country}.\nExpressions à traduire, dans cet ordre :\n${PHRASES.map((p) => `- ${p}`).join("\n")}`,
        text: { format: { type: "json_schema", name: "phrasebook", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`guide de conversation ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage(data.usage);
    metrics?.time("phrasebook_ms", Date.now() - started);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    // Les expressions françaises font foi (ordre et texte) ; une traduction manquante est ignorée
    const phrases = out.skip ? [] : PHRASES.map((fr, i) => ({ fr, local: String(out.phrases?.[i]?.local || "").trim().slice(0, 120) })).filter((p) => p.local);
    const result = {
      country,
      language: out.skip ? null : String(out.language || "").slice(0, 40) || null,
      latinScript: Boolean(out.latin_script),
      phrases,
      generatedAt: Date.now(),
    };
    storage.set(country, result);
    console.log(`[infos pratiques] guide « ${country} » : ${result.language || "aucun (français ou langue incertaine)"} en ${Date.now() - started} ms`);
    return result;
  }

  return { weather, phrasebook };
}
