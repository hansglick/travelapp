// Infos pratiques du point de départ (écran « Infos pratiques ») :
// - météo maintenant, dans 4 h et dans 24 h (Open-Meteo : vraies prévisions, gratuites, sans clé) ;
// - petit guide de conversation dans la langue principale du pays (petit modèle, sortie structurée),
//   langue majoritaire du pays du lieu (mémorisée par pays), puis guide mémorisé par langue dans la
//   base. Pas de guide si cette langue est le français.

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

// Étape 1 : langue du lieu = langue majoritaire de son pays (appel rapide, mémorisé par pays)
const LANGUAGE_INSTRUCTIONS = `Donne la langue majoritaire du pays indiqué, celle que parle la plus grande partie de ses habitants (Grèce → grec, Canada → anglais, Suisse → allemand, Israël → hébreu).
language : le nom de la langue en français, en minuscules.`;

const LANGUAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language"],
  properties: { language: { type: "string" } },
};

// Étape 2 : guide de conversation dans une langue (mémorisé par langue)
const INSTRUCTIONS = `Tu prépares un petit guide de conversation pour un voyageur francophone (un homme), dans la langue indiquée.
1. Traduis chaque expression française dans cette langue, telle qu'on la dit couramment et poliment, dans le même ordre. Le voyageur est un homme : forme masculine quand elle diffère.
2. Alphabet non latin (grec, hébreu, arabe, cyrillique, chinois, japonais, coréen, thaï…) : local = seulement la transcription phonétique pour un francophone, la syllabe accentuée marquée d'un accent aigu si utile (ex. grec « Ευχαριστώ » → « efkharistó », hébreu « תודה » → « toda »), jamais l'écriture d'origine. latin_script = false.
   Alphabet latin : local = la traduction écrite normalement, avec ses accents. latin_script = true.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["latin_script", "phrases"],
  properties: {
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

// Fun facts : 5 faits ou anecdotes vérifiés sur le web, sur le quartier si on en trouve assez,
// sinon sur la ville
const FACTS_INSTRUCTIONS = `Tu prépares 5 « fun facts » pour un voyageur francophone qui arrive dans un lieu : des faits ou anecdotes surprenants, amusants ou marquants (histoire, personnages, records, traditions, curiosités, cinéma, gastronomie…).
- Si un quartier est indiqué et que tu trouves au moins 5 faits intéressants et vérifiables sur ce quartier, parle du quartier ; sinon, parle de la ville. scope_name = le nom du lieu retenu.
- Vérifie chaque fait par une recherche web ; n'invente rien. Préfère des faits précis (dates, chiffres, noms) aux généralités.
- title : 3 à 7 mots, accrocheur. text : 1 ou 2 phrases courtes, en français, sans lien, sans source et sans markdown dans le texte.`;

const FACTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scope_name", "facts"],
  properties: {
    scope_name: { type: "string" },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "text"],
        properties: { title: { type: "string" }, text: { type: "string" } },
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

  // Appel structuré au petit modèle ; renvoie l'objet JSON produit
  async function ask({ instructions, input, name, schema, effort, timeout, tools = null }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort },
        instructions,
        input,
        ...(tools ? { tools } : {}),
        text: { format: { type: "json_schema", name, strict: true, schema } },
        store: false,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(`${name} ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage(data.usage);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    return JSON.parse(text || "{}");
  }

  // Une seule demande à la fois pour une même clé (deux écrans qui partent ensemble)
  const pending = new Map();
  function once(key, compute) {
    if (pending.has(key)) return pending.get(key);
    const request = compute().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  // Langue d'un lieu : 1. son pays ; 2. la langue majoritaire de ce pays ; 3. c'est la langue
  // locale. Mémorisée par pays ; une réponse vide n'est pas mémorisée (redemandée la fois suivante).
  function countryLanguage(country) {
    const key = `country:${country}`;
    const saved = storage.get(key);
    if (saved?.language) return Promise.resolve(saved.language);
    return once(key, async () => {
      const out = await ask({
        instructions: LANGUAGE_INSTRUCTIONS,
        input: `Pays : ${country}.`,
        name: "country_language", schema: LANGUAGE_SCHEMA, effort: "none", timeout: 15000,
      });
      const language = typeof out.language === "string" && out.language.trim() ? out.language.trim().toLowerCase().slice(0, 40) : null;
      if (language) storage.set(key, { language });
      return language;
    });
  }

  // Guide de conversation du lieu : pas de guide si la langue est le français ou incertaine
  async function phrasebook({ city, region, country }) {
    if (!country) return null;
    const started = Date.now();
    const language = await countryLanguage(country);
    if (!language || language === "français") {
      console.log(`[infos pratiques] ${[city, region, country].filter(Boolean).join(", ")} : ${language || "langue incertaine"}, pas de guide`);
      return { language: null, phrases: [], generatedAt: Date.now() };
    }
    const key = `lang:${language}`;
    const saved = storage.get(key);
    if (saved) return saved;
    return once(key, async () => {
      const out = await ask({
        instructions: INSTRUCTIONS,
        input: `Langue : ${language}.\nExpressions à traduire, dans cet ordre :\n${PHRASES.map((p) => `- ${p}`).join("\n")}`,
        name: "phrasebook", schema: SCHEMA, effort: "low", timeout: 40000,
      });
      // Les expressions françaises font foi (ordre et texte) ; une traduction manquante est ignorée
      const phrases = PHRASES.map((fr, i) => ({ fr, local: String(out.phrases?.[i]?.local || "").trim().slice(0, 120) })).filter((p) => p.local);
      const result = { language, latinScript: Boolean(out.latin_script), phrases, generatedAt: Date.now() };
      if (phrases.length) storage.set(key, result);
      metrics?.time("phrasebook_ms", Date.now() - started);
      console.log(`[infos pratiques] guide « ${language} » créé en ${Date.now() - started} ms`);
      return result;
    });
  }

  // Fun facts du lieu (recherche web) : mémorisés par lieu (quartier ou ville), communs à tous
  async function funFacts({ neighborhood, city, country }) {
    if (!city && !neighborhood) return null;
    const key = `facts:${[neighborhood, city, country].filter(Boolean).join(", ")}`;
    const saved = storage.get(key);
    if (saved) return saved;
    return once(key, async () => {
      const started = Date.now();
      const out = await ask({
        instructions: FACTS_INSTRUCTIONS,
        input: `Quartier : ${neighborhood || "aucun"}. Ville : ${city || "inconnue"}. Pays : ${country || "inconnu"}.`,
        name: "fun_facts", schema: FACTS_SCHEMA, effort: "low", timeout: 120000,
        tools: [{ type: "web_search" }],
      });
      // Liens et citations retirés (y compris les parenthèses vides qu'ils laissent)
      const clean = (t, max) => String(t || "").replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/\(\s*\)/g, "").replace(/\s+([.,;:!?])/g, "$1").replace(/\s+/g, " ").trim().slice(0, max);
      const facts = (out.facts || []).slice(0, 5).map((f) => ({ title: clean(f.title, 80), text: clean(f.text, 400) })).filter((f) => f.title && f.text);
      const result = { place: clean(out.scope_name, 80) || city || neighborhood, facts, generatedAt: Date.now() };
      if (facts.length) storage.set(key, result);
      metrics?.time("fun_facts_ms", Date.now() - started);
      console.log(`[infos pratiques] fun facts « ${result.place} » : ${facts.length} en ${Date.now() - started} ms`);
      return result;
    });
  }

  return { weather, phrasebook, funFacts };
}
