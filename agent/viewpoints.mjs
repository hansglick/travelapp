// « Points de vue » : préparés en arrière-plan au « Let's Go! », affichés comme des lieux quand
// l'utilisateur touche le bouton du bonhomme qui marche.
//
// 1. Sélection (petit modèle, recherche web) : les points de vue de la ville et des communes voisines
//    (15 km environ) présentés par un site de tourisme ou un guide, classés par notoriété.
// 2. Base commune à tous les comptes, par ville : la sélection est refaite au bout de 3 mois ; les
//    positions (données Google) au bout de 30 jours.
// 3. Affichage (tools.showViewpoints) : 7 points de vue au plus, sans la règle des 40 min.

import { EXTRACTOR_MODEL } from "./prompts.mjs";

export const MAX_VIEWPOINTS = 7;            // points de vue affichés au plus
export const AREA_KM = 15;                  // zone : la ville et les communes voisines
const RESERVE = 10;                         // points de vue recherchés (réserve si certains échouent)
const SELECTION_TTL_MS = 90 * 86400000;     // sélection refaite au bout de 3 mois
const GOOGLE_TTL_MS = 30 * 86400000;        // positions Google : 30 jours au plus
const VERSION = 1;

const INSTRUCTIONS = `Tu prépares les points de vue à proposer à un voyageur dans une ville : ${RESERVE} points de vue de la ville et des communes voisines (${AREA_KM} km au plus), classés par notoriété : d'abord ceux dont parlent tous les guides et l'office de tourisme, puis les autres.
Un point de vue : un endroit précis d'où l'on a une belle vue (panorama, belvédère, pointe, falaise, phare ou tour qui se visite, table d'orientation, colline, terrasse panoramique). Ne retiens que des points de vue présentés comme tels par un site de tourisme ou un guide de voyage ; accessibles depuis la terre ferme (pas d'île sans pont). N'en donne moins que si tu n'en trouves vraiment pas autant ; jamais un lieu douteux pour atteindre le nombre.
Pour chacun : name (nom exact), query (nom + commune + pays, pour Google Maps), reason (une phrase : ce qu'on y voit).
Vérifie par une recherche web ; n'invente rien. Sans lien ni markdown dans les textes.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["viewpoints"],
  properties: {
    viewpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "query", "reason"],
        properties: { name: { type: "string" }, query: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

const cleanText = (t, max) => String(t || "").replace(/\[[^\]]*\]\([^)]*\)/g, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim().slice(0, max);
const fresh = (at, ttl) => Boolean(at) && Date.now() - at < ttl;

// Clé de la base commune : la ville (les points de vue couvrent la ville et ses environs)
export function viewpointsKey({ neighborhood, city, country }) {
  return ["points de vue", city || neighborhood, country].filter(Boolean).join(", ");
}

export function createViewpoints({ apiKey, metrics, storage, resolvePoi }) {
  const pending = new Map(); // une seule sélection à la fois par ville

  async function select({ city, country }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "medium" }, // sélection gardée 3 mois : la qualité prime sur la vitesse
        instructions: INSTRUCTIONS,
        input: `Ville : ${city || "inconnue"}. Pays : ${country || "inconnu"}.`,
        tools: [{ type: "web_search" }],
        text: { format: { type: "json_schema", name: "viewpoints", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(300000), // recherche web : parfois plus de 3 min
    });
    if (!response.ok) throw new Error(`points de vue ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage(data.usage);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    return (out.viewpoints || []).slice(0, RESERVE).map((v) => ({
      name: cleanText(v.name, 120), query: cleanText(v.query, 200), reason: cleanText(v.reason, 300),
    })).filter((v) => v.name && v.query);
  }

  // Sélection de la ville : celle de la base commune si elle a moins de 3 mois, sinon une nouvelle
  function prepare({ place }) {
    if (!place?.city && !place?.neighborhood) return Promise.reject(new Error("lieu inconnu"));
    const key = viewpointsKey(place);
    const saved = storage.get(key);
    if (saved && saved.version === VERSION && fresh(saved.selectedAt, SELECTION_TTL_MS)) return Promise.resolve(saved);
    if (pending.has(key)) return pending.get(key);
    const request = (async () => {
      const started = Date.now();
      const where = { city: place.city || place.neighborhood, country: place.country };
      const candidates = await select(where);
      const entry = { key, version: VERSION, ...where, candidates, selectedAt: Date.now() };
      storage.set(key, entry);
      metrics?.time("viewpoints_ms", Date.now() - started);
      console.log(`[points de vue] ${key} : ${candidates.length} candidat(s) en ${Date.now() - started} ms`);
      return entry;
    })().finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  }

  // Positions des candidats (Google) : réutilisées si elles ont moins de 30 jours, puis enregistrées
  async function materialize(entry, near) {
    await Promise.all(entry.candidates.map(async (c) => {
      if (c.locatedAt && fresh(c.locatedAt, GOOGLE_TTL_MS)) return;
      const result = await resolvePoi({ name: c.name, query: c.query, category: "viewpoint" }, near).catch(() => null);
      // Plusieurs lieux possibles (« Pointe du Conguel » : la pointe, son parking…) : le plus probable
      const place = result?.status === "resolved" ? result.place : result?.status === "ambiguous" ? result.candidates?.[0] : null;
      if (place?.location) Object.assign(c, { placeId: place.placeId || null, location: place.location, locatedAt: Date.now() });
      else Object.assign(c, { placeId: null, location: null, locatedAt: Date.now() }); // introuvable : réessayé à l'expiration
    }));
    storage.set(entry.key, entry);
    return entry;
  }

  return { prepare, materialize };
}
