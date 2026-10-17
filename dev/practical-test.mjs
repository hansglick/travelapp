// Test des infos pratiques sans l'appli : météo d'un point et guides de conversation de quelques pays
// Usage : node --env-file=.env dev/practical-test.mjs [pays,pays,…]
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createPractical } from "../agent/practical.mjs";

// Clé OpenAI : comme le serveur (OPENAI_API_KEY, ou le fichier indiqué par OPENAI_ENV_FILE)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fromFile = (path) => readFileSync(path, "utf8").match(/^OPENAI_API_KEY=(.*)$/m)?.[1]?.trim();
const apiKey = process.env.OPENAI_API_KEY || (process.env.OPENAI_ENV_FILE && fromFile(resolve(root, process.env.OPENAI_ENV_FILE)));
const mem = new Map();
const practical = createPractical({ apiKey, storage: { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) } });
const w = await practical.weather({ lat: 35.2386, lng: 25.1597 }).catch((err) => (console.log("météo :", err.message), null));
if (w) console.log(w.timezone, w.points.map((p) => `${p.label} ${p.time.slice(11)} ${p.temperature}° ${p.sky}, pluie ${p.rain_probability}% ${p.rain_mm} mm, vent ${p.wind_kmh} km/h ${p.wind_from}`).join(" | "));
const countries = (process.argv[2] || "Grèce,Israël,Espagne,France,Suisse").split(",");
await Promise.all(countries.map(async (c) => {
  const b = await practical.phrasebook(c);
  console.log(`\n${c} → ${b.language || "aucun guide"}${b.phrases.length ? "\n  " + b.phrases.map((p) => `${p.fr} = ${p.local}`).join("\n  ") : ""}`);
}));
