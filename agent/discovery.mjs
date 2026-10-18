// « Découverte de la ville » : préparée en arrière-plan au « Let's Go! », affichée quand
// l'utilisateur la demande (bouton de la carte ou demande vocale).
//
// 1. Sélection (une seule passe du petit modèle, avec recherche web) : une réserve de 30 lieux
//    emblématiques variés, classés du plus au moins incontournable, et jusqu'à 10 rues, autour du
//    point de départ (quartier et ville donnés au modèle, avec la consigne des 40 min).
// 2. Base commune à tous les comptes, par quartier (ou ville) : la sélection et les identifiants
//    Google sont gardés (sélection refaite au bout de 3 mois) ; les coordonnées et les tracés des
//    rues, données Google, 30 jours au plus, puis redemandés.
// 3. Affichage (tools.discover) : localisation et tracé de ce qui manque ou a expiré, temps de trajet
//    réels depuis le point de départ (un seul appel), puis les 15 premiers lieux à 40 min au plus.

import { EXTRACTOR_MODEL } from "./prompts.mjs";
import { CATEGORIES } from "./store.mjs";

export const MAX_TRAVEL_S = 40 * 60;       // contrainte de temps de trajet (à pied pour l'instant)
export const MAX_SHOWN = 15;               // lieux affichés au plus
const MAX_CANDIDATES = 30;                 // réserve de candidats
const MAX_STREETS = 10;
const SELECTION_TTL_MS = 90 * 86400000;    // sélection refaite au bout de 3 mois
const GOOGLE_TTL_MS = 30 * 86400000;       // coordonnées et tracés Google : 30 jours au plus

const INSTRUCTIONS = `Tu prépares la « découverte » d'un lieu pour un voyageur qui y arrive : de quoi en saisir l'essentiel, sans parcours imposé. Le voyageur part du point de départ indiqué et se déplace à pied : ne retiens que ce qui est à 40 minutes de marche au plus de ce point (environ 3 km), dans le quartier indiqué et ses abords.
1. places : jusqu'à ${MAX_CANDIDATES} lieux emblématiques, les plus variés possible, du plus incontournable au moins incontournable : points de vue, monuments, départs de balade, port ou plage emblématique, place animée, musée très réputé, enseigne ou adresse célèbre (comme le NBA Store de la 5e Avenue à New York), marché. Évite deux lieux du même genre à la suite. Pour chacun : name (nom exact), query (nom + adresse ou quartier + ville + pays, pour Google), category (${CATEGORIES.join(", ")}), reason (une phrase factuelle).
2. streets : jusqu'à ${MAX_STREETS} rues, quais ou promenades incontournables à la même distance (rue commerçante ou piétonne, front de mer, quai du port, rue de la vieille ville, avenue célèbre). name : le nom exact de la voie tel qu'il figure sur la carte (« Rue de Verdun »), sans numéro. why : une phrase courte (« rue piétonne commerçante, crêperies et boutiques »).
Vérifie par une recherche web (office de tourisme, guides) ; n'invente rien. Vise ${MAX_CANDIDATES} lieux : une réserve large est utile (certains seront écartés s'ils sont à plus de 40 minutes). N'en propose moins que si le lieu manque vraiment de choses intéressantes, jamais des lieux sans intérêt pour atteindre le nombre. Sans lien ni markdown dans les textes.`;

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
const fresh = (at, ttl) => Boolean(at) && Date.now() - at < ttl;

// Clé de la base commune : quartier et ville dans les grandes villes, ville ailleurs
export function discoveryKey({ neighborhood, city, country }) {
  return [neighborhood && city && neighborhood !== city ? neighborhood : null, city || neighborhood, country].filter(Boolean).join(", ");
}

export function createDiscovery({ apiKey, metrics, storage, resolvePoi }) {
  const pending = new Map(); // une seule sélection à la fois par lieu

  // Sélection du modèle (recherche web) : des noms, pas encore de coordonnées
  async function select({ neighborhood, city, country }, position) {
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "low" },
        instructions: INSTRUCTIONS,
        input: `Quartier : ${neighborhood || "aucun"}. Ville : ${city || "inconnue"}. Pays : ${country || "inconnu"}. Point de départ : ${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}.`,
        tools: [{ type: "web_search" }],
        text: { format: { type: "json_schema", name: "discovery", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) throw new Error(`découverte ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage(data.usage);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    metrics?.time("discovery_ms", Date.now() - started);
    return {
      candidates: (out.places || []).slice(0, MAX_CANDIDATES).map((p) => ({
        name: cleanText(p.name, 120), query: cleanText(p.query, 200),
        category: CATEGORIES.includes(p.category) ? p.category : "other", reason: cleanText(p.reason, 300),
      })).filter((p) => p.name && p.query),
      streets: (out.streets || []).slice(0, MAX_STREETS).map((s) => ({ name: cleanText(s.name, 80), why: cleanText(s.why, 160) })).filter((s) => s.name),
    };
  }

  // Sélection du lieu : celle de la base commune si elle a moins de 3 mois, sinon une nouvelle
  function prepare({ place, position }) {
    const key = discoveryKey(place || {});
    if (!key) return Promise.reject(new Error("lieu inconnu"));
    const saved = storage.get(key);
    if (saved && fresh(saved.selectedAt, SELECTION_TTL_MS)) return Promise.resolve(saved);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const started = Date.now();
      const { candidates, streets } = await select(place, position);
      const entry = { key, city: place.city || place.neighborhood, country: place.country, candidates, streets, selectedAt: Date.now() };
      storage.set(key, entry);
      console.log(`[découverte] ${key} : ${candidates.length} candidats, ${streets.length} rues en ${Date.now() - started} ms`);
      return entry;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  // Coordonnées des candidats et tracés des rues : réutilisés s'ils ont moins de 30 jours, sinon
  // redemandés à Google (plusieurs à la fois), puis gardés dans la base commune
  async function materialize(entry, position) {
    const near = position;
    await Promise.all(entry.candidates.map(async (c) => {
      if (c.location && fresh(c.locatedAt, GOOGLE_TTL_MS)) return;
      const result = await resolvePoi({ name: c.name, query: c.query, category: c.category }, near).catch(() => null);
      if (result?.status === "resolved") {
        Object.assign(c, { placeId: result.place.placeId, location: result.place.location, locatedAt: Date.now() });
      } else {
        Object.assign(c, { location: null, locatedAt: Date.now() }); // introuvable : on ne réessaie qu'à l'expiration
      }
    }));
    for (let i = 0; i < entry.streets.length; i += 3) {
      await Promise.all(entry.streets.slice(i, i + 3).map(async (s) => {
        if (fresh(s.tracedAt, GOOGLE_TTL_MS)) return;
        const shape = await resolvePoi.traceStreet({ name: s.name, city: entry.city, country: entry.country, near }).catch(() => null);
        Object.assign(s, { path: shape?.path || null, tracedAt: Date.now() });
      }));
    }
    storage.set(entry.key, entry);
    return entry;
  }

  return { prepare, materialize };
}
