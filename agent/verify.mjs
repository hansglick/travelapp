// Vérification sur le web des candidats trouvés par Google (canal mixte) : une seule question par
// lieu, toutes en parallèle (10 lieux au plus).
// - criterion : un critère concret (« sert du poisson », « propose des plats sans gluten ») →
//   confirmed (une source le dit), unknown (rien trouvé) ou no (le web montre que non : écarté) ;
// - reputation : le lieu est-il recommandé (guides, presse, avis très favorables) → recommended ou no.

import { EXTRACTOR_MODEL } from "./prompts.mjs";

export const MAX_CHECKED = 10;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["answer", "note"],
  properties: {
    answer: { type: "string", enum: ["confirmed", "unknown", "no", "recommended"] },
    note: { type: "string", description: "Mention courte affichée dans la bulle, qui cite la source quand il y en a une." },
  },
};

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
        instructions: INSTRUCTIONS[kind](question),
        input: `Lieu : ${place.name}, ${place.address || ""}`,
        tools: [{ type: "web_search" }],
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
    return { answer: out.answer, note };
  }

  // Les candidats, dans l'ordre reçu (10 au plus) : { answer, note } pour chacun ; une vérification
  // en erreur compte comme « inconnu » (critère) ou « non recommandé » (réputation)
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
