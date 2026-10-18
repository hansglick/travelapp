// Test du tableau des tâches sans micro : envoie des prises de parole tapées (QFO_DEV=1), à des
// instants donnés, et affiche l'évolution des tâches et de la liste de lieux.
// Usage : node dev/tasks-test.mjs '[[0,"phrase 1"],[5,"phrase 2"]]' [durée max en s] [reset]
const BASE = "http://localhost:8000";
const H = { Origin: BASE, "Content-Type": "application/json" };
// Compte de test (invitation « DEV », acceptée seulement avec QFO_DEV=1) : TEST_PSEUDO / TEST_PIN
const pseudo = process.env.TEST_PSEUDO || "testeur", pin = process.env.TEST_PIN || "0000";
await fetch(BASE + "/api/auth/register", { method: "POST", headers: H, body: JSON.stringify({ invite: "DEV", pseudo, pin }) });
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ pseudo, pin }) });
if (!login.ok) throw new Error(`connexion du compte de test impossible : ${login.status}`);
H.Cookie = login.headers.get("set-cookie").split(";")[0];
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) });
const steps = JSON.parse(process.argv[2]);
const maxSeconds = Number(process.argv[3]) || 180;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`;

if (process.argv[4] === "reset") await post("/api/reset", {});
// Position de test : TEST_POS="lat,lng" (Réthymnon par défaut)
const [testLat, testLng] = (process.env.TEST_POS || "35.37,24.4715").split(",").map(Number);
await post("/api/context", { position: { lat: testLat, lng: testLng }, timezone: "Europe/Paris" });

let lastTasks = "", lastPois = "", tasks = [];
const res = await fetch(BASE + "/api/events", { headers: { Cookie: H.Cookie } });
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = "";
(async () => {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value);
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (!line.startsWith("data: ")) continue;
      const m = JSON.parse(line.slice(6));
      if (m.type === "tasks") {
        tasks = m.tasks;
        const s = tasks.map((t) => `${t.id}:${t.status}`).reverse().join(" ");
        if (s !== lastTasks) {
          lastTasks = s;
          console.log(`${at()}  TÂCHES  ${s}`);
        }
      } else if (m.type === "state") {
        const s = m.pois.map((p) => `${p.map_number ? `${p.map_number}.` : ""}${p.place?.name || p.name}[${p.status[0]}]`).join(", ");
        if (s !== lastPois) {
          lastPois = s;
          console.log(`${at()}  CARTE   ${s || "(vide)"}`);
        }
      }
    }
  }
})();

for (const [delay, text] of steps) {
  while ((Date.now() - t0) / 1000 < delay) await new Promise((r) => setTimeout(r, 200));
  console.log(`${at()}  >>> ${text}`);
  post("/api/dev/say", { text });
}
const busy = () => tasks.some((t) => ["pending", "running"].includes(t.status));
await new Promise((r) => setTimeout(r, 4000));
// Attend que les tâches existent (la détection peut prendre plusieurs secondes) puis qu'elles finissent
while ((!tasks.length || busy()) && (Date.now() - t0) / 1000 < maxSeconds) await new Promise((r) => setTimeout(r, 500));
console.log("\n=== Tableau final ===");
for (const t of [...tasks].reverse()) {
  const d = t.startedAt ? `${Math.round(((t.endedAt || Date.now()) - t.startedAt) / 1000)} s` : "-";
  const goal = t.requestedCount ? `, ${t.placedCount}/${t.requestedCount} lieux` : "";
  console.log(`\n${t.id} [${t.status}, ${t.kind}, ${d}${goal}] ${t.title}${t.replaces ? ` (${t.extends ? "complète" : "remplace"} ${t.replaces})` : ""}`);
  console.log(`   entendu : ${t.utterance}`);
  console.log(`   compris : ${t.request}`);
  if (t.criteria?.length) console.log(`   critères : ${t.criteria.map((c) => `${c.value} [${c.type}${c.strict ? ", strict" : ""}]`).join(" · ")}${t.maxDistanceM ? ` · ≤ ${t.maxDistanceM} m` : ""}`);
  for (const a of t.actions) console.log(`   - ${a.text}`);
  if (t.result) console.log(`   → ${t.result}`);
}
process.exit(0);
