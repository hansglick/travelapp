// Sélections de restaurants (chat écrit). L'utilisateur crée une sélection, puis écrit dedans : le
// modèle classe chaque message (recherche, ajout nommé, suppression, question, hors sujet, échange)
// et l'application applique.
//
// Une sélection = les résultats de sa recherche Google filtrés + ses ajouts manuels − ses retraits
// manuels. Filtres (cases à cocher) :
// - distance : toujours là, se modifie mais ne se décoche pas ;
// - périmètre : type de restaurant (cuisine) et plat : ils décident de ce que Google cherche ; les
//   changer relance la recherche ;
// - vérifiés sur le web : le plat et les critères (terrasse, végétarien…), base des menus d'abord ;
//   un « non » retire le restaurant (écran « Restaurants retirés »), un doute le grise, tout
//   confirmé lui donne la bague verte ; décocher fait revenir ceux qu'il avait retirés ;
// - Google : ouvert maintenant, bien noté, pas cher (données de la recherche).
// Un ajout manuel n'est jamais retiré par un filtre ; un retrait manuel est définitif pour la
// sélection (le restaurant revient seulement si on le rajoute en le nommant).

import {
  SELECTION_MODEL, SELECTION_INSTRUCTIONS, SELECTION_SCHEMA, SELECTION_ANSWER_INSTRUCTIONS,
} from "./prompts.mjs";
import { FOOD_TYPES, familyOf } from "./google-types.mjs";

const API = "https://api.openai.com/v1/responses";
const MAX_RESULTS = Number(process.env.SELECTION_MAX_RESULTS) || 30; // restaurants de la recherche dans une sélection (réglage de test)
const VERIFY_BATCH = 5;          // vérifications web en même temps
const MESSAGES_KEEP = 80;        // demandes gardées par sélection
const WALK_M_PER_MIN = 80;
const CHEAP_LEVELS = ["PRICE_LEVEL_FREE", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"];
const DISH_MODE_QUESTION = "Les deux dans le même restaurant, ou l'un ou l'autre ?";
const MAX_DISHES = 2;
const DISTANCE_QUESTION = "Jusqu'à combien de minutes à pied ? Par exemple 5, 10 ou 15 minutes.";
// Recherche par plat : un bloc de types à la fois ; l'utilisateur demande le suivant (« Continuer la
// recherche ») tant qu'il en reste et que la sélection compte moins de 60 restaurants
const MAX_SHOWN = 60;
const CHECK_LOG_KEEP = 500;      // vérifications gardées pour la « Réflexion »
// Plat « évident » pour le type principal du lieu (une pizza dans une pizzeria) : confirmé sans
// vérification web
const OBVIOUS_P = 0.9;
const OFFSCOPE_REPLY = "Pour l'instant, je ne m'occupe que des restaurants : cafés, bars, fast-foods et tous les lieux où l'on mange ou boit sur place.";

const plain = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clip = (s, max) => String(s || "").replace(/\s+/g, " ").trim().slice(0, max);
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export function createSelections({ apiKey, store, tools, resolvePoi, verifier, menus, dishes, metrics }) {
  const byId = (id) => store.selections.find((s) => s.id === id) || null;
  const poisOf = (sel) => [...store.pois.values()].filter((p) => p.taskId === sel.id);

  // ---- Création ----

  function create() {
    const sel = {
      id: `s${store.nextSelection++}`, title: "Nouvelle sélection", colorIndex: store.nextSelectionColor++,
      createdAt: Date.now(), filters: [], manualAdds: [], manualRemoved: [], verdicts: {}, messages: [],
      pendingQuestion: null, nextFilter: 1, nextMessage: 1,
    };
    store.selections.push(sel);
    store.touchSelections();
    return sel;
  }

  // ---- Message écrit dans une sélection ----

  async function message(id, text) {
    const sel = byId(id);
    if (!sel) return { error: "Sélection introuvable." };
    const msg = { id: `m${sel.nextMessage++}`, type: null, user: clip(text, 500), reply: null, at: Date.now(), pending: true };
    sel.messages.push(msg);
    if (sel.messages.length > MESSAGES_KEEP) sel.messages.shift();
    store.touchSelections();
    try {
      const out = await interpret(sel, msg.user);
      msg.type = out.type;
      if (out.type === "offscope") msg.reply = OFFSCOPE_REPLY;
      else if (out.type === "chat") msg.reply = clip(out.reply, 300) || "Avec plaisir !";
      else if (out.type === "add") msg.reply = await addNamed(sel, out.add_names);
      else if (out.type === "remove") msg.reply = removeNumbers(sel, out.remove_numbers);
      else if (out.type === "question") msg.reply = await answer(sel, msg.user, out);
      else {
        reflect(sel, msg, understood(out));
        msg.reply = await applySearch(sel, out);
      }
    } catch (err) {
      console.warn(`[sélection ${sel.id}]`, err.message);
      msg.reply = "Je n'ai pas pu traiter ce message, pouvez-vous reformuler ?";
    }
    msg.pending = false;
    console.log(`[sélection ${sel.id}] ${msg.type || "?"} : « ${msg.user} » → ${msg.reply}`);
    store.touchSelections();
    return { ok: true };
  }

  // Le modèle classe le message et en extrait les changements
  async function interpret(sel, text) {
    const list = poisOf(sel).map((p) => `n° ${p.number} ${p.place?.name || p.name}${p.place?.types?.[0] ? ` (${p.place.types[0]})` : ""}`);
    const input = [
      `Filtres actuels : ${sel.filters.length ? sel.filters.map(describeFilter).join(" ; ") : "aucun (nouvelle sélection)"}.`,
      `Restaurants de la sélection : ${list.join(" ; ") || "aucun"}.`,
      `Question en attente : ${sel.pendingQuestion === "distance" ? DISTANCE_QUESTION : sel.pendingQuestion === "dishmode" ? DISH_MODE_QUESTION : "aucune"}.`,
      "Derniers échanges :", sel.messages.slice(-7, -1).map((m) => `Utilisateur : ${m.user}\nApplication : ${m.reply || "…"}`).join("\n") || "(début)",
      `Nouveau message : ${text}`,
    ].join("\n");
    const data = await callModel({
      model: SELECTION_MODEL, reasoning: { effort: "low" }, service_tier: "priority",
      instructions: SELECTION_INSTRUCTIONS, input,
      text: { format: { type: "json_schema", name: "selection_message", strict: true, schema: SELECTION_SCHEMA } },
    });
    return JSON.parse(outputText(data) || "{}");
  }

  // ---- Réflexion : la logique suivie pour une demande (en mémoire seulement) ----
  // understood : ce que le modèle a compris ; search : la recherche Google (par plat, par type, ou
  // pas de nouvelle recherche) ; widenings : les rattrapages ; les vérifications sont dans _checkLog

  function reflect(sel, msg, lines) {
    (sel._reflections ||= new Map()).set(msg.id, { understood: lines, search: null, widenings: [] });
    sel._reflecting = msg.id;
  }

  const currentReflection = (sel) => sel._reflections?.get(sel._reflecting) || null;

  // Ce que le modèle a compris du message, en clair
  function understood(out) {
    const lines = [];
    const cuisine = out.cuisine || {};
    if (cuisine.action === "set") {
      const types = cuisine.types || [];
      const family = [...new Set(types.flatMap(familyOf))];
      lines.push(`Type de lieu : « ${cuisine.label} » → types Google ${types.join(", ")}${family.length > types.length ? ` (famille cherchée : ${family.join(", ")})` : ""} ; formulations : ${(cuisine.words || []).map((w) => `« ${w} »`).join(", ")}`);
    } else if (cuisine.action === "remove") lines.push("Type de lieu retiré : tous les lieux où l'on mange ou boit");
    const d = out.dishes || {};
    const names = (d.names || []).map((n) => `« ${n} »`).join(" et ");
    if (d.action === "set") lines.push(`Plat${(d.names || []).length > 1 ? "s" : ""} : ${names}`);
    else if (d.action === "add") lines.push(`Plat ajouté : ${names}`);
    else if (d.action === "remove") lines.push(names ? `Plat retiré : ${names}` : "Plats retirés");
    if (d.mode === "and") lines.push("Deux plats : les deux dans le même restaurant");
    if (d.mode === "or") lines.push("Deux plats : l'un ou l'autre");
    if (d.mode === "ask") lines.push("Deux plats : la question « les deux, ou l'un ou l'autre ? » est posée");
    for (const c of out.add_checks || []) lines.push(`Critère vérifié sur le web : « ${c.label} » (${c.question})`);
    for (const label of out.remove_checks || []) lines.push(`Critère retiré : « ${label} »`);
    if (Number.isInteger(out.distance_minutes)) lines.push(`Distance : ${out.distance_minutes} min à pied (${out.distance_minutes * WALK_M_PER_MIN} m à vol d'oiseau)`);
    const onOff = { on: "oui", off: "non" };
    if (onOff[out.open_now]) lines.push(`Ouvert maintenant : ${onOff[out.open_now]}`);
    if (onOff[out.top_rated]) lines.push(`Bien noté (4,2 et plus) : ${onOff[out.top_rated]}`);
    if (onOff[out.cheap]) lines.push(`Pas cher : ${onOff[out.cheap]}`);
    return lines.length ? lines : ["Aucun filtre modifié"];
  }

  function logCheck(sel, c, label, source, status, note) {
    (sel._checkLog ||= []).push({ id: c.place.placeId, name: c.place.name, label, source, status, note: clip(note, 200), at: Date.now() });
    if (sel._checkLog.length > CHECK_LOG_KEEP) sel._checkLog.shift();
  }

  // La réflexion d'une demande, pour la page : les vérifications faites entre elle et la suivante
  function reflection(id, msgId) {
    const sel = byId(id);
    const r = sel?._reflections?.get(msgId);
    if (!r) return null;
    const idx = sel.messages.findIndex((m) => m.id === msgId);
    const msg = sel.messages[idx];
    const next = sel.messages.slice(idx + 1).find((m) => sel._reflections.has(m.id));
    const checks = (sel._checkLog || []).filter((e) => e.at >= (msg?.at || 0) && (!next || e.at < next.at));
    return { understood: r.understood, search: r.search, widenings: r.widenings, checks, busy: Boolean(sel._busy || sel._verifying) };
  }

  function describeFilter(f) {
    const state = f.enabled ? "" : " (décoché)";
    if (f.kind === "distance") return `distance ${f.minutes} min`;
    if (f.kind === "cuisine") return `type « ${f.label} » [${f.types.join(", ")}]${state}`;
    if (f.kind === "dish") return `plat « ${f.label} »${state}`;
    if (f.kind === "dishmode") return `deux plats : ${f.mode === "or" ? "l'un ou l'autre" : "les deux au même endroit"}`;
    if (f.kind === "check") return `critère « ${f.label} » (${f.question})${state}`;
    return `${f.label}${state}`;
  }

  // ---- Recherche : changements de filtres ----

  async function applySearch(sel, out) {
    const filter = (kind) => sel.filters.find((f) => f.kind === kind);
    const add = (f) => sel.filters.push({ id: `f${sel.nextFilter++}`, enabled: true, ...f });
    const drop = (f) => { sel.filters = sel.filters.filter((x) => x !== f); };
    // Type de restaurant
    if (out.cuisine?.action === "set" && out.cuisine.types?.length) {
      const types = out.cuisine.types.filter((t) => FOOD_TYPES.includes(t)).slice(0, 4);
      const value = { label: clip(capital(out.cuisine.label), 40) || "Restaurant", types, words: (out.cuisine.words || []).map((w) => clip(w, 60)).filter(Boolean).slice(0, 3) };
      if (!value.words.length) value.words = [value.label.toLowerCase()];
      const old = filter("cuisine");
      if (old) Object.assign(old, value, { enabled: true });
      else add({ kind: "cuisine", ...value });
    } else if (out.cuisine?.action === "remove" && filter("cuisine")) drop(filter("cuisine"));
    // Plat
    // Plats : deux au plus (« A », « A et B », « A ou B »)
    const d = out.dishes || {};
    const names = [...new Set((d.names || []).map((n) => clip(n, 40).toLowerCase()).filter(Boolean))];
    const dishFilters = () => sel.filters.filter((f) => f.kind === "dish");
    let tooMany = false;
    if (d.action === "set" && names.length) {
      dishFilters().forEach(drop);
      names.slice(0, MAX_DISHES).forEach((name) => add({ kind: "dish", dish: name, label: capital(name) }));
      tooMany = names.length > MAX_DISHES;
    } else if (d.action === "add" && names.length) {
      for (const name of names) {
        const old = dishFilters().find((f) => f.dish === name);
        if (old) old.enabled = true;
        else if (dishFilters().length < MAX_DISHES) add({ kind: "dish", dish: name, label: capital(name) });
        else tooMany = true;
      }
    } else if (d.action === "remove") {
      dishFilters().filter((f) => !names.length || names.includes(f.dish)).forEach(drop);
    }
    // Deux plats : la case « les deux / l'un ou l'autre » ; un plat ou aucun : pas de case
    const modeFilter = filter("dishmode");
    if (dishFilters().length === MAX_DISHES) {
      const mode = d.mode === "and" || d.mode === "or" ? d.mode : modeFilter?.mode || "and";
      const label = mode === "or" ? "L'un ou l'autre" : "Les deux";
      if (modeFilter) Object.assign(modeFilter, { mode, label });
      else sel.filters.push({ id: "dishmode", kind: "dishmode", mode, label, enabled: true });
      if (d.mode === "ask" && !modeFilter) sel.pendingQuestion = "dishmode";
      else if (sel.pendingQuestion === "dishmode" && (d.mode === "and" || d.mode === "or")) sel.pendingQuestion = null;
    } else if (modeFilter) drop(modeFilter);
    // Critères vérifiés sur le web
    for (const c of out.add_checks || []) {
      const label = clip(capital(c.label), 30);
      if (!label) continue;
      const old = sel.filters.find((f) => f.kind === "check" && plain(f.label) === plain(label));
      if (old) old.enabled = true;
      else add({ kind: "check", label, question: clip(c.question, 120) || `propose : ${label.toLowerCase()}` });
    }
    for (const label of out.remove_checks || []) {
      const old = sel.filters.find((f) => f.kind === "check" && plain(f.label) === plain(label));
      if (old) drop(old);
    }
    // Filtres Google
    const toggle = (kind, label, value) => {
      const old = filter(kind);
      if (value === "on") { if (old) old.enabled = true; else add({ kind, label }); }
      if (value === "off" && old) drop(old);
    };
    toggle("open", "Ouvert maintenant", out.open_now);
    toggle("rating", "Bien noté", out.top_rated);
    toggle("cheap", "Pas cher", out.cheap);
    // Distance : toujours là ; demandée si elle manque
    const minutes = Number.isInteger(out.distance_minutes) && out.distance_minutes > 0 ? Math.min(out.distance_minutes, 90) : null;
    if (minutes) {
      const old = filter("distance");
      if (old) Object.assign(old, { minutes, label: `${minutes} min à pied` });
      else sel.filters.unshift({ id: "distance", kind: "distance", minutes, label: `${minutes} min à pied`, enabled: true });
    }
    sel.title = titleOf(sel);
    const note = tooMany ? `Deux plats au plus : je garde ${dishFilters().map((f) => f.label).join(" et ")}. ` : "";
    if (sel.pendingQuestion === "dishmode") {
      store.touchSelections();
      return `${note}${DISH_MODE_QUESTION}`;
    }
    if (!filter("distance")) {
      sel.pendingQuestion = "distance";
      store.touchSelections();
      return `${note}${DISTANCE_QUESTION}`;
    }
    sel.pendingQuestion = null;
    return `${note}${await refresh(sel)}`;
  }

  function titleOf(sel) {
    const on = (kind) => sel.filters.find((f) => f.kind === kind && f.enabled);
    return [dishLabel(sel), on("cuisine")?.label].filter(Boolean).join(" · ") || "Restaurants";
  }

  // Case d'un filtre touchée : cochée ou décochée (la distance ne se décoche pas)
  async function setFilter(id, filterId, enabled) {
    const sel = byId(id);
    const f = sel?.filters.find((x) => x.id === filterId);
    if (!f || f.kind === "distance") return { error: "Filtre introuvable." };
    if (f.kind === "dishmode") Object.assign(f, f.mode === "or" ? { mode: "and", label: "Les deux" } : { mode: "or", label: "L'un ou l'autre" });
    else f.enabled = Boolean(enabled);
    sel.title = titleOf(sel);
    const msg = { id: `m${sel.nextMessage++}`, type: "search", user: null, reply: null, at: Date.now(), pending: true, note: f.kind === "dishmode" ? `Filtre changé : ${f.label}` : `${f.enabled ? "Filtre coché" : "Filtre décoché"} : ${f.label}` };
    sel.messages.push(msg);
    reflect(sel, msg, [`Case « ${f.label} » ${f.enabled ? "cochée" : "décochée"}`]);
    store.touchSelections();
    try {
      msg.reply = await refresh(sel);
    } catch (err) {
      console.warn(`[sélection ${sel.id}] filtre :`, err.message);
      msg.reply = "La sélection n'a pas pu être mise à jour.";
    }
    msg.pending = false;
    store.touchSelections();
    return { ok: true };
  }

  // ---- Calcul de la sélection ----

  const enabledFilter = (sel, kind) => sel.filters.find((f) => f.kind === kind && f.enabled) || null;
  // Plats cochés (deux au plus) et leur lien : « and » (les deux au même endroit) ou « or »
  const dishesOf = (sel) => sel.filters.filter((f) => f.kind === "dish" && f.enabled);
  const dishModeOf = (sel) => (dishesOf(sel).length === MAX_DISHES ? sel.filters.find((f) => f.kind === "dishmode")?.mode || "and" : "and");
  const dishLabel = (sel) => dishesOf(sel).map((f) => f.label).join(dishModeOf(sel) === "or" ? " ou " : " + ") || null;
  const perimeterKey = (sel) => JSON.stringify([
    sel.filters.find((f) => f.kind === "distance")?.minutes, enabledFilter(sel, "cuisine")?.types,
    dishesOf(sel).length ? [dishesOf(sel).map((f) => f.dish).sort(), dishModeOf(sel)] : null,
  ]);
  // Critères vérifiés : les plats cochés, puis les critères cochés
  const checksOf = (sel) => [
    ...dishesOf(sel).map((f) => ({ label: f.label, question: `sert du ${f.dish} ou en propose`, dish: f.dish })),
    ...sel.filters.filter((f) => f.kind === "check" && f.enabled).map((f) => ({ label: f.label, question: f.question, dish: null })),
  ];

  // Recalcule la sélection ; relance Google si le périmètre a changé (ou si les résultats ne sont plus
  // en mémoire et qu'on élargit). Renvoie le résumé affiché dans le fil.
  async function refresh(sel, { allowSearch = true } = {}) {
    const position = store.context.position;
    if (!position) return "Ta position n'est pas encore connue : choisis d'abord ton point de départ.";
    sel._busy = true;
    store.touchSelections();
    try {
      if (allowSearch && (!sel._candidates || sel._partial || sel._perimeter !== perimeterKey(sel))) {
        // Élargir (filtre de périmètre retiré, distance plus grande) garde les restaurants d'avant :
        // la nouvelle recherche s'y ajoute, jamais ne les remplace
        const previous = widening(sel._perimeter, perimeterKey(sel)) ? sel._candidates : null;
        await search(sel, position);
        const limitM = sel.filters.find((f) => f.kind === "distance").minutes * WALK_M_PER_MIN;
        for (const [pid, c] of previous || []) {
          if (!sel._candidates.has(pid) && (c.distance_from_user_m == null || c.distance_from_user_m <= limitM)) sel._candidates.set(pid, c);
        }
        const refl = currentReflection(sel);
        if (previous && refl?.search) refl.search.kept = `élargissement : les ${previous.size} lieux d'avant sont gardés`;
      } else if (currentReflection(sel)) {
        currentReflection(sel).search = { mode: "reused", count: sel._candidates?.size || 0 };
      }
      await loadDishProbabilities(sel);
      const summary = apply(sel);
      // Rien à vérifier sur le web (tout est déjà tranché) : le bilan du bloc tout de suite
      if (!sel._verifying) blockReport(sel);
      return summary;
    } finally {
      sel._busy = false;
    }
  }

  // Le nouveau périmètre contient l'ancien : distance égale ou plus grande, type et plat inchangés
  // ou retirés (jamais un autre type ni un autre plat)
  function widening(before, after) {
    if (!before) return false;
    const [m0, types0, dish0] = JSON.parse(before);
    const [m1, types1, dish1] = JSON.parse(after);
    const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    return m1 >= m0 && (types1 == null || same(types0, types1)) && (dish1 == null || same(dish0, dish1)) && before !== after;
  }

  async function search(sel, position) {
    const minutes = sel.filters.find((f) => f.kind === "distance").minutes;
    const limitM = minutes * WALK_M_PER_MIN;
    const cuisine = enabledFilter(sel, "cuisine");
    const removed = new Set(sel.manualRemoved.map((r) => r.placeId));
    // Type coché : recherche par type (les plats éventuels sont vérifiés ensuite) ; plats seuls :
    // recherche par plat ; ni l'un ni l'autre : tous les restaurants
    const g = !cuisine && dishesOf(sel).length ? await dishSearchParams(sel) : {
      types: cuisine ? cuisine.types : ["restaurant"],
      words: cuisine ? cuisine.words : ["restaurant", "restaurants"],
      dish: null, category: "restaurant", openNow: false, minRating: null, cheap: false, check: null, ignored: [],
    };
    const refl = currentReflection(sel);
    if (refl) refl.search = { mode: g.dish ? "dish" : "types", trace: null };
    sel.dishNext = null;
    sel.canContinue = false;
    sel._block = null;
    sel._dishMsg = g.dish ? sel._reflecting : null;
    let blockTypes = [];
    const task = {
      id: sel.id, title: sel.title, maxDistanceM: limitM,
      log: (text) => console.log(`[sélection ${sel.id}] ${text}`),
      // Réflexion : la recherche par plat (distribution, blocs), ou par type (famille, rangs)
      setDishTrace: (trace) => {
        if (refl) refl.search = { mode: "dish", trace };
        blockTypes = (trace.steps || []).map((s) => s.type);
      },
      setTypeTrace: (trace) => { if (refl) refl.search = { mode: "types", trace, dishTrace: refl.search?.mode === "dish" ? refl.search.trace : null }; },
      setDishProgress: ({ nextType, typeCount }) => { sel.dishNext = nextType; sel.dishTotal = typeCount; },
      ensureColor: () => sel.colorIndex,
    };
    const area = {
      anchors: [{ name: "l'utilisateur", location: position }], radius: Math.min(Math.max(limitM, 300), 10000), position, limitM,
      goal: MAX_RESULTS, keep: (c) => !removed.has(c.place.placeId), onMap: new Set(),
    };
    // Plat : le premier bloc seul, pour montrer des résultats tout de suite
    const byDish = g.dish ? await tools.searchDish(task, g, area, { blocks: 1 }) : null;
    const found = byDish || await tools.searchTypes(task, g, area);
    sel._candidates = new Map(found.filter((c) => !removed.has(c.place.placeId)).slice(0, MAX_RESULTS).map((c) => [c.place.placeId, c]));
    if (byDish) {
      sel.dishBlock = 1;
      sel._block = { types: blockTypes, places: new Set(sel._candidates.keys()) };
    }
    sel._perimeter = perimeterKey(sel);
    sel._partial = false;
  }

  // Sélection supprimée (carte effacée) : ses vérifications en cours ne touchent plus la carte
  const gone = (sel) => !store.selections.includes(sel);

  // Applique filtres, verdicts, ajouts et retraits ; met la carte à jour ; lance les vérifications
  function apply(sel) {
    if (gone(sel)) return "";
    const checks = checksOf(sel);
    const removed = new Set(sel.manualRemoved.map((r) => r.placeId));
    const manual = new Map(sel.manualAdds.map((m) => [m.placeId, m]));
    const googleOk = (c) => (!enabledFilter(sel, "open") || c.place.openNow !== false)
      && (!enabledFilter(sel, "rating") || (c.place.rating ?? 0) >= 4.2)
      && (!enabledFilter(sel, "cheap") || !c.place.priceLevel || CHEAP_LEVELS.includes(c.place.priceLevel));
    const want = new Map(); // placeId → { c, check, manual }
    const retired = [];
    const pending = [];
    const consider = (c, isManual) => {
      const pid = c.place.placeId;
      if (!isManual && (removed.has(pid) || !googleOk(c))) return;
      // Verdict de chaque critère : déjà connu pour cette sélection, sinon la base des menus
      const states = checks.map((ck) => {
        const key = plain(ck.label);
        let v = sel.verdicts[pid]?.[key];
        if (!v) {
          const known = obvious(sel, c, ck) || tools.menuMatch(pid, { check: { kind: "criterion", label: ck.label }, dish: ck.dish });
          if (known) {
            v = rememberVerdict(sel, pid, key, known.status, known.note);
            logCheck(sel, c, ck.label, known.source.startsWith("évidence") ? known.source : `base des menus : ${known.source}`, known.status, known.note);
          }
        }
        if (!v) pending.push({ c, check: ck });
        return { label: ck.label, status: v?.status || "pending", note: v?.note || "" };
      });
      // Deux plats « l'un ou l'autre » : un seul suffit (confirmé si l'un l'est, retiré si aucun)
      if (dishModeOf(sel) === "or" && dishesOf(sel).length === MAX_DISHES) {
        const dishStates = states.filter((s, i) => checks[i].dish);
        const any = (st) => dishStates.some((s) => s.status === st);
        const status = any("confirmed") ? "confirmed" : dishStates.every((s) => s.status === "rejected") ? "rejected" : any("pending") ? "pending" : "maybe";
        const merged = { label: dishStates.map((s) => s.label).join(" ou "), status, note: dishStates.map((s) => `${s.label} ${s.status === "confirmed" ? "✓" : s.status === "rejected" ? "✗" : "?"}`).join(" · ") };
        states.splice(0, states.length, merged, ...states.filter((s, i) => !checks[i].dish));
      }
      const rejected = states.find((s) => s.status === "rejected");
      if (rejected && !isManual) {
        retired.push({ placeId: pid, name: c.place.name, kind: "filter", filter: rejected.label, reason: rejected.note || `${rejected.label} : non`, at: sel.verdicts[pid]?.[plain(rejected.label)]?.at || Date.now() });
        return;
      }
      want.set(pid, { c, check: combine(states), manual: isManual });
    };
    for (const c of sel._candidates?.values() || []) if (!manual.has(c.place.placeId)) consider(c, false);
    for (const m of sel.manualAdds) {
      const c = sel._manual?.get(m.placeId) || placeOfPoi(sel, m.placeId);
      if (c) consider(c, true);
    }
    // Carte : retirer ce qui n'est plus voulu, ajouter le nouveau, mettre à jour l'analyse du reste
    const current = poisOf(sel);
    store.removePoisQuiet(current.filter((p) => !want.has(p.place?.placeId)).map((p) => p.id));
    const added = [];
    for (const [pid, w] of want) {
      const poi = current.find((p) => p.place?.placeId === pid);
      if (!poi) added.push(store.insertSelectionPoi(sel, w.c, w.check).id);
      else if (JSON.stringify(poi.check || null) !== JSON.stringify(w.check)) store.setPoiCheck(poi.id, w.check);
    }
    if (added.length) tools.attachWalks(added);
    // Retirés : par un filtre (avec sa raison) et à la main
    sel._removed = [
      ...retired,
      ...sel.manualRemoved.map((r) => ({ placeId: r.placeId, name: r.name || sel._names?.get(r.placeId) || null, kind: "manual", filter: null, reason: "Supprimé par toi", at: r.at })),
    ];
    store.touchSelections();
    if (pending.length) verifyInBackground(sel, pending);
    // Résumé
    const shown = want.size;
    const ok = [...want.values()].filter((w) => w.check?.status === "confirmed").length;
    const doubt = [...want.values()].filter((w) => w.check?.status === "maybe").length;
    if (!shown) return "Aucun restaurant ne correspond à ces filtres. Décoche un filtre pour élargir la sélection.";
    const parts = [`${shown} restaurant${shown > 1 ? "s" : ""} dans la sélection`];
    if (checks.length) {
      if (pending.length) parts.push(`vérification en cours : ${checks.map((c) => c.label.toLowerCase()).join(", ")}`);
      else parts.push(`${ok} confirmé${ok > 1 ? "s" : ""}${doubt ? `, ${doubt} à vérifier` : ""}`);
    }
    if (retired.length) parts.push(`${retired.length} retiré${retired.length > 1 ? "s" : ""} par les filtres`);
    return `${parts.join(" · ")}.`;
  }

  // Plusieurs critères : vert si tous confirmés, en cours s'il en reste, grisé s'il y a un doute
  function combine(states) {
    if (!states.length) return null;
    const label = states.map((s) => s.label).join(", ");
    if (states.some((s) => s.status === "pending")) return { status: "pending", label, note: "" };
    if (states.every((s) => s.status === "confirmed")) return { status: "confirmed", label, note: states.map((s) => s.note).filter(Boolean).join(" · ") };
    const doubtful = states.filter((s) => s.status !== "confirmed");
    return { status: "maybe", label, note: doubtful.map((s) => s.note || `${s.label} non confirmé, à vérifier sur place`).join(" · ") };
  }

  // Probabilités de chaque plat coché (plat × pays), pour l'évidence et la recherche : { plat: { type: p } }
  async function loadDishProbabilities(sel) {
    const list = dishesOf(sel);
    if (!list.length || !dishes) {
      sel._probs = null;
      return;
    }
    const country = store.context.place?.country || null;
    const key = JSON.stringify([list.map((f) => f.dish), country]);
    if (sel._probsKey === key) return;
    const maps = await Promise.all(list.map((f) => dishes.distribution(f.dish, country).catch(() => null)));
    sel._probs = Object.fromEntries(list.map((f, i) => [f.dish, maps[i]]));
    sel._probsKey = key;
  }

  // Paramètres de la recherche par plat. Deux plats : une distribution combinée, type par type —
  // « et » : la plus faible des deux (le lieu doit servir les deux), « ou » : la plus forte
  async function dishSearchParams(sel) {
    await loadDishProbabilities(sel);
    const list = dishesOf(sel);
    const names = list.map((f) => f.dish);
    let probabilities = null;
    if (list.length === MAX_DISHES && sel._probs && names.every((n) => sel._probs[n])) {
      const [a, b] = names.map((n) => sel._probs[n]);
      const pick = dishModeOf(sel) === "or" ? Math.max : Math.min;
      probabilities = Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((t) => [t, pick(a[t] || 0, b[t] || 0)]).filter(([, p]) => p > 0));
    }
    return {
      types: ["restaurant"], words: names, dish: dishLabel(sel).toLowerCase(), dishes: names, probabilities,
      category: "restaurant", openNow: false, minRating: null, cheap: false, check: null, ignored: [],
    };
  }

  // Le plat est évident pour le type principal du lieu (au moins 90 % : une pizza dans une pizzeria,
  // des sushis dans un restaurant de sushis) : confirmé sans recherche web ; pas gardé dans la base
  // des menus (ce n'est pas une observation)
  function obvious(sel, c, ck) {
    const p = ck.dish ? sel._probs?.[ck.dish]?.[c.place.primaryType] || 0 : 0;
    if (p < OBVIOUS_P) return null;
    return { status: "confirmed", note: `${ck.label} : évident pour un établissement « ${c.place.primaryType} » (${Math.round(p * 100)} %)`, source: "évidence (type principal du lieu)" };
  }

  function rememberVerdict(sel, pid, key, status, note) {
    const v = { status, note: clip(note, 200), at: Date.now() };
    (sel.verdicts[pid] ||= {})[key] = v;
    return v;
  }

  // Lieu d'un restaurant déjà sur la carte (après un redémarrage, sans résultats en mémoire)
  function placeOfPoi(sel, pid) {
    const poi = poisOf(sel).find((p) => p.place?.placeId === pid);
    return poi ? { place: { ...poi.place, name: poi.place.name || poi.name } } : null;
  }

  // ---- Vérification web en arrière-plan ----

  function verifyInBackground(sel, pending) {
    sel._queue ||= [];
    for (const item of pending) {
      const key = `${item.c.place.placeId}|${plain(item.check.label)}`;
      if (!sel._queue.some((q) => q.key === key) && !sel._inFlight?.has(key)) sel._queue.push({ ...item, key });
    }
    if (sel._verifying || !verifier) return;
    sel._verifying = true;
    sel._done = 0;
    (async () => {
      sel._inFlight = new Set();
      while (sel._queue.length && !gone(sel)) {
        const total = sel._done + sel._queue.length;
        store.setAnalysis(sel.id, { title: sel.title, label: [...new Set(sel._queue.map((q) => q.check.label))].join(", "), total, done: sel._done });
        const batch = sel._queue.splice(0, VERIFY_BATCH);
        batch.forEach((q) => sel._inFlight.add(q.key));
        await Promise.all(batch.map(async ({ c, check, key }) => {
          const [res] = await verifier.verify([c.place], { kind: "criterion", question: check.question, label: check.label });
          const status = res.answer === "confirmed" ? "confirmed" : res.answer === "no" ? "rejected" : "maybe";
          rememberVerdict(sel, c.place.placeId, plain(check.label), status, res.note);
          logCheck(sel, c, check.label, "recherche web", status, res.note);
          // Base commune : plats relevés, régimes, verdict tranché
          const dishes = res.menu?.dishes || [];
          const confirmedDish = check.dish && status === "confirmed" ? check.dish : null;
          const verdict = status === "maybe" ? null : { label: check.label, answer: status === "confirmed" ? "yes" : "no", note: res.note };
          try {
            menus?.add(c.place.placeId, { dishes, diets: res.menu?.diets || [], source: res.menu?.source || null, verdict, name: res.webName, location: c.place.location, confirmedDish, confirmedUrl: res.sourceUrl });
          } catch (err) {
            console.warn("[menus] enregistrement :", err.message);
          }
          sel._inFlight.delete(key);
        }));
        sel._done += batch.length;
        apply(sel); // la carte suit chaque lot
      }
      if (!gone(sel)) store.setAnalysis(sel.id, null);
      sel._verifying = false;
      // Fin : le bilan du bloc de la recherche par plat, sinon un résumé
      const summary = apply(sel);
      if (!blockReport(sel)) {
        sel.messages.push({ id: `m${sel.nextMessage++}`, type: "search", user: null, reply: `Vérification terminée : ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`, at: Date.now(), pending: false, note: null });
        store.touchSelections();
      }
    })().catch((err) => {
      console.warn(`[sélection ${sel.id}] vérification :`, err.message);
      if (!gone(sel)) store.setAnalysis(sel.id, null);
      sel._verifying = false;
    });
  }

  // ---- Recherche par plat, bloc par bloc ----
  // Les restaurants du bloc qui servent le plat : les deux plats (« et »), au moins un (« ou »)
  function serves(sel, pid) {
    const ok = dishesOf(sel).map((f) => sel.verdicts[pid]?.[plain(f.label)]?.status === "confirmed");
    return dishModeOf(sel) === "or" ? ok.some(Boolean) : ok.every(Boolean);
  }

  // Bilan du bloc qui vient d'être vérifié, dans le fil ; allume « Continuer la recherche » s'il reste
  // des types à interroger et de la place. false si aucun bloc n'attendait son bilan.
  function blockReport(sel) {
    const block = sel._block;
    if (!block || block.reported || sel._verifying || gone(sel)) return false;
    block.reported = true;
    const shown = new Set(poisOf(sel).map((p) => p.place?.placeId));
    const ids = [...block.places];
    const ok = ids.filter((pid) => shown.has(pid) && serves(sel, pid)).length;
    const doubt = ids.filter((pid) => shown.has(pid) && !serves(sel, pid)).length;
    const retired = ids.filter((pid) => !shown.has(pid)).length;
    const left = Math.max(0, Math.ceil(((sel.dishTotal || 0) - (sel.dishNext || 0)) / 3));
    sel.canContinue = left > 0 && shown.size < MAX_SHOWN;
    const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;
    const parts = [
      `${plural(ids.length, "restaurant")} trouvé${ids.length > 1 ? "s" : ""} et vérifié${ids.length > 1 ? "s" : ""}`,
      `${ok} propose${ok > 1 ? "nt" : ""} le plat`,
      `${doubt} à vérifier`,
      `${plural(retired, "retiré")}`,
    ];
    const next = !left ? "Plus de types de restaurant à explorer."
      : shown.size >= MAX_SHOWN ? `La sélection compte déjà ${MAX_SHOWN} restaurants.`
      : `${plural(left, "bloc")} restant${left > 1 ? "s" : ""}.`;
    sel.messages.push({
      id: `m${sel.nextMessage++}`, type: "search", user: null, at: Date.now(), pending: false, note: null,
      reply: `Bloc ${sel.dishBlock} (${block.types.join(", ") || "recherche du plat"}) : ${parts.join(" · ")}. ${next}`,
    });
    store.touchSelections();
    return true;
  }

  // « Continuer la recherche » : le bloc de types suivant, puis sa vérification et son bilan
  async function continueSearch(id) {
    const sel = byId(id);
    if (!sel || !sel.canContinue || !dishesOf(sel).length || enabledFilter(sel, "cuisine")) return { error: "Rien à continuer." };
    const position = store.context.position;
    if (!position) return { error: "Position inconnue." };
    sel.canContinue = false;
    sel._busy = true;
    store.touchSelections();
    try {
      const limitM = sel.filters.find((f) => f.kind === "distance").minutes * WALK_M_PER_MIN;
      const removed = new Set(sel.manualRemoved.map((x) => x.placeId));
      const existing = new Set([...(sel._candidates?.keys() || []), ...sel.manualAdds.map((m) => m.placeId)]);
      const trace = { steps: [] };
      const task = {
        id: sel.id, title: sel.title, maxDistanceM: limitM,
        log: (text) => console.log(`[sélection ${sel.id}] bloc suivant : ${text}`),
        setDishTrace: (t) => Object.assign(trace, t),
        setDishProgress: ({ nextType, typeCount }) => { sel.dishNext = nextType; sel.dishTotal = typeCount; },
        ensureColor: () => sel.colorIndex,
      };
      const area = {
        anchors: [{ name: "l'utilisateur", location: position }], radius: Math.min(Math.max(limitM, 300), 10000), position, limitM,
        goal: Infinity, keep: (c) => !removed.has(c.place.placeId) && !existing.has(c.place.placeId), onMap: existing,
      };
      const g = await dishSearchParams(sel);
      const found = await tools.searchDish(task, g, area, { fromType: sel.dishNext || 0, blocks: 1, withName: false }) || [];
      const added = found.slice(0, Math.max(0, MAX_SHOWN - poisOf(sel).length));
      sel._candidates ||= new Map();
      for (const c of added) sel._candidates.set(c.place.placeId, c);
      sel.dishBlock = (sel.dishBlock || 1) + 1;
      sel._block = { types: trace.steps.map((s) => s.type), places: new Set(added.map((c) => c.place.placeId)) };
      sel._reflections?.get(sel._dishMsg)?.widenings.push({ reason: `bloc ${sel.dishBlock}, à ta demande`, trace, added: added.length });
      sel.messages.push({
        id: `m${sel.nextMessage++}`, type: "search", user: null, at: Date.now(), pending: false, note: "Continuer la recherche",
        reply: `Bloc ${sel.dishBlock} : ${sel._block.types.join(", ")} → ${added.length} nouveau${added.length > 1 ? "x" : ""} restaurant${added.length > 1 ? "s" : ""}${added.length ? ", vérification en cours" : ""}.`,
      });
      await loadDishProbabilities(sel);
      apply(sel);
      if (!sel._verifying) blockReport(sel); // rien à vérifier sur le web : bilan tout de suite
      return { ok: true };
    } catch (err) {
      console.warn(`[sélection ${sel.id}] bloc suivant :`, err.message);
      sel.canContinue = true;
      return { error: "La recherche n'a pas pu continuer." };
    } finally {
      sel._busy = false;
      store.touchSelections();
    }
  }

  // ---- Ajout d'un restaurant nommé ----

  async function addNamed(sel, names) {
    const position = store.context.position;
    if (!position) return "Ta position n'est pas encore connue.";
    const list = (names || []).map((n) => clip(n, 80)).filter(Boolean).slice(0, 5);
    if (!list.length) return "Quel restaurant veux-tu ajouter ?";
    const lines = [];
    for (const name of list) {
      const found = await resolvePoi.findNamed(name, position).catch(() => null);
      const c = found?.found?.[0];
      if (!c) { lines.push(`« ${name} » introuvable à moins d'une heure à pied`); continue; }
      const pid = c.place.placeId;
      sel.manualRemoved = sel.manualRemoved.filter((r) => r.placeId !== pid);
      if (!sel.manualAdds.some((m) => m.placeId === pid)) sel.manualAdds.push({ placeId: pid, at: Date.now() });
      (sel._manual ||= new Map()).set(pid, c);
      (sel._names ||= new Map()).set(pid, c.place.name);
      lines.push(`${c.place.name} ajouté (${c.distance_from_user_m < 1000 ? `${c.distance_from_user_m} m` : `${(c.distance_from_user_m / 1000).toFixed(1).replace(".", ",")} km`})`);
    }
    if (!sel.filters.length && sel.title === "Nouvelle sélection") sel.title = "Mes restaurants";
    apply(sel);
    return `${lines.join(" ; ")}.`;
  }

  // ---- Retrait manuel (définitif pour la sélection) ----

  function removeNumbers(sel, numbers) {
    const pois = poisOf(sel).filter((p) => (numbers || []).includes(p.number));
    if (!pois.length) return "Je n'ai pas trouvé ces restaurants dans la sélection.";
    for (const poi of pois) removeOne(sel, poi);
    apply(sel);
    return `Retiré${pois.length > 1 ? "s" : ""} : ${pois.map((p) => `n° ${p.number} ${p.place?.name || p.name}`).join(", ")}.`;
  }

  function removeOne(sel, poi) {
    const pid = poi.place?.placeId;
    if (!pid) return;
    sel.manualAdds = sel.manualAdds.filter((m) => m.placeId !== pid);
    if (!sel.manualRemoved.some((r) => r.placeId === pid)) sel.manualRemoved.push({ placeId: pid, at: Date.now() });
    (sel._names ||= new Map()).set(pid, poi.place?.name || poi.name);
  }

  // Poubelle de la fiche d'un restaurant
  function removeByUser(poiId) {
    const poi = store.pois.get(poiId);
    const sel = poi && byId(poi.taskId);
    if (!sel) return false;
    removeOne(sel, poi);
    sel.messages.push({ id: `m${sel.nextMessage++}`, type: "remove", user: null, reply: `Retiré : n° ${poi.number} ${poi.place?.name || poi.name}.`, at: Date.now(), pending: false, note: "Poubelle de la fiche" });
    apply(sel);
    return true;
  }

  // Écran « Restaurants retirés » : le restaurant revient comme un ajout manuel
  async function restore(id, placeId) {
    const sel = byId(id);
    if (!sel) return { error: "Sélection introuvable." };
    let c = sel._candidates?.get(placeId) || sel._manual?.get(placeId) || null;
    if (!c) c = await resolvePoi.placeById(placeId, store.context.position);
    sel.manualRemoved = sel.manualRemoved.filter((r) => r.placeId !== placeId);
    if (!sel.manualAdds.some((m) => m.placeId === placeId)) sel.manualAdds.push({ placeId, at: Date.now() });
    (sel._manual ||= new Map()).set(placeId, c);
    sel.messages.push({ id: `m${sel.nextMessage++}`, type: "add", user: null, reply: `Remis dans la sélection : ${c.place.name}.`, at: Date.now(), pending: false, note: "Restaurants retirés" });
    apply(sel);
    return { ok: true };
  }

  // ---- Questions sur les restaurants de la sélection ----

  async function answer(sel, question, out) {
    let pois = poisOf(sel);
    if (!pois.length) return "La sélection est vide pour l'instant.";
    const asked = pois.filter((p) => (out.question_numbers || []).includes(p.number));
    if (asked.length) pois = asked;
    const rows = await Promise.all(pois.slice(0, 20).map(async (p) => {
      const pl = p.place || {};
      const row = {
        numero: p.number, nom: pl.name || p.name, adresse: pl.address || null,
        a_pied_min: p.walk?.seconds ? Math.round(p.walk.seconds / 60) : null,
        note: pl.rating ?? null, avis: pl.ratingCount ?? null, prix: pl.price || null,
        ouvert_lors_de_la_recherche: p.openAtSearch, horaires: pl.hours || null,
        verification: p.check ? `${p.check.label} : ${p.check.status} ${p.check.note || ""}`.trim() : null,
        ajout_manuel: sel.manualAdds.some((m) => m.placeId === pl.placeId),
      };
      const menu = pl.placeId ? menus?.get(pl.placeId) : null;
      if (menu?.dishes?.length) row.plats_releves = menu.dishes.slice(0, 40).map((d) => d.name);
      if (out.needs_details && pl.placeId && pois.length <= 5) {
        const info = await resolvePoi.getDetails(pl.placeId).catch(() => null);
        if (info) Object.assign(row, { telephone: info.phone || null, site: info.website || null, description: info.google_summary || null });
      }
      return row;
    }));
    const data = await callModel({
      model: SELECTION_MODEL, reasoning: { effort: "low" }, service_tier: "priority",
      instructions: SELECTION_ANSWER_INSTRUCTIONS,
      input: `Restaurants : ${JSON.stringify(rows)}\nQuestion : ${question}`,
    });
    return clip(outputText(data), 700) || "Je n'ai pas trouvé la réponse.";
  }

  // ---- Après un redémarrage : la sélection repart des restaurants sur la carte ----

  function resume() {
    for (const sel of store.selections) {
      if (!sel.filters.some((f) => f.kind === "distance")) continue;
      const manual = new Set(sel.manualAdds.map((m) => m.placeId));
      sel._candidates = new Map(poisOf(sel).filter((p) => p.place?.placeId && !manual.has(p.place.placeId))
        .map((p) => [p.place.placeId, { place: { ...p.place, name: p.place.name || p.name } }]));
      sel._perimeter = perimeterKey(sel);
      sel._partial = true; // les restaurants retirés par les filtres ne sont plus en mémoire
      sel._busy = false;
      // Noms des restaurants retirés à la main (donnée Google, non enregistrée) : redemandés
      for (const r of sel.manualRemoved) {
        resolvePoi.placeById(r.placeId).then((c) => {
          (sel._names ||= new Map()).set(r.placeId, c.place.name);
          apply(sel);
        }).catch(() => {});
      }
      // Vérifications restées en cours : relancées
      try {
        apply(sel);
      } catch (err) {
        console.warn(`[sélection ${sel.id}] reprise :`, err.message);
      }
    }
  }

  // ---- Appels au modèle ----

  async function callModel(body) {
    const response = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, store: false }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`modèle ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    metrics?.backendUsage?.(data.usage);
    return data;
  }

  const outputText = (data) => (data.output || []).filter((o) => o.type === "message").flatMap((o) => o.content || []).map((c) => c.text || "").join("");

  return { create, message, setFilter, removeByUser, restore, resume, byId, reflection, continueSearch };
}
