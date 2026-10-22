// Vérification sur le web des candidats trouvés par Google (canal mixte) : une seule question par
// lieu, toutes en parallèle (10 lieux au plus).
// - criterion : un critère concret (« sert du poisson », « propose des plats sans gluten ») →
//   confirmed (une source le dit), unknown (rien trouvé) ou no (le web montre que non : écarté) ;
// - reputation : le lieu est-il recommandé (guides, presse, avis très favorables) → recommended ou no.
// Au passage, pour un lieu où l'on mange, le modèle relève les plats vus sur sa carte et les régimes
// signalés : ils sont gardés en base (menus) et resservent aux recherches suivantes.

import { EXTRACTOR_MODEL } from "./prompts.mjs";

export const MAX_CHECKED = 10;
export const DIETS = ["végétarien", "vegan", "sans gluten", "halal"];

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "note", "dishes", "diets", "menu_source", "web_name", "source_url"],
  properties: {
    answer: { type: "string", enum: ["confirmed", "unknown", "no", "recommended"] },
    note: { type: "string", description: "Mention courte affichée dans la bulle, qui cite la source quand il y en a une." },
    dishes: {
      type: "array",
      description: "Plats vus sur la carte du lieu ; vide si tu n'as vu aucune carte ni liste de plats.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "group"],
        properties: {
          name: { type: "string", description: "Nom court et usuel en français, en minuscules (« gyros », « moussaka », « salade grecque »)." },
          group: { type: "string", description: "Rubrique de la carte, à ta discrétion, en français et avec une majuscule (« Entrées », « Plats », « Grillades », « Desserts », « Boissons »…). Garde les mêmes rubriques pour tout le lieu." },
        },
      },
    },
    diets: { type: "array", items: { type: "string", enum: DIETS }, description: "Régimes que la carte ou la fiche du lieu signale explicitement." },
    menu_source: { type: "string", enum: ["menu", "fiche", "avis", "aucune"], description: "D'où viennent les plats : la carte du lieu (site, photo, livraison), une fiche d'annuaire, des avis, ou aucune." },
    web_name: { type: "string", description: "Le nom du lieu tel qu'il est écrit sur ses sources web (son site, sa carte, une fiche d'avis), vide si tu ne l'as pas vu écrit." },
    source_url: { type: "string", description: "L'adresse exacte (https://…) de la page consultée qui prouve ta réponse (confirmed ou no), copiée telle quelle depuis tes résultats de recherche ; vide si unknown ou si tu n'as pas l'adresse." },
  },
};

const MENU_NOTE = `
En plus, si c'est un lieu où l'on mange ou boit : relève dans dishes les plats que tu as vus sur sa carte pendant ta recherche (60 au plus, nom court et usuel en français, sans prix ni description, chacun dans sa rubrique : entrées, plats, desserts, boissons… à ta discrétion), et dans diets les régimes qu'elle signale explicitement. Ne relève que ce que tu as vraiment vu ; sinon, listes vides et menu_source « aucune ». Dans web_name, le nom du lieu tel qu'il est écrit sur ces sources (vide si tu ne l'as pas vu).`;

const INSTRUCTIONS = {
  criterion: (question) => `On te donne un lieu. Question : ce lieu ${question} ?
Cherche sur le web (site ou carte du lieu, fiches, avis récents).
Prends le critère au sens strict : un produit voisin ne compte pas (des crevettes ou des calamars ne sont pas du poisson ; un plat végétarien n'est pas forcément vegan).
- confirmed : une source le dit pour ce lieu. note : la preuve en quelques mots avec la source (« Poisson au menu selon la carte du restaurant »).
- no : une source montre clairement que non (carte sans aucun plat de ce genre, lieu végétarien…). note : la raison en quelques mots.
- unknown : rien de clair. note : vide.
N'invente rien. Sans lien ni markdown.`,
  reputation: () => `On te donne un lieu. Question : ce lieu est-il recommandé (cité par un guide ou la presse, ou très bien considéré dans de nombreux avis) ?
Cherche sur le web.
- recommended : oui. note : en quelques mots, par qui ou pourquoi (« Recommandé par le Guide du Routard »).
- no : rien de tel. note : vide.
N'invente rien. Sans lien ni markdown.`,
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};

export function createVerifier({ apiKey, metrics }) {
  // check : { kind, question, label } ; label : le critère en un ou deux mots, pour la mention
  // « à vérifier » (« Poisson »)
  async function checkOne(place, { kind, question, label }) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: "low" },
        instructions: INSTRUCTIONS[kind](question) + MENU_NOTE,
        input: `Lieu : ${place.name}, ${place.address || ""}`,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"], // pages consultées : pour contrôler l'adresse de la preuve
        text: { format: { type: "json_schema", name: "check", strict: true, schema: SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`vérification ${response.status}`);
    const data = await response.json();
    metrics?.backendUsage?.(data.usage);
    const searches = (data.output || []).filter((o) => o.type === "web_search_call").length;
    for (let i = 0; i < searches; i++) metrics?.count?.("web_search");
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    const out = JSON.parse(text || "{}");
    const note = out.answer === "unknown"
      ? `${label} non confirmé, à vérifier sur place`
      : String(out.note || "")
        .replace(/\(?\[([^\]]*)\]\([^)]*\)\)?/g, "$1") // lien markdown → son texte
        .replace(/https?:\/\/\S+/g, "")
        .replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
    // Plats et régimes relevés au passage (menus) : noms courts, sans doublon
    const clean = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
    const seen = new Set();
    const dishes = (Array.isArray(out.dishes) ? out.dishes : [])
      .map((d) => ({ name: clean(d?.name, 60).toLowerCase(), group: clean(d?.group, 30) || null }))
      .filter((d) => d.name && !seen.has(d.name) && seen.add(d.name))
      .slice(0, 60);
    const diets = (Array.isArray(out.diets) ? out.diets : []).filter((d) => DIETS.includes(d));
    const menu = dishes.length || diets.length ? { dishes, diets, source: out.menu_source === "aucune" ? null : out.menu_source } : null;
    // Nom lu sur les sources web du lieu (pas celui de Google) : gardé avec son menu
    const webName = String(out.web_name || "").replace(/\s+/g, " ").trim().slice(0, 120) || null;
    // Source de la preuve : l'adresse donnée par le modèle, gardée seulement si son site fait partie des
    // pages que la recherche web a réellement consultées (ou si la recherche ne les liste pas)
    const consulted = (data.output || []).filter((o) => o.type === "web_search_call").flatMap((o) => o.action?.sources || [])
      .map((s) => hostOf(s.url)).filter(Boolean);
    const given = /^https?:\/\/\S+$/.test(out.source_url || "") ? out.source_url : null;
    const sourceUrl = given && (!consulted.length || consulted.includes(hostOf(given))) ? given : null;
    return { answer: out.answer, note, menu, webName, sourceUrl };
  }

  // Les candidats, dans l'ordre reçu (10 au plus) : { answer, note, menu } pour chacun ; une
  // vérification en erreur compte comme « inconnu » (critère) ou « non recommandé » (réputation)
  async function verify(places, check) {
    return Promise.all(places.slice(0, MAX_CHECKED).map((place) => checkOne(place, check).catch((err) => {
      console.warn(`[vérification] ${place.name} :`, err.message);
      return check.kind === "reputation"
        ? { answer: "no", note: "" }
        : { answer: "unknown", note: `${check.label} non confirmé, à vérifier sur place` };
    })));
  }

  return { verify };
}
