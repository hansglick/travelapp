// Plat demandé (« j'ai envie d'un couscous ») : probabilité que chaque type de restaurant Google le
// serve (moroccan_restaurant 0,95, african_restaurant 0,7, restaurant 0,2…). La recherche parcourt
// ensuite les types du plus probable au moins probable (tools.mjs, dishDirect).
// La distribution dépend du pays : en Grèce, presque toute taverne ou snack sert du gyros, et Google
// y classe souvent ces lieux en simple « restaurant ». Calculée une fois par plat et par pays par le
// modèle, puis gardée en base pour tous les comptes.

import { EXTRACTOR_MODEL } from "./prompts.mjs";
import { FOOD_TYPES } from "./google-types.mjs";

const MIN_STORED = 0.05; // en dessous, le type est omis (probabilité nulle)

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["types"],
  properties: {
    types: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "probability"],
        properties: {
          type: { type: "string", enum: FOOD_TYPES },
          probability: { type: "number", description: "Entre 0 et 1." },
        },
      },
    },
  },
};

const instructions = (country) => `On te donne un plat (ou un produit) qu'un voyageur veut manger, le pays où il se trouve, et la liste des types d'établissements de Google Places.
Pour chaque type, estime la probabilité qu'un établissement de ce type, dans ce pays (${country || "en Europe"}), propose ce plat à sa carte.
Tiens compte des habitudes locales (un plat national se trouve dans bien plus d'endroits que dans les autres pays) et de la façon dont Google classe les établissements dans ce pays (beaucoup n'ont qu'un type générique : restaurant, fast_food_restaurant, meal_takeaway…).
- Un type dont c'est la spécialité : proche de 1 (couscous → moroccan_restaurant 0.95).
- Un type qui le sert souvent sans en faire sa spécialité : entre 0.3 et 0.8.
- Le type générique « restaurant » (restaurant sans cuisine précise) : la part des restaurants ordinaires qui le servent.
- Omets les types à moins de ${MIN_STORED} (ils comptent pour 0).
Sois réaliste et discriminant : ne mets pas tout à 0.5.`;

// Clé d'un plat : minuscules, sans accents ni ponctuation (« Dorade » = « dorade »)
export const dishKey = (dish) => String(dish || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function createDishes({ apiKey, metrics, storage }) {
  const inFlight = new Map();

  async function ask(dish, country) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "low" },
        instructions: instructions(country),
        input: `Plat : ${dish}\nPays : ${country || "inconnu (Europe)"}\nTypes : ${FOOD_TYPES.join(", ")}`,
        text: { format: { type: "json_schema", name: "dish_types", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`plat ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage?.(data.usage);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    const probabilities = {};
    for (const { type, probability } of out.types || []) {
      const p = Math.min(1, Math.max(0, Number(probability) || 0));
      if (FOOD_TYPES.includes(type) && p >= MIN_STORED) probabilities[type] = Math.max(probabilities[type] || 0, p);
    }
    return probabilities;
  }

  // { type: probabilité } du plat dans le pays, calculée au premier appel puis lue en base ; null si
  // impossible. Clé : « gyros|grece » (« gyros » seul : pays inconnu)
  async function distribution(dish, country) {
    if (!dishKey(dish)) return null;
    const key = [dishKey(dish), dishKey(country)].filter(Boolean).join("|");
    const saved = storage.get(key);
    if (saved) return saved.probabilities;
    if (!inFlight.has(key)) {
      const started = Date.now();
      inFlight.set(key, ask(dish, country)
        .then((probabilities) => {
          if (Object.keys(probabilities).length) storage.set(key, { dish, country: country || null, probabilities, createdAt: Date.now() });
          metrics?.time?.("dish_ms", Date.now() - started);
          const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t, p]) => `${t} ${p}`).join(", ");
          console.log(`[plats] « ${key} » calculé en ${Date.now() - started} ms : ${top}`);
          return Object.keys(probabilities).length ? probabilities : null;
        })
        .catch((err) => {
          console.warn(`[plats] « ${key} » :`, err.message);
          return null;
        })
        .finally(() => inFlight.delete(key)));
    }
    return inFlight.get(key);
  }

  return { distribution };
}
