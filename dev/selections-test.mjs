// Test des sélections sans navigateur (QFO_DEV=1) : crée une sélection, envoie des messages écrits,
// puis affiche les filtres, le fil et les restaurants de la sélection.
// Usage : node dev/selections-test.mjs '["je cherche un fastfood","10 minutes"]' [attente finale en s]
const BASE = "http://localhost:8000";
const H = { Origin: BASE, "Content-Type": "application/json" };
const pseudo = process.env.TEST_PSEUDO || "testeur6", pin = process.env.TEST_PIN || "0000";
await fetch(BASE + "/api/auth/register", { method: "POST", headers: H, body: JSON.stringify({ invite: "DEV", pseudo, pin }) });
const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: H, body: JSON.stringify({ pseudo, pin }) });
if (!login.ok) throw new Error(`connexion impossible : ${login.status}`);
H.Cookie = login.headers.get("set-cookie").split(";")[0];
const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) }).then((r) => r.json());

if (process.env.RESET !== "0") await post("/api/reset", {});
const [lat, lng] = (process.env.TEST_POS || "48.8164,2.3285").split(",").map(Number);
await post("/api/context", { position: { lat, lng }, timezone: "Europe/Paris" });

// Dernier état envoyé par le serveur (premier message du flux)
async function state() {
  const res = await fetch(BASE + "/api/events", { headers: { Cookie: H.Cookie } });
  const reader = res.body.getReader();
  let buf = "";
  for (;;) {
    const { value } = await reader.read();
    buf += new TextDecoder().decode(value);
    const m = buf.match(/data: (.*)\n\n/);
    if (m) { reader.cancel(); return JSON.parse(m[1]); }
  }
}

function show(s, id) {
  const sel = s.selections.find((x) => x.id === id);
  console.log(`\n== ${sel.title} (${sel.id})${sel.busy ? " [occupée]" : ""}`);
  console.log("filtres :", sel.filters.map((f) => `${f.enabled ? "☑" : "☐"} ${f.label}`).join("  "));
  for (const m of sel.messages) console.log(`  [${m.type || "?"}] ${m.user ? `« ${m.user} » → ` : m.note ? `(${m.note}) → ` : ""}${m.reply ?? "…"}`);
  const pois = s.pois.filter((p) => p.task_id === id);
  console.log(`restaurants (${pois.length}) :`, pois.map((p) => `n°${p.map_number} ${p.place?.name}${p.check ? ` [${p.check.status}]` : ""}`).join(" | "));
  if (sel.removed.length) console.log("retirés :", sel.removed.map((r) => `${r.name || r.placeId.slice(-6)} (${r.reason})`).join(" | "));
}

const { id } = await post("/api/selections", {});
for (const text of JSON.parse(process.argv[2] || "[]")) {
  if (text === "+") {
    // « + » : bouton « Continuer la recherche » (attend qu'il soit allumé, 5 min au plus)
    for (let i = 0; i < 60 && !(await state()).selections.find((x) => x.id === id).canContinue; i++) await new Promise((r) => setTimeout(r, 5000));
    console.log("\n>>> Continuer la recherche");
    console.log(await post("/api/selections/continue", { id }));
  } else if (text.startsWith("!")) {
    // « !Gyros » : décoche (ou recoche) le filtre de ce nom
    const sel = (await state()).selections.find((x) => x.id === id);
    const f = sel.filters.find((x) => x.label === text.slice(1));
    console.log(`\n>>> case « ${text.slice(1)} » ${f?.enabled ? "décochée" : "cochée"}`);
    await post("/api/selections/filter", { id, filterId: f.id, enabled: !f.enabled });
  } else {
    console.log(`\n>>> ${text}`);
    await post("/api/selections/message", { id, text });
  }
  show(await state(), id);
}
const wait = Number(process.argv[3]) || 0;
if (wait) {
  await new Promise((r) => setTimeout(r, wait * 1000));
  console.log(`\n--- après ${wait} s`);
  show(await state(), id);
}
// REFLECTION=1 : la « Réflexion » de chaque demande de recherche, résumée
if (process.env.REFLECTION === "1") {
  const sel = (await state()).selections.find((x) => x.id === id);
  for (const m of sel.messages.filter((x) => x.type === "search" && x.user)) {
    const r = await fetch(`${BASE}/api/selections/reflection?id=${id}&message=${m.id}`, { headers: { Cookie: H.Cookie } }).then((x) => x.json());
    const f = r.reflection;
    if (!f) continue;
    console.log(`\n### Réflexion de « ${m.user} »`);
    f.understood.forEach((l) => console.log("  compris :", l));
    const s = f.search;
    if (s?.mode === "dish") console.log("  plat :", s.trace.dish, "|", s.trace.country, "| blocs :", [...new Set(s.trace.steps.map((x) => x.block))].join(","), "| types :", s.trace.steps.map((x) => x.type).join(", "));
    else if (s) console.log("  recherche :", s.mode, s.trace?.family?.join(", ") || s.count || "");
    f.widenings.forEach((w, i) => console.log(`  rattrapage ${i + 1} : ${w.reason} → blocs ${[...new Set(w.trace.steps.map((x) => x.block))].join(",")} (${w.trace.steps.map((x) => x.type).join(", ")}), ${w.added} ajoutés`));
    const by = {};
    f.checks.forEach((c) => { by[c.source] = (by[c.source] || 0) + 1; });
    console.log("  vérifications :", JSON.stringify(by));
  }
}
process.exit(0);
