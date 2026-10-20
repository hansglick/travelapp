// Tableau des tâches : à chaque prise de parole de l'utilisateur, un petit modèle (le détecteur) décide
// des tâches à créer, préciser ou annuler. Chaque tâche est exécutée par le modèle de calcul (Responses
// API, piloté ici), jusqu'à MAX_PARALLEL en même temps. Une tâche précisée pendant son exécution est
// arrêtée puis relancée avec la demande mise à jour. Le tableau est affiché dans l'écran « Tâches ».
// Une recherche commence « à préciser » : le guide pose d'abord, une à une, au plus MAX_QUESTIONS
// questions sur les caractéristiques importantes qui manquent (budget, cuisine…), puis elle est lancée.

import {
  BACKEND_MODEL, BACKEND_REASONING, BACKEND_INSTRUCTIONS, BACKEND_TOOLS,
  EXTRACTOR_MODEL, EXTRACTOR_INSTRUCTIONS, EXTRACTOR_SCHEMA,
} from "./prompts.mjs";
import { normalize, CATEGORIES } from "./store.mjs";

const API = "https://api.openai.com/v1/responses";
const MAX_PARALLEL = 3;
const MAX_STEPS = 32;              // allers-retours maximum du modèle de calcul pour une tâche
const MAX_CONTINUATIONS = 3;       // relances si le nombre de lieux demandé n'est pas atteint
const WALK_M_PER_MIN = 80;         // vitesse de marche retenue pour les distances maximales
const CALL_TIMEOUT_MS = 90000;
const KEEP_TASKS = 40;             // tâches gardées dans le tableau
const WAIT_FOR_MORE_MAX_MS = 8000; // phrase inachevée : on attend la suite au plus ce délai
const EXTRACTOR_REASONING = process.env.EXTRACTOR_REASONING || "low"; // « none » ratait des questions sur les lieux
const FOCUS_TTL_MS = 15 * 60 * 1000; // bulle ouverte depuis plus longtemps : elle ne compte plus
const MAX_QUESTIONS = 3;           // questions d'affinage posées au plus avant une recherche
const MAX_DIMENSIONS = 6;
const COUNT_DIMENSION = "nombre de suggestions"; // plus demandé : recherche exhaustive (voir initialDimensions)
const DEFAULT_COUNT = 3;
const QUESTION_GRACE_MS = 2000;    // une prise de parole finie avant ce délai ne répond pas à la question
const ACTIVE = ["clarifying", "pending", "running"];
// Types de tâches : recherche, localisation d'un lieu précis, auto-localisation (point de retour),
// question sur les lieux (data), organisation de la liste ; découverte de la ville et points de vue : créés
// seulement par les boutons de la carte (jamais par le détecteur)
const KINDS = ["search", "locate", "self", "info", "quick", "discover", "viewpoints"];
const DISCOVER_GROUP = "Découverte de la ville";
const VIEWPOINTS_GROUP = "Points de vue";
const LOCATE_GROUP = "Lieux placés"; // toutes les localisations partagent ce groupe (une couleur)

// Noms des couleurs des groupes (même ordre que la palette de la page)
const COLOR_NAMES = ["orange", "bleu", "vert", "magenta", "bleu-vert", "violet", "ambre", "rose"];
// État d'une caractéristique, pour le détecteur
const DIMENSION_WORDS = {
  to_ask: "à demander", asked: "question posée, réponse attendue", skipped: "peu importe",
  unanswered: "sans réponse", not_asked: "non demandée",
};
// Canal de recherche : google (Google seul), mixed (Google fait la liste, le web vérifie) ou web
const channelOf = (value, fallback = "web") => (["google", "mixed", "web"].includes(value) ? value : fallback);
const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
// Paramètres de la recherche Google directe (canaux google et mixed), validés ; null si inutilisables
const googleOf = (g, fallback = null) => {
  if (!g || typeof g !== "object") return fallback;
  const words = (Array.isArray(g.words) ? g.words : []).map((w) => clip(w, 60)).filter(Boolean).slice(0, 3);
  if (!words.length) return fallback;
  const check = g.check && ["criterion", "reputation"].includes(g.check.kind)
    ? { kind: g.check.kind, question: clip(g.check.question, 120), label: clip(g.check.label, 40) || "Critère" }
    : null;
  return {
    type: typeof g.type === "string" ? g.type : null, words,
    category: CATEGORIES.includes(g.category) ? g.category : "other",
    openNow: Boolean(g.open_now ?? g.openNow),
    minRating: Number.isFinite(g.min_rating ?? g.minRating) ? Math.min(5, Math.max(0, g.min_rating ?? g.minRating)) : null,
    cheap: Boolean(g.cheap),
    check: check && (check.kind === "reputation" || check.question) ? check : null,
    ignored: (Array.isArray(g.ignored) ? g.ignored : []).map((w) => clip(w, 30)).filter(Boolean).slice(0, 5),
  };
};
const colorName = (i) => (Number.isInteger(i) ? COLOR_NAMES[i] || `couleur n° ${i + 1}` : null);

const STATUS_WORDS = { clarifying: "à préciser", pending: "en attente", running: "en cours", done: "terminée", failed: "échouée", cancelled: "annulée" };

export function createTaskBoard({ apiKey, store, tools, metrics, onChange, notify }) {
  const tasks = new Map();
  let nextId = 1;
  let extracting = Promise.resolve();
  let heldUtterance = null; // phrase inachevée en attente de la suite : { text, at }
  let lastConversation = []; // fin de la conversation, donnée en contexte aux nouvelles tâches
  let nextColor = 0;         // couleur de la prochaine tâche qui ajoute des lieux (0 = orange)
  let locateColor = null;    // couleur du groupe « Lieux placés »

  const list = () => [...tasks.values()];
  const changed = () => onChange(snapshot());

  // ---- Lecture ----

  function view(t) {
    return {
      id: t.id, title: t.title, request: t.request, kind: t.kind, utterance: t.utterance, status: t.status,
      createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt,
      actions: t.actions.slice(-30), result: t.result, replaces: t.replaces, replacedBy: t.replacedBy,
      requestedCount: t.requestedCount, placedCount: placedCount(t), criteria: t.criteria, maxDistanceM: t.maxDistanceM,
      colorIndex: t.colorIndex, extends: t.extends,
      relatedIds: [...t.relatedIds].filter((id) => store.pois.has(id)), // lieux concernés par une question
      addedIds: t.addedIds.filter((id) => store.pois.has(id)), // lieux ajoutés (chat : « Lieux placés »)
      dimensions: t.dimensions, groupName: t.groupName, channel: t.channel, google: t.google,
    };
  }

  function snapshot() {
    return list().map(view).reverse(); // plus récentes en premier
  }

  // État résumé pour le guide vocal et le détecteur
  function summary() {
    // Les boutons de la carte (découverte, points de vue) ne concernent pas la conversation
    const conversational = list().filter((t) => t.kind !== "discover" && t.kind !== "viewpoints");
    const running = conversational.filter((t) => t.status === "running");
    const pending = conversational.filter((t) => t.status === "pending");
    const clarifying = conversational.filter((t) => t.status === "clarifying");
    if (!running.length && !pending.length && !clarifying.length) return "Plus aucune tâche en cours : tout ce qui a été demandé est fait.";
    const parts = [];
    if (clarifying.length) parts.push(`à préciser avant la recherche : ${clarifying.map((t) => `« ${t.title} »`).join(", ")}`);
    if (running.length) parts.push(`en cours : ${running.map((t) => `« ${t.title} »`).join(", ")}`);
    if (pending.length) parts.push(`en attente : ${pending.map((t) => `« ${t.title} »`).join(", ")}`);
    return `Tâches ${parts.join(" ; ")}.`;
  }

  const searchRunning = () => list().filter((t) => t.status === "running" && t.kind === "search");

  function log(t, text) {
    t.actions.push({ at: Date.now(), text });
    changed();
  }

  // ---- Détection des tâches ----

  // Appelée à chaque fin de prise de parole ; les détections passent l'une après l'autre
  function handleUserTurn(text, conversation) {
    const turnAt = Date.now();
    extracting = extracting.then(() => detect(text, conversation, turnAt)).catch((err) => console.warn("[tâches] détection", err.message));
    return extracting;
  }

  async function detect(text, conversation, turnAt = Date.now()) {
    if (heldUtterance && Date.now() - heldUtterance.at < WAIT_FOR_MORE_MAX_MS) text = `${heldUtterance.text} ${text}`;
    heldUtterance = null;
    lastConversation = conversation.slice(-8);
    // Chaque tâche avec son groupe : couleur et lieux encore sur la carte (n° d'étape compris)
    const board = list().slice(-15).map((t) => {
      const places = groupPlaces(t).map((p) => `${p.mapNumber ? `n°${p.mapNumber} ` : ""}${p.place?.name || p.name}`);
      return {
        task_id: t.id, title: t.title, request: t.request, status: t.status,
        ...(t.criteria.length ? { criteria: t.criteria.map((c) => `${c.value} (${c.strict ? "strict" : "souple"})`) } : {}),
        ...(colorName(t.colorIndex) ? { group_color: colorName(t.colorIndex) } : {}),
        ...(places.length ? { group_places: places } : {}),
        ...(t.replacedBy ? { replaced_by: t.replacedBy } : {}),
        ...(t.result ? { result: t.result } : {}),
        ...(t.candidates.length ? { candidates: t.candidates.slice(-6) } : {}),
        ...(t.status === "clarifying" ? {
          dimensions: t.dimensions.map((d) => `${d.name} : ${d.value ?? DIMENSION_WORDS[d.status]}`),
          pending_question: t.dimensions.find((d) => d.status === "asked")?.question || null,
        } : {}),
      };
    });
    const selection = store.selectionForModel().pois.map((p) => `${p.map_number ? `n°${p.map_number} ` : ""}${p.name} (${p.category})`);
    const referent = referentPlace();
    const input = [
      "Tableau des tâches :", JSON.stringify(board),
      "Lieux sur la carte :", selection.join(" ; ") || "aucun",
      "Préférences enregistrées :", JSON.stringify(store.preferences || {}),
      "Lieu visé par « il », « elle », « ce point », « ce lieu » :", referent ? `${referent.label} (${referent.why})` : "aucun",
      "Lieux supprimés récemment (restaurables par une tâche quick) :", store.trash.slice(-10).reverse().map((p) => p.place?.name || p.name).join(" ; ") || "aucun",
      "Fin de la conversation (transcription) :", conversation.slice(-10).join("\n") || "(début)",
      "Nouvelle prise de parole de l'utilisateur :", text,
    ].join("\n");
    const started = Date.now();
    const response = await withRetry(() => fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: EXTRACTOR_MODEL,
        reasoning: { effort: EXTRACTOR_REASONING },
        service_tier: "priority", // détection plus rapide, pour un coût négligeable
        instructions: EXTRACTOR_INSTRUCTIONS,
        input,
        text: { format: { type: "json_schema", name: "task_board_update", strict: true, schema: EXTRACTOR_SCHEMA } },
        store: false,
      }),
      signal: AbortSignal.timeout(30000),
    }));
    if (!response.ok) throw new Error(`détecteur ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const data = await response.json();
    metrics.time("task_detection_ms", Date.now() - started);
    console.log(`[tâches] détection ${Date.now() - started} ms (contexte ${input.length} caractères, ${list().filter((t) => t.status === "running").length} tâche(s) en cours)`);
    metrics.backendUsage(data.usage);
    const out = JSON.parse(outputText(data) || "{}");
    // Filet de sécurité : une question sur un lieu de la liste, oubliée par le détecteur, devient
    // quand même une tâche data
    const nothing = !out.new_tasks?.length && !out.refine?.length && !out.extend?.length && !out.clarify?.length && !out.cancel?.length;
    if (nothing && !out.wait_for_more && isQuestionAboutPlaces(text, referent)) {
      console.log(`[tâches] question rattrapée : « ${text.slice(0, 80)} »`);
      const about = referent && mentionsReferent(text) ? ` Le lieu visé est ${referent.label} (${referent.why}).` : "";
      out.new_tasks = [{ title: text.replace(/\s*\?+\s*$/, "").slice(0, 60), request: `Répondre à la question de l'utilisateur sur ses lieux : « ${text} ».${about}`, kind: "info", count: null, criteria: [], dimensions: [] }];
    }
    if (out.wait_for_more && !out.new_tasks?.length && !out.refine?.length) {
      heldUtterance = { text, at: Date.now() };
      return;
    }
    for (const id of out.cancel || []) cancel(id, "annulée par l'utilisateur");
    for (const c of out.clarify || []) clarify(c, text);
    for (const r of out.refine || []) refine(r.task_id, r.request, text, r.count, r.criteria, r.channel, r.google);
    for (const e of out.extend || []) extend(e.task_id, e.additional_count, e.request, e.criteria, text);
    for (const t of out.new_tasks || []) {
      // Garde-fou : une demande qui nomme la couleur d'un groupe existant complète ce groupe
      const group = groupNamedIn(`${text} ${t.request}`);
      if (group && !(out.extend || []).some((e) => e.task_id === group.id)) {
        extend(group.id, t.count || 1, t.request, t.criteria?.length ? t.criteria : null, text);
        continue;
      }
      add({ title: t.title, groupName: t.group_name, request: t.request, kind: t.kind, channel: t.channel, google: t.google, placeNames: t.place_names, utterance: text, count: t.count, countGiven: t.count_given, criteria: t.criteria, dimensions: t.dimensions });
    }
    if (out.new_tasks?.length || out.refine?.length || out.extend?.length || out.cancel?.length || out.clarify?.length) {
      console.log(`[tâches] « ${text.slice(0, 80)} » →`, JSON.stringify(out));
    }
    // Question posée avant cette prise de parole et restée sans réponse : on passe à la suivante
    for (const t of list().filter((x) => x.status === "clarifying")) {
      for (const d of t.dimensions) {
        if (d.status === "asked" && d.askedAt + QUESTION_GRACE_MS < turnAt) {
          d.status = "unanswered";
          log(t, `sans réponse : ${d.name}`);
        }
      }
    }
    askNext();
  }

  // Lieu visé par une question sans nom : la bulle ouverte à l'écran, sinon le dernier lieu ajouté
  // ou cité dans une réponse
  function referentPlace() {
    const label = (poi) => `${poi.mapNumber ? `n°${poi.mapNumber} ` : ""}« ${poi.place?.name || poi.name} » (${poi.id})`;
    const focus = store.focus;
    if (focus && Date.now() - focus.at < FOCUS_TTL_MS && store.pois.has(focus.id)) {
      return { poi: store.pois.get(focus.id), label: label(store.pois.get(focus.id)), why: "sa bulle est ouverte à l'écran" };
    }
    for (const t of list().slice().reverse()) {
      const ids = [...(t.relatedIds || []), ...t.addedIds].filter((id) => store.pois.has(id));
      if (ids.length) {
        const poi = store.pois.get(ids[ids.length - 1]);
        return { poi, label: label(poi), why: "dernier lieu ajouté ou cité" };
      }
    }
    return null;
  }

  // « il », « elle », « ce point », « ce lieu », « cet endroit », « là-bas »…
  function mentionsReferent(text) {
    const lower = ` ${normalize(text)} `;
    return /\b(il|elle|t il|t elle|ce point|ce lieu|cet endroit|ce restaurant|ce musee|ce bar|ce cafe|cette adresse|la bas|y aller|j y)\b/.test(lower);
  }

  // Question (« ? » ou mot interrogatif) qui cite un lieu de la liste : nom, n° d'étape, point de
  // retour, ou un pronom quand un lieu est visé (bulle ouverte, dernier lieu cité)
  function isQuestionAboutPlaces(text, referent = null) {
    const lower = ` ${normalize(text)} `;
    const question = /\?/.test(text) || /\b(combien|quel|quelle|quels|quelles|quand|ou est|est ce|a quelle heure|ferme|ouvre|ouvert|note|telephone|prix)\b/.test(lower);
    if (!question) return false;
    if (referent && mentionsReferent(text)) return true;
    // Comparaison entre les lieux de la liste (« lequel est le mieux noté ? », « le plus proche ? »)
    if (store.pois.size && /\b(lequel|laquelle|lesquels|lesquelles|le plus|la plus|les plus|le mieux|le moins|ces lieux|mes lieux|parmi)\b/.test(lower)) return true;
    if (/\b(n|numero|point|etape)\s*\d+\b/.test(lower) || lower.includes(" point de retour ")) return true;
    return [...store.pois.values()].some((poi) =>
      [poi.place?.name, poi.name].map(normalize).some((n) => n.length >= 4 && lower.includes(` ${n} `)));
  }

  // ---- Questions d'affinage (tâches « à préciser ») ----

  // Une seule question à la fois, toutes tâches confondues : celles de la plus ancienne tâche d'abord.
  // Une tâche dont toutes les questions ont trouvé réponse est lancée.
  function askNext() {
    const waiting = list().filter((t) => t.status === "clarifying");
    if (waiting.some((t) => t.dimensions.some((d) => d.status === "asked"))) return;
    for (const t of waiting) {
      const next = t.dimensions.find((d) => d.status === "to_ask");
      if (!next) {
        launch(t, "précisions reçues");
        continue;
      }
      next.status = "asked";
      next.askedAt = Date.now();
      log(t, `question posée : ${next.question}`);
      notify({ type: "question", task: t, question: next.question, summary: summary() });
      return;
    }
  }

  function launch(t, reason) {
    // Nombre de suggestions demandé mais sans réponse chiffrée (« peu importe ») : 3 par défaut
    const countDim = t.dimensions.find((d) => d.name === COUNT_DIMENSION);
    if (countDim && !["known", "answered"].includes(countDim.status)) t.requestedCount = DEFAULT_COUNT;
    if (countDim?.status === "answered") {
      const n = parseInt(String(countDim.value).match(/\d+/)?.[0], 10);
      if (n > 0 && n <= 15) t.requestedCount = n;
    }
    t.status = "pending";
    log(t, `recherche lancée (${reason})`);
    schedule();
  }

  // Fin de la conversation vocale : plus personne pour répondre, les recherches partent avec ce qu'on sait
  function launchClarifying(reason) {
    for (const t of list().filter((x) => x.status === "clarifying")) {
      for (const d of t.dimensions) {
        if (d.status === "asked") d.status = "unanswered";
        if (d.status === "to_ask") d.status = "not_asked";
      }
      launch(t, reason);
    }
  }

  // Réponses aux questions d'une tâche « à préciser » (ou précision donnée avant qu'on la demande)
  function clarify(c, utterance) {
    const t = tasks.get(c.task_id);
    if (!t) return null;
    if (t.status !== "clarifying") {
      // Déjà lancée : c'est une précision ordinaire
      return ACTIVE.includes(t.status) ? refine(t.id, c.request, utterance, c.count, c.criteria, c.channel, c.google) : null;
    }
    for (const a of c.answers || []) {
      const name = String(a.dimension || "").slice(0, 40);
      let d = t.dimensions.find((x) => normalize(x.name) === normalize(name));
      if (!d) {
        d = { name, value: null, question: null, status: "answered", askedAt: null };
        t.dimensions.push(d);
      }
      d.value = a.value === null ? null : String(a.value).slice(0, 80);
      d.status = a.value === null ? "skipped" : "answered";
      log(t, d.value === null ? `peu importe : ${d.name}` : `réponse : ${d.name} = ${d.value}`);
    }
    if (c.request) t.request = String(c.request).slice(0, 600);
    if (Number.isInteger(c.count) && c.count > 0 && c.count <= 15) t.requestedCount = c.count;
    if (Array.isArray(c.criteria) && c.criteria.length) setCriteria(t, c.criteria);
    t.channel = channelOf(c.channel, t.channel);
    t.google = googleOf(c.google, t.google);
    if (c.launch_now) {
      for (const d of t.dimensions) if (d.status === "to_ask" || d.status === "asked") d.status = "skipped";
    }
    changed();
    return t;
  }

  // ---- Gestion du tableau ----

  // Champs d'exécution d'une tâche (non enregistrés) : annulation, journal, relances, couleur
  function hydrate(t) {
    t.abort = new AbortController();
    t.relatedIds = new Set(Array.isArray(t.relatedIds) ? t.relatedIds : []); // lieux consultés par la tâche
    t.dimensions ||= [];
    t.log = (text) => log(t, text); // utilisé par les fonctions de l'appli (lieu retiré car trop loin…)
    t.ensureColor = () => {
      if (t.colorIndex === null) t.colorIndex = nextColor++;
      return t.colorIndex;
    };
    return t;
  }

  // ---- Enregistrement (compte) ----

  function toJSON() {
    return {
      nextId, nextColor, locateColor,
      tasks: list().map((t) => ({
        id: t.id, title: t.title, request: t.request, kind: t.kind, utterance: t.utterance, status: t.status,
        createdAt: t.createdAt, startedAt: t.startedAt, endedAt: t.endedAt, actions: t.actions.slice(-30),
        result: t.result, replaces: t.replaces, replacedBy: t.replacedBy, addedIds: t.addedIds,
        previousAddedIds: t.previousAddedIds, requestedCount: t.requestedCount, criteria: t.criteria,
        maxDistanceM: t.maxDistanceM, extends: t.extends, continuations: t.continuations, colorIndex: t.colorIndex,
        relatedIds: [...t.relatedIds], dimensions: t.dimensions, groupName: t.groupName, channel: t.channel, google: t.google, placeNames: t.placeNames,
      })),
    };
  }

  // Une tâche en cours au moment de l'arrêt du serveur est marquée interrompue
  function load(data) {
    if (!data) return;
    nextId = Number.isInteger(data.nextId) ? data.nextId : 1;
    nextColor = Number.isInteger(data.nextColor) ? data.nextColor : 0;
    locateColor = Number.isInteger(data.locateColor) ? data.locateColor : null;
    for (const saved of data.tasks || []) {
      const t = hydrate({ ...saved, candidates: [], conversation: [] });
      if (ACTIVE.includes(t.status)) {
        t.status = "failed";
        t.result = "Tâche interrompue par un redémarrage du serveur.";
        t.endedAt = Date.now();
      }
      tasks.set(t.id, t);
    }
  }

  // Critères d'une tâche, et distance maximale contrôlée par l'application (80 m par minute de marche,
  // à vol d'oiseau)
  function setCriteria(t, criteria) {
    t.criteria = (Array.isArray(criteria) ? criteria : []).slice(0, 10).map((c) => ({
      type: c.type, value: String(c.value || "").slice(0, 120), strict: Boolean(c.strict),
      maxWalkMinutes: Number.isInteger(c.max_walk_minutes) && c.max_walk_minutes > 0 ? c.max_walk_minutes : null,
    }));
    const walkLimits = t.criteria.filter((c) => c.type === "distance" && c.strict && c.maxWalkMinutes).map((c) => c.maxWalkMinutes);
    t.maxDistanceM = walkLimits.length ? Math.min(...walkLimits) * WALK_M_PER_MIN : null;
  }

  // Caractéristiques d'une nouvelle recherche : connues, à demander (les MAX_QUESTIONS premières qui
  // manquent) ou non demandées
  // Le nombre de suggestions est toujours demandé en dernier (en plus des MAX_QUESTIONS), sauf si
  // l'utilisateur l'a déjà dit ; une recherche sans caractéristique (lieu précis nommé) n'en a pas
  // Recherche exhaustive (tous les lieux du rayon, 20 au plus) : plus de question sur le nombre de
  // suggestions ; le rayon est toujours demandé en premier si la demande ne le donne pas
  function initialDimensions(list) {
    let toAsk = 0;
    const raw = (Array.isArray(list) ? list : []).filter((d) => normalize(d.name) !== normalize(COUNT_DIMENSION));
    const isDistance = (d) => /distance|rayon|temps de marche/.test(normalize(d.name));
    if (raw.length && !raw.some(isDistance)) {
      raw.unshift({ name: "distance", known_value: null, question: "Jusqu'à combien de minutes à pied ? Par exemple 5, 10 ou 15 minutes." });
    }
    const ordered = [...raw.filter(isDistance), ...raw.filter((d) => !isDistance(d))].slice(0, MAX_DIMENSIONS);
    return ordered.map((d) => {
      const known = typeof d.known_value === "string" && d.known_value.trim() ? d.known_value.trim().slice(0, 80) : null;
      const status = known ? "known" : isDistance(d) || toAsk++ < MAX_QUESTIONS ? "to_ask" : "not_asked";
      return { name: String(d.name || "").slice(0, 40), value: known, question: String(d.question || "").slice(0, 200), status, askedAt: null };
    });
  }

  function add({ title, groupName = null, request, kind, channel = "web", google = null, placeNames = [], utterance, replaces = null, previousAddedIds = [], count = null, countGiven = false, criteria = [], extends: extending = false, dimensions = [] }) {
    const t = {
      id: `t${nextId++}`, title: (title || "Tâche").slice(0, 60), request: (request || "").slice(0, 600),
      kind: KINDS.includes(kind) ? kind : "search", utterance: (utterance || "").slice(0, 400),
      status: "pending", createdAt: Date.now(), startedAt: null, endedAt: null,
      actions: [], result: null, replaces, replacedBy: null,
      addedIds: [], candidates: [], previousAddedIds,
      requestedCount: Number.isInteger(count) && count > 0 && count <= 15 ? count : null, // nombre de lieux exigé
      extends: extending, // complète un groupe : ses lieux existants sont gardés tels quels
      continuations: 0, conversation: lastConversation,
      // Canal de recherche : google (Places seulement, sans recherche web) ou web
      channel: channelOf(channel),
      google: googleOf(google),
      // Lieux nommés à placer (tâche locate) : cherchés d'abord autour de l'utilisateur
      placeNames: (Array.isArray(placeNames) ? placeNames : []).map((n) => clip(n, 80)).filter(Boolean).slice(0, 5),
    };
    // Couleur des lieux de la tâche : une tâche relancée garde celle de la tâche qu'elle remplace ;
    // une tâche qui doit ajouter des lieux la reçoit dès sa création (la 1re est orange) ; les autres
    // à leur premier ajout
    setCriteria(t, criteria);
    // Nom du groupe de lieux (légende) : une tâche relancée ou qui complète un groupe garde le sien
    t.groupName = (typeof groupName === "string" && groupName.trim() ? groupName.trim().slice(0, 60) : null)
      ?? (replaces ? tasks.get(replaces)?.groupName ?? null : null);
    // Nouvelle recherche : « à préciser » tant qu'il reste des questions à poser
    t.dimensions = t.kind === "search" && !replaces ? initialDimensions(dimensions) : [];
    if (t.dimensions.some((d) => d.status === "to_ask")) t.status = "clarifying";
    t.colorIndex = replaces ? tasks.get(replaces)?.colorIndex ?? null : null;
    if (t.kind === "locate") {
      // Les lieux localisés forment un seul groupe, d'une seule couleur
      if (locateColor === null) locateColor = nextColor++;
      t.colorIndex = locateColor;
      t.groupName = LOCATE_GROUP;
    }
    if (t.kind === "discover") t.groupName = DISCOVER_GROUP;
    if (t.kind === "viewpoints") t.groupName = VIEWPOINTS_GROUP;
    if (t.colorIndex === null && t.requestedCount && t.kind === "search") t.colorIndex = nextColor++;
    hydrate(t);
    tasks.set(t.id, t);
    while (tasks.size > KEEP_TASKS) {
      // Les questions (écran « Mes questions ») partent en dernier : elles restent jusqu'à « Effacer »
      const finished = list().filter((x) => !ACTIVE.includes(x.status));
      const oldest = finished.find((x) => x.kind !== "info") || finished[0];
      if (!oldest) break;
      tasks.delete(oldest.id);
    }
    metrics.count("tasks");
    changed();
    schedule();
    return t;
  }

  function cancel(id, reason) {
    const t = tasks.get(id);
    if (!t || !ACTIVE.includes(t.status)) return null;
    t.abort.abort();
    t.status = "cancelled";
    t.endedAt = Date.now();
    log(t, reason);
    notify({ type: "cancelled", task: t, summary: summary() });
    schedule();
    askNext(); // une question en attente pour cette tâche : on passe à la suivante
    return t;
  }

  // Précision sur une tâche : en cours ou en attente → arrêtée puis relancée ; terminée → nouvelle
  // tâche qui ajuste son résultat (lieux déjà ajoutés transmis)
  function refine(id, request, utterance, count = null, criteria = null, channel = null, google = null) {
    const old = tasks.get(id);
    if (!old) return add({ title: "Précision", request, kind: "search", channel: channelOf(channel), google, utterance, count, criteria: criteria || [] });
    if (old.status === "clarifying") {
      // Pas encore lancée : la demande est simplement mise à jour
      if (request) old.request = String(request).slice(0, 600);
      if (Number.isInteger(count) && count > 0 && count <= 15) old.requestedCount = count;
      if (criteria?.length) setCriteria(old, criteria);
      old.channel = channelOf(channel, old.channel);
      old.google = googleOf(google, old.google);
      log(old, "demande précisée");
      return old;
    }
    const wasActive = ["pending", "running"].includes(old.status);
    if (wasActive) cancel(id, "arrêtée : demande précisée, relancée");
    const next = add({
      title: old.title, request, kind: old.kind, channel: channelOf(channel, old.channel), google: googleOf(google, old.google), utterance, replaces: old.id,
      previousAddedIds: [...old.previousAddedIds, ...old.addedIds].filter((pid) => store.pois.has(pid)),
      count: count ?? old.requestedCount,
      criteria: criteria?.length ? criteria : old.criteria.map((c) => ({ type: c.type, value: c.value, strict: c.strict, max_walk_minutes: c.maxWalkMinutes })),
    });
    old.replacedBy = next.id;
    changed();
    return next;
  }

  // Groupe désigné par sa couleur dans une phrase (« le groupe bleu ») : la tâche la plus récente de
  // cette couleur, ou null
  function groupNamedIn(text) {
    const lower = text.toLowerCase();
    const match = list().filter((t) => Number.isInteger(t.colorIndex) && !t.replacedBy)
      .reverse()
      .find((t) => new RegExp(`groupe\\s+(?:de\\s+(?:couleur\\s+)?)?${colorName(t.colorIndex)}(?![\\w-])`).test(lower)); // « bleu » ≠ « bleu-vert »
    return match || null;
  }

  // Lieux d'un groupe encore sur la carte : ceux de la tâche et des versions qu'elle remplace
  function groupPlaces(t) {
    if (!Number.isInteger(t.colorIndex)) return [];
    return [...store.pois.values()].filter((p) => p.colorIndex === t.colorIndex && p.status !== "not_found");
  }

  // Compléter un groupe : nouvelle tâche qui hérite des critères (éventuellement mis à jour) et de la
  // couleur, garde les lieux déjà présents et en ajoute « additional » de plus
  function extend(id, additional, request, criteria, utterance) {
    let old = tasks.get(id);
    while (old?.replacedBy && tasks.get(old.replacedBy)) old = tasks.get(old.replacedBy); // version la plus récente
    if (!old) return add({ title: "Ajout", request, kind: "search", utterance, count: additional, criteria: criteria || [] });
    const more = Number.isInteger(additional) && additional > 0 ? Math.min(additional, 10) : 1;
    if (ACTIVE.includes(old.status)) {
      // Groupe encore en cours de recherche (ou à préciser) : objectif plus grand
      return refine(old.id, request, utterance, (old.requestedCount || 0) + more, criteria, old.channel, old.google);
    }
    const kept = groupPlaces(old).map((p) => p.id);
    const next = add({
      title: old.title, request, kind: "search", channel: old.channel, google: old.google, utterance, replaces: old.id,
      previousAddedIds: kept, count: kept.length + more,
      criteria: criteria?.length ? criteria : old.criteria.map((c) => ({ type: c.type, value: c.value, strict: c.strict, max_walk_minutes: c.maxWalkMinutes })),
      extends: true,
    });
    old.replacedBy = next.id;
    changed();
    return next;
  }

  function schedule() {
    const running = list().filter((t) => t.status === "running").length;
    const free = MAX_PARALLEL - running;
    list().filter((t) => t.status === "pending").slice(0, Math.max(0, free)).forEach((t) => runTask(t));
  }

  // ---- Exécution d'une tâche par le modèle de calcul ----

  async function runTask(t) {
    t.status = "running";
    t.startedAt = Date.now();
    changed();
    notify({ type: "started", task: t, summary: summary() });
    try {
      const result = await execute(t);
      if (t.abort.signal.aborted) return;
      t.result = result || "Tâche terminée.";
      t.status = "done";
      if (t.kind === "info") noteMentionedPlaces(t);
      // Lieux ajoutés : temps de marche depuis l'endroit de la recherche, pour leur fiche
      if (["search", "locate", "discover", "viewpoints"].includes(t.kind) && t.addedIds.length) {
        tools.attachWalks(t.addedIds).catch((err) => console.warn("[temps de marche]", err.message));
      }
      log(t, "terminée");
      metrics.time(`task_${t.kind}_ms`, Date.now() - t.startedAt);
      notify({ type: "done", task: t, summary: summary() });
    } catch (err) {
      if (t.abort.signal.aborted) return;
      console.warn(`[tâches] ${t.id} échouée :`, err.message);
      t.status = "failed";
      t.result = "La tâche n'a pas pu aboutir (erreur technique).";
      log(t, `erreur : ${err.message.slice(0, 120)}`);
      notify({ type: "failed", task: t, summary: summary() });
    } finally {
      if (!t.endedAt) t.endedAt = Date.now();
      changed();
      schedule();
    }
  }

  function taskContext(t) {
    const sel = store.selectionForModel();
    const lines = [
      `[APP] Tâche ${t.id} (${t.kind}).`,
      ...(t.kind === "search" ? [`Canal : ${{ google: "google (Google Places seulement, pas de recherche web)", mixed: "mixed (find_places_near d'abord pour la liste, le web seulement pour vérifier un critère concret)", web: "web" }[t.channel] || "web"}.`] : []),
      ...(t.criteria.length ? [`Critères : ${t.criteria.map((c) => `${c.value} (${c.type}, ${c.strict ? "strict" : "souple"})`).join(" ; ")}.`] : []),
      ...(t.requestedCount ? [`Nombre de lieux à trouver : ${t.requestedCount}.`] : []),
      ...(t.dimensions.length ? [`Caractéristiques : ${t.dimensions.map((d) => `${d.name} = ${d.value ?? (d.status === "skipped" ? "peu importe pour l'utilisateur" : "non précisé")}`).join(" ; ")}.`] : []),
      ...(t.maxDistanceM ? [`Distance maximale à vol d'oiseau depuis l'utilisateur : ${t.maxDistanceM} m (contrôlée par l'application).`] : []),
      `État de la liste au lancement (version ${sel.version}) : ${JSON.stringify(sel.pois)}`,
      `Préférences : ${JSON.stringify(sel.preferences)}`,
      `Contexte : ${JSON.stringify(sel.context)}`,
    ];
    if (t.previousAddedIds.length) {
      const prev = t.previousAddedIds.map((id) => store.pois.get(id)).filter(Boolean).map((p) => `${p.id} « ${p.place?.name || p.name} »`);
      lines.push(t.extends
        ? `Cette tâche complète un groupe existant. Lieux déjà dans le groupe, à garder tels quels (ne les retire pas, ne les rajoute pas) : ${prev.join(", ")}. Ajoute ${Math.max(1, (t.requestedCount || 0) - prev.length)} lieu(x) nouveau(x) qui respectent les critères.`
        : `Lieux déjà ajoutés par la version précédente de cette tâche : ${prev.join(", ")}. Garde ceux qui respectent la demande mise à jour, retire les autres, puis complète.`);
    }
    const recentCandidates = list().filter((x) => x !== t).flatMap((x) => x.candidates).slice(-8);
    if (recentCandidates.length) lines.push(`Candidats proposés récemment par d'autres tâches : ${recentCandidates.join(" ; ")}`);
    if (t.conversation?.length) lines.push(`Fin de la conversation, pour le contexte : \n${t.conversation.join("\n")}`);
    return lines.join("\n");
  }

  async function execute(t) {
    // Auto-localisation : traitée directement par l'application, sans modèle
    if (t.kind === "self") {
      const result = await tools.placeBackPoint();
      log(t, result);
      return result;
    }
    // Découverte de la ville et points de vue : préparés au « Let's Go! », affichées maintenant (sans modèle)
    if (t.kind === "discover" || t.kind === "viewpoints") {
      const result = await (t.kind === "discover" ? tools.discover(t) : tools.showViewpoints(t));
      log(t, result);
      return result;
    }
    // Tâche précisée : les lieux de la version précédente devenus trop loin sont retirés d'emblée
    // (pas quand on complète un groupe : ses lieux existants restent tels quels)
    if (!t.extends) for (const id of t.previousAddedIds) tools.enforceDistance(t, id);
    // Lieu nommé : cherché d'abord autour de l'utilisateur (10, 30 puis 60 min à pied), sans le modèle
    if (t.kind === "locate" && t.placeNames?.length) {
      const result = await tools.locateDirect(t);
      if (result) {
        log(t, result);
        return result;
      }
      log(t, "localisation directe sans résultat : le modèle prend le relais");
    }
    // Canaux google et mixed : recherche directe (Google fait la liste ; canal mixed : le web vérifie
    // un critère concret ou la réputation) ; rien trouvé → le modèle prend le relais
    if (t.kind === "search" && (t.channel === "google" || t.channel === "mixed") && t.google) {
      const result = await tools.googleDirect(t);
      if (result) {
        log(t, result);
        return result;
      }
      log(t, "recherche directe sans résultat : le modèle prend le relais");
    }
    let previous = null;
    let input = [
      { role: "developer", content: taskContext(t) },
      { role: "user", content: `Tâche à exécuter : ${t.request}` },
    ];
    let finalText = "";
    for (let step = 0; step < MAX_STEPS; step++) {
      const data = await callModel({ input, previous_response_id: previous }, t);
      metrics.backendUsage(data.usage);
      previous = data.id;
      const calls = [];
      for (const item of data.output || []) {
        if (item.type === "web_search_call") {
          metrics.count("web_search");
          const q = item.action?.query || item.action?.queries?.join(" / ");
          log(t, q ? `recherche web : ${q}` : "recherche web");
        } else if (item.type === "function_call") {
          calls.push(item);
        } else if (item.type === "message") {
          finalText = (item.content || []).map((c) => c.text || "").join(" ").trim() || finalText;
        }
      }
      if (!calls.length) {
        // Le nombre de lieux demandé est exigé : s'il en manque, la tâche est relancée
        const placed = placedCount(t);
        if (!t.requestedCount || placed >= t.requestedCount || t.continuations >= MAX_CONTINUATIONS) return finalText;
        t.continuations++;
        log(t, `${placed} lieu(x) sur ${t.requestedCount} : relance ${t.continuations}/${MAX_CONTINUATIONS}`);
        input = [{
          role: "developer",
          content: `[APP] Tu as ${placed} lieu(x) sur la carte pour cette tâche, sur ${t.requestedCount} demandés. Le nombre est obligatoire : continue jusqu'à ${t.requestedCount}. `
            + "Essaie d'autres mots dans la recherche web, et find_places_near autour de l'utilisateur pour trouver des commerces proches. "
            + (t.continuations === MAX_CONTINUATIONS
              ? "C'est la dernière relance : tu peux assouplir un critère souple, en disant lequel, mais jamais un critère strict. Si c'est impossible, arrête-toi et dis combien tu en as trouvé sur combien, et quel critère strict l'empêche."
              : "Ne contredis aucun critère strict."),
        }];
        continue;
      }
      input = [];
      for (const call of calls) {
        if (t.abort.signal.aborted) return null;
        let output;
        const started = Date.now();
        try {
          output = await tools.run(call.name, call.arguments ? JSON.parse(call.arguments) : {}, t);
        } catch (err) {
          console.error(`[tâches] ${t.id} ${call.name} : erreur interne`, err.stack?.split("\n").slice(0, 3).join(" | "));
          output = { status: "error", message: "Arguments invalides ou erreur interne." };
        }
        metrics.time(`function_${call.name}_ms`, Date.now() - started);
        log(t, describeCall(call.name, call.arguments, output));
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
    }
    return finalText || "Tâche interrompue : trop d'étapes.";
  }

  // Question : les lieux cités dans la réponse s'ajoutent à ceux consultés par les outils
  function noteMentionedPlaces(t) {
    const answer = ` ${normalize(t.result)} `;
    for (const poi of store.pois.values()) {
      const names = [poi.place?.name, poi.name].map(normalize).filter((n) => n.length >= 4);
      if (names.some((n) => answer.includes(` ${n} `))) t.relatedIds.add(poi.id);
    }
  }

  // Lieux de cette tâche (ou de sa version précédente) encore sur la carte ou en cours de localisation
  function placedCount(t) {
    return [...new Set([...t.previousAddedIds, ...t.addedIds])]
      .map((id) => store.pois.get(id))
      .filter((p) => p && p.status !== "not_found" && p.status !== "ambiguous").length;
  }

  async function callModel({ input, previous_response_id }, t) {
    const response = await withRetry(() => fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: BACKEND_MODEL,
        instructions: BACKEND_INSTRUCTIONS,
        // Canal google : pas de recherche web (plus rapide, lieux déjà localisés par Google)
        tools: t.kind === "search" && t.channel === "google" ? BACKEND_TOOLS.filter((tool) => tool.type !== "web_search") : BACKEND_TOOLS,
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: { effort: BACKEND_REASONING },
        input,
        ...(previous_response_id ? { previous_response_id } : {}),
      }),
      signal: AbortSignal.any([t.abort.signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    }), t.abort.signal);
    if (!response.ok) throw new Error(`modèle de calcul ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }

  // Ligne lisible pour l'écran des tâches
  function describeCall(name, rawArgs, output) {
    let args = {};
    try { args = JSON.parse(rawArgs || "{}"); } catch { /* arguments illisibles */ }
    const ok = output?.status === "ok" || output?.status === "applied" || output?.status === "unchanged";
    switch (name) {
      case "get_selection": return "lecture de la liste";
      case "update_pois": {
        if (args.operation === "add") {
          const detail = ok
            ? (output.added || []).map((p) => `${p.status}${p.distance_m != null ? `, ${p.distance_m} m` : ""}`).join(" ; ")
            : output.status;
          return `ajout : ${(args.pois || []).map((p) => p.name).join(", ")} → ${detail}`;
        }
        if (args.operation === "remove") return `retrait : ${(output.removed || []).map((p) => p.name).join(", ") || output.status}`;
        return `remplacement de la liste → ${output.status}`;
      }
      case "find_places_near": return `recherche Google « ${args.what} » → ${(output.candidates || []).length} candidat(s)`;
      case "get_place_details": return `informations pratiques ${output.name || args.poi_id} → ${output.status}`;
      case "measure_walk": return `marche : ${(output.results || []).map((r) => (r.status === "error" ? r.message
        : `${r.from} → ${r.to} ${r.walk_m != null ? `${r.walk_m} m, ${r.walk_minutes} min` : `${r.straight_line_m} m à vol d'oiseau`}`)).join(" ; ") || output.status}`;
      case "show_place": return args.poi_id ? `bulle ouverte (${args.poi_id})` : "bulle fermée";
      case "restore_pois": return `remis sur la carte : ${(output.restored || []).map((r) => r.name).join(", ") || output.status}`;
      case "pin_steps": return `étapes figées : ${(output.applied || []).map((a) => `${a.name} (${a.position})`).join(", ") || output.status}`;
      case "update_preferences": return `préférences : ${(output.changed || []).join(", ") || output.status}`;
      default: return `${name} → ${output?.status}`;
    }
  }

  // Bouton « Effacer » : les tâches en cours sont arrêtées (leurs résultats tardifs sont ignorés) et
  // le tableau est vidé ; les couleurs repartent de l'orange
  function clearAll() {
    const stopped = list().filter((t) => ACTIVE.includes(t.status));
    for (const t of stopped) {
      t.abort.abort();
      t.status = "cancelled";
    }
    tasks.clear();
    heldUtterance = null;
    lastConversation = [];
    nextColor = 0;
    locateColor = null;
    changed();
    return stopped.length;
  }

  return { handleUserTurn, add, cancel, snapshot, summary, searchRunning, clearAll, launchClarifying, toJSON, load, tasks };
}

// Coupure réseau ou erreur passagère d'OpenAI (429, 5xx) : jusqu'à 2 nouveaux essais, espacés
async function withRetry(request, abortSignal = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await request();
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      return response;
    } catch (err) {
      if (abortSignal?.aborted || attempt >= 2) throw err;
      console.warn("[tâches] nouvel essai après :", err.message);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

function outputText(data) {
  return (data.output || [])
    .filter((o) => o.type === "message")
    .flatMap((o) => o.content || [])
    .map((c) => c.text || "")
    .join("");
}
