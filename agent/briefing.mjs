// Sujets de conversation pour les moments d'attente : météo des prochains jours (Open-Meteo, gratuit,
// sans clé) et événements publics de la semaine (recherche web OpenAI). Préparés à l'ouverture de la
// conversation et transmis au guide vocal, qui en parle pendant que le backend cherche des lieux.

import { BACKEND_MODEL } from "./prompts.mjs";

const WEATHER_TTL_MS = 60 * 60 * 1000;       // météo gardée 1 h
const EVENTS_TTL_MS = 6 * 60 * 60 * 1000;    // événements gardés 6 h
const EVENTS_DAYS = 7;

// Codes météo WMO → mots
function weatherWords(code) {
  if (code === 0) return "ciel dégagé";
  if (code === 1) return "plutôt ensoleillé";
  if (code === 2) return "partiellement nuageux";
  if (code === 3) return "couvert";
  if (code === 45 || code === 48) return "brouillard";
  if (code >= 51 && code <= 57) return "bruine";
  if (code === 61 || code === 80) return "quelques averses";
  if (code === 63 || code === 81) return "pluie";
  if (code === 65 || code === 82 || code === 66 || code === 67) return "fortes pluies";
  if (code >= 71 && code <= 77) return "neige";
  if (code >= 95) return "orages";
  return "temps variable";
}

export function createBriefing({ apiKey, metrics }) {
  const cache = new Map(); // clé → { at, value: Promise<string|null> }

  function cached(key, ttl, compute) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = compute().catch((err) => {
      console.warn("[briefing]", key.split("|")[0], err.message);
      cache.delete(key);
      return null;
    });
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  async function weather(position, timezone) {
    const params = new URLSearchParams({
      latitude: position.lat.toFixed(3),
      longitude: position.lng.toFixed(3),
      current: "temperature_2m,weather_code,wind_speed_10m",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "4",
    });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
    const data = await response.json();
    metrics.count("weather");
    const { current, daily } = data;
    const dayName = (iso, i) => (i === 0 ? "Aujourd'hui" : i === 1 ? "demain" :
      new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { weekday: "long", timeZone: timezone || "UTC" }));
    const days = daily.time.map((iso, i) =>
      `${dayName(iso, i)} ${weatherWords(daily.weather_code[i])}, ${Math.round(daily.temperature_2m_min[i])} à ${Math.round(daily.temperature_2m_max[i])} °C` +
      (daily.precipitation_probability_max[i] >= 30 ? ` (risque de pluie ${daily.precipitation_probability_max[i]} %)` : ""));
    return `En ce moment ${Math.round(current.temperature_2m)} °C, ${weatherWords(current.weather_code)}, vent ${Math.round(current.wind_speed_10m)} km/h. ${days.join(" ; ")}.`;
  }

  async function events(place, timezone) {
    const where = [place.city, place.country].filter(Boolean).join(", ");
    const fmt = (d) => d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone || "UTC" });
    const today = new Date();
    const end = new Date(today.getTime() + EVENTS_DAYS * 86400000);
    const prompt = `Nous sommes le ${fmt(today)}. Cherche sur le web les événements publics prévus à ${where} (et dans ses environs immédiats) entre aujourd'hui et le ${fmt(end)} : festivals, fêtes locales ou religieuses, concerts, marchés, expositions, événements sportifs.
Donne au plus 6 événements, un par ligne, au format : jour et date – nom – lieu – une courte précision.
Ne garde que ce que des sources récentes confirment pour ces dates ; n'invente rien. S'il n'y a rien de confirmé, réponds exactement : AUCUN.
Pas d'introduction, pas de conclusion, pas d'URL.`;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BACKEND_MODEL,
        reasoning: { effort: "low" },
        tools: [{ type: "web_search" }],
        input: prompt,
        max_output_tokens: 1200,
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`Responses ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    metrics.count("events_search");
    metrics.count("web_search", (data.output || []).filter((o) => o.type === "web_search_call").length);
    metrics.backendUsage(data.usage);
    const text = (data.output || [])
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content || [])
      .map((c) => c.text || "")
      .join("\n")
      .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "")   // citations en lien Markdown
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();
    return !text || /^AUCUN\b/i.test(text) ? null : text;
  }

  // Texte transmis au guide, ou null si rien n'est disponible
  return async function brief(context) {
    const { position, place, timezone } = context;
    if (!position) return null;
    const day = new Date().toISOString().slice(0, 10);
    const [w, e] = await Promise.all([
      cached(`weather|${position.lat.toFixed(2)},${position.lng.toFixed(2)}|${day}`, WEATHER_TTL_MS, () => weather(position, timezone)),
      place?.city ? cached(`events|${place.city}|${place.country}|${day}`, EVENTS_TTL_MS, () => events(place, timezone)) : Promise.resolve(null),
    ]);
    if (!w && !e) return null;
    const where = place?.city ? ` à ${place.city}` : "";
    return [
      w ? `Météo${where} : ${w}` : null,
      e ? `Événements prévus dans les prochains jours${where} (d'après le web, à présenter comme « prévus ») :\n${e}` : `Aucun événement confirmé trouvé${where} pour la semaine.`,
    ].filter(Boolean).join("\n");
  };
}
