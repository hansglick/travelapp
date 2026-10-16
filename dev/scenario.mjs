// Joue une suite de demandes tapées contre le serveur local (QFO_DEV=1) et affiche l'état après chacune.
import { readFileSync } from "node:fs";

const BASE = "http://localhost:8000";
const LOG = process.argv[2];
const steps = JSON.parse(process.argv[3]);
const offer = readFileSync(new URL("./offer.json", import.meta.url), "utf8");
const H = { Origin: BASE, "Content-Type": "application/json" };
const post = (path, body) => fetch(BASE + path, { method: "POST", headers: H, body: typeof body === "string" ? body : JSON.stringify(body) });
const answers = () => (readFileSync(LOG, "utf8").match(/\[backend →  guide\].*/g) || []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function state() {
  const res = await fetch(BASE + "/api/events");
  const reader = res.body.getReader();
  const { value } = await reader.read();
  reader.cancel();
  return JSON.parse(new TextDecoder().decode(value).split("\n")[0].slice(6));
}

async function newSession() {
  const r = await post("/api/live/session", offer);
  console.log("  (nouvelle session", r.status, ")");
  await wait(1500);
}

if (process.argv[4] === "reset") await post("/api/reset", {});
await post("/api/context", { position: { lat: 35.37, lng: 24.4715 }, timezone: "Europe/Athens" });
await wait(1500);
await newSession();
for (const text of steps) {
  if (text === "NEW") { await post("/api/live/close", {}); await wait(1500); await newSession(); continue; }
  if (text.startsWith("UI:exclude:")) {
    const s = await state();
    const poi = s.pois[Number(text.split(":")[2])];
    await post("/api/pois/update", { id: poi.id, included: false });
    console.log(`\n### (écran) décoche ${poi.place?.name || poi.name}`);
    await wait(2000);
    continue;
  }
  const before = answers().length;
  let r = await post("/api/dev/say", { text });
  if (r.status === 409) { await newSession(); r = await post("/api/dev/say", { text }); }
  console.log(`\n>>> ${text}`);
  const t = Date.now();
  while (answers().length === before && Date.now() - t < 90000) await wait(1000);
  await wait(3000); // résolutions tardives
  console.log("  guide :", answers().at(-1)?.replace("[backend →  guide] ", ""), `(${Math.round((Date.now() - t) / 1000)} s)`);
  const s = await state();
  console.log(`  v${s.version} prefs exclues=[${s.preferences.excluded_categories}] max_walk=${s.preferences.max_walk_minutes}`);
  for (const p of s.pois) console.log(`   - n°${p.map_number ?? "-"} ${p.id} ${p.status.padEnd(9)} ${p.category.padEnd(10)} ${p.place?.name || p.name}${p.included ? "" : " (décoché)"}${p.pin ? " 🔒" + (p.pin.position === "index" ? p.pin.index : p.pin.position) : ""}`);
}
await post("/api/live/close", {});
