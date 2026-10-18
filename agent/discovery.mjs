// « Découverte de la ville » : la sélection est préparée en arrière-plan au « Let's Go! » et affichée
// seulement quand l'utilisateur la demande.
// - Préparation (ici) : le petit modèle, avec recherche web (office de tourisme, guides), choisit
//   jusqu'à 15 lieux emblématiques les plus variés et jusqu'à 10 rues incontournables. Ce ne sont que
//   des noms : aucun appel Google à ce stade.
// - Affichage (tools.discover) : les lieux sont localisés dans Google et placés comme des lieux
//   ordinaires ; chaque rue est tracée par Google (Geocoding + Routes, voir places.traceStreet) et
//   coloriée à la couleur du groupe.

import { EXTRACTOR_MODEL } from "./prompts.mjs";
import { CATEGORIES } from "./store.mjs";

const MAX_PLACES = 15;
const MAX_STREETS = 10;

const INSTRUCTIONS = `Tu prépares la « découverte de la ville » pour un voyageur qui arrive dans une petite ville ou un quartier : de quoi en saisir l'essentiel, sans parcours imposé.
1. places : jusqu'à ${MAX_PLACES} lieux emblématiques, les plus variés possible, du plus incontournable au moins incontournable : points de vue, monuments, départs de balade, port ou plage emblématique, place animée, musée très réputé, enseigne ou adresse célèbre (comme le NBA Store de la 5e Avenue à New York), marché. Évite deux lieux du même genre à la suite. Pour chacun : name (nom exact), query (nom + adresse ou quartier + ville + pays, pour Google), category (${CATEGORIES.join(", ")}), reason (une phrase factuelle).
2. streets : jusqu'à ${MAX_STREETS} rues, quais ou promenades incontournables (rue commerçante ou piétonne, front de mer, quai du port, rue de la vieille ville, avenue célèbre). name : le nom exact de la voie tel qu'il figure sur la carte (« Rue de Verdun », « Quai de Houat »), sans numéro. why : une phrase courte (« rue piétonne commerçante, crêperies et boutiques »).
Vérifie par une recherche web (office de tourisme, guides) ; n'invente rien. Sans lien ni markdown dans les textes.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["places", "streets"],
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "query", "category", "reason"],
        properties: {
          name: { type: "string" }, query: { type: "string" },
          category: { type: "string", enum: CATEGORIES }, reason: { type: "string" },
        },
      },
    },
    streets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "why"],
        properties: { name: { type: "string" }, why: { type: "string" } },
      },
    },
  },
};

const cleanText = (t, max) => String(t || "").replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export function createDiscovery({ apiKey, metrics }) {
  // Sélection par le modèle (recherche web) : des noms, pas encore de coordonnées
  async function prepare({ city, country }) {
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "low" },
        instructions: INSTRUCTIONS,
        input: `Ville : ${city || "inconnue"}. Pays : ${country || "inconnu"}.`,
        tools: [{ type: "web_search" }],
        text: { format: { type: "json_schema", name: "discovery", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(150000),
    });
    if (!response.ok) throw new Error(`découverte ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage(data.usage);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    const result = {
      city, country,
      places: (out.places || []).slice(0, MAX_PLACES).map((p) => ({
        name: cleanText(p.name, 120), query: cleanText(p.query, 200),
        category: CATEGORIES.includes(p.category) ? p.category : "other", reason: cleanText(p.reason, 300),
      })).filter((p) => p.name && p.query),
      streets: (out.streets || []).slice(0, MAX_STREETS).map((s) => ({ name: cleanText(s.name, 80), why: cleanText(s.why, 160) })).filter((s) => s.name),
      generatedAt: Date.now(),
    };
    metrics?.time("discovery_ms", Date.now() - started);
    console.log(`[découverte] ${city || "?"} : ${result.places.length} lieux, ${result.streets.length} rues choisis en ${Date.now() - started} ms`);
    return result;
  }

  return { prepare };
}
