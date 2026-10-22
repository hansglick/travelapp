// Guide écrit (conversation par texte) : une réponse courte aux messages qui ne sont pas des demandes
// (salutations, remerciements, « tu en es où ? »), et le message d'accueil. Les demandes passent par le
// tableau des tâches, comme à l'oral.

import { TEXT_GUIDE_MODEL, TEXT_GUIDE_INSTRUCTIONS } from "./prompts.mjs";

export function createTextGuide({ apiKey, metrics }) {
  // input : contexte, état des tâches, fin de la conversation et message à traiter, en texte
  async function reply(input) {
    const started = Date.now();
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: TEXT_GUIDE_MODEL,
        reasoning: { effort: "none" },
        service_tier: "priority", // réponse rapide, pour un coût négligeable
        instructions: TEXT_GUIDE_INSTRUCTIONS,
        input,
        store: false,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`guide écrit ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    metrics?.backendUsage?.(data.usage);
    metrics?.time?.("text_reply_ms", Date.now() - started);
    const text = (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");
    return text.replace(/\s+/g, " ").trim().slice(0, 600);
  }

  return { reply };
}
