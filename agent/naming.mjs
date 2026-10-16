// Noms proposés pour un séjour et un itinéraire, à partir des lieux, des tâches et du contexte.
// Requête simple au petit modèle (sans outils ni recherche web), avec une sortie structurée : l'API
// garantit un objet JSON à deux champs texte, sans phrase autour. Le serveur vérifie ensuite les
// valeurs ; une valeur douteuse n'est simplement pas proposée.

import { EXTRACTOR_MODEL } from "./prompts.mjs";

const INSTRUCTIONS = `Tu proposes deux noms courts pour une application de voyage.
- folder_name : le nom d'un séjour (dossier qui regroupe des itinéraires) : 2 à 5 mots, le lieu (ville ou région) et la période (mois et année). Exemple : « Crète, octobre 2026 ».
- itinerary_name : le nom d'un itinéraire : 2 à 6 mots, le thème des lieux ou du quartier, sans verbe. Exemples : « Vieille ville et port vénitien », « Pâtisseries et cafés du centre ».
En français. Pas de phrase, pas de guillemets, pas de point final, pas d'emoji. Évite les noms déjà utilisés.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["folder_name", "itinerary_name"],
  properties: {
    folder_name: { type: "string", description: "Nom du séjour, 2 à 5 mots." },
    itinerary_name: { type: "string", description: "Nom de l'itinéraire, 2 à 6 mots." },
  },
};

// Nettoyage : espaces, guillemets, ponctuation finale ; null si vide ou trop long
function clean(value) {
  const text = String(value || "")
    .replace(/[«»"“”]/g, "") // guillemets (les apostrophes sont gardées)
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,\s]+$/, "")
    .trim();
  if (text.length < 2 || text.length > 40 || /\n/.test(text)) return null;
  return text;
}

export function createNamer({ apiKey, metrics }) {
  return async function suggestNames({ pois, tasks, place, timezone, existingTrips, existingItineraries }) {
    const today = new Date().toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: timezone || "UTC" });
    const input = [
      `Lieu de l'utilisateur : ${[place?.neighborhood, place?.city, place?.country].filter(Boolean).join(", ") || "inconnu"}.`,
      `Période : ${today}.`,
      `Lieux de l'itinéraire : ${pois.slice(0, 25).map((p) => `${p.name} (${p.category})`).join(" ; ") || "aucun"}.`,
      `Tâches qui les regroupent : ${tasks.slice(0, 10).join(" ; ") || "aucune"}.`,
      `Séjours déjà existants : ${existingTrips.join(" ; ") || "aucun"}.`,
      `Itinéraires déjà existants : ${existingItineraries.join(" ; ") || "aucun"}.`,
    ].join("\n");
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "none" },
        service_tier: "priority",
        instructions: INSTRUCTIONS,
        input,
        text: { format: { type: "json_schema", name: "names", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`suggestion de noms ${response.status}`);
    const data = await response.json();
    metrics.backendUsage(data.usage);
    metrics.time("name_suggestion_ms", Date.now() - started);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    return { folderName: clean(out.folder_name), itineraryName: clean(out.itinerary_name) };
  };
}
