// Tableau des tâches : à chaque prise de parole de l'utilisateur, un petit modèle (le détecteur) décide
// des tâches à créer, préciser ou annuler. Chaque tâche est exécutée par le modèle de calcul (Responses
// API, piloté ici), jusqu'à MAX_PARALLEL en même temps. Une tâche précisée pendant son exécution est
// arrêtée puis relancée avec la demande mise à jour. Le tableau est affiché dans l'écran « Tâches ».

import {
  BACKEND_MODEL, BACKEND_REASONING, BACKEND_INSTRUCTIONS, BACKEND_TOOLS,
  EXTRACTOR_MODEL, EXTRACTOR_INSTRUCTIONS, EXTRACTOR_SCHEMA,
} from "./prompts.mjs";

const API = "https://api.openai.com/v1/responses";
const MAX_PARALLEL = 3;
const MAX_STEPS = 32;              // allers-retours maximum du modèle de calcul pour une tâche
const MAX_CONTINUATIONS = 3;       // relances si le nombre de lieux demandé n'est pas atteint
const WALK_M_PER_MIN = 80;         // vitesse de marche retenue pour les distances maximales
const CALL_TIMEOUT_MS = 90000;
const KEEP_TASKS = 40;             // tâches gardées dans le tableau
const WAIT_FOR_MORE_MAX_MS = 8000; // phrase inachevée : on attend la suite au plus ce délai
const EXTRACTOR_REASONING = process.env.EXTRACTOR_REASONING || "none"; // détection rapide

// Noms des couleurs des groupes (même ordre que la palette de la page)
const COLOR_NAMES = ["orange", "bleu", "vert", "magenta", "bleu-vert", "violet", "ambre", "rose"];
const colorName = (i) => (Number.isInteger(i) ? COLOR_NAMES[i] || `couleur n° ${i + 1}` : null);

const STATUS_WORDS ={ pending: "en attente", running: "en cours", done: "terminée", failed: "échouée", cancelled: "annulée" };

export function createTaskBoard({ apiKey, store, tools, metrics, onChange, notify }) {
  const tasks = new Map();
  let nextId = 1;
  let extracting = Promise.resolve();
  let heldUtterance = null; // phrase inachevée en attente de la suite : { text, at }
  let lastConversation = []; // fin de la conversation, donnée en contexte aux nouvelles tâches
  let nextColor = 0;         // couleur de la prochaine tâche qui ajoute des lieux (0 = orange)

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
    };
  }

  function snapshot() {
    return list().map(view).reverse(); // plus récentes en premier
  }

  // État résumé pour le guide vocal et le détecteur
  function summary() {
    const running = list().filter((t) => t.status === "running");
    const pending = list().filter((t) => t.status === "pending");
    if (!running.length && !pending.length) return "Plus aucune tâche en cours : tout ce qui a été demandé est fait.";
    const parts = [];
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
    extracting = extracting.then(() => detect(text, conversation)).catch((err) => console.warn("[tâches] détection", err.message));
    return extracting;
  }

  async function detect(text, conversation) {
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
      };
    });
    const selection = store.selectionForModel().pois.map((p) => `${p.map_number ? `n°${p.map_number} ` : ""}${p.name} (${p.category})`);
    const input = [
      "Tableau des tâches :", JSON.stringify(board),
      "Lieux sur la carte :", selection.join(" ; ") || "aucun",
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
    if (out.wait_for_more && !out.new_tasks?.length && !out.refine?.length) {
      heldUtterance = { text, at: Date.now() };
      return;
    }
    for (const id of out.cancel || []) cancel(id, "annulée par l'utilisateur");
    for (const r of out.refine || []) refine(r.task_id, r.request, text, r.count, r.criteria);
    for (const e of out.extend || []) extend(e.task_id, e.additional_count, e.request, e.criteria, text);
    for (const t of out.new_tasks || []) {
      // Garde-fou : une demande qui nomme la couleur d'un groupe existant complète ce groupe
      const group = groupNamedIn(`${text} ${t.request}`);
      if (group && !(out.extend || []).some((e) => e.task_id === group.id)) {
        extend(group.id, t.count || 1, t.request, t.criteria?.length ? t.criteria : null, text);
        continue;
      }
      add({ title: t.title, request: t.request, kind: t.kind, utterance: text, count: t.count, criteria: t.criteria });
    }
    if (out.new_tasks?.length || out.refine?.length || out.extend?.length || out.cancel?.length) {
      console.log(`[tâches] « ${text.slice(0, 80)} » →`, JSON.stringify(out));
    }
  }

  // ---- Gestion du tableau ----

  function add({ title, request, kind, utterance, replaces = null, previousAddedIds = [], count = null, criteria = [], extends: extending = false }) {
    const cleanCriteria = (Array.isArray(criteria) ? criteria : []).slice(0, 10).map((c) => ({
      type: c.type, value: String(c.value || "").slice(0, 120), strict: Boolean(c.strict),
      maxWalkMinutes: Number.isInteger(c.max_walk_minutes) && c.max_walk_minutes > 0 ? c.max_walk_minutes : null,
    }));
    // Distance maximale contrôlée par l'application : 80 m par minute de marche, à vol d'oiseau
    const walkLimits = cleanCriteria.filter((c) => c.type === "distance" && c.strict && c.maxWalkMinutes).map((c) => c.maxWalkMinutes);
    const maxDistanceM = walkLimits.length ? Math.min(...walkLimits) * WALK_M_PER_MIN : null;
    const t = {
      id: `t${nextId++}`, title: (title || "Tâche").slice(0, 60), request: (request || "").slice(0, 600),
      kind: ["search", "quick", "info"].includes(kind) ? kind : "search", utterance: (utterance || "").slice(0, 400),
      status: "pending", createdAt: Date.now(), startedAt: null, endedAt: null,
      actions: [], result: null, replaces, replacedBy: null,
      addedIds: [], candidates: [], previousAddedIds,
      requestedCount: Number.isInteger(count) && count > 0 && count <= 15 ? count : null, // nombre de lieux exigé
      criteria: cleanCriteria, maxDistanceM,
      extends: extending, // complète un groupe : ses lieux existants sont gardés tels quels
      continuations: 0,
      abort: new AbortController(), nudges: 0, lastNudgeAt: 0, conversation: lastConversation,
    };
    t.log = (text) => log(t, text); // utilisé par les fonctions de l'appli (lieu retiré car trop loin…)
    // Couleur des lieux de la tâche : attribuée à son premier ajout ; une tâche relancée garde celle
    // de la tâche qu'elle remplace
    t.colorIndex = replaces ? tasks.get(replaces)?.colorIndex ?? null : null;
    // Tâche qui doit ajouter des lieux : couleur attribuée dès sa création (la 1re est orange)
    if (t.colorIndex === null && t.requestedCount) t.colorIndex = nextColor++;
    t.ensureColor = () => {
      if (t.colorIndex === null) t.colorIndex = nextColor++;
      return t.colorIndex;
    };
    tasks.set(t.id, t);
    while (tasks.size > KEEP_TASKS) {
      const oldest = list().find((x) => !["pending", "running"].includes(x.status));
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
    if (!t || !["pending", "running"].includes(t.status)) return null;
    t.abort.abort();
    t.status = "cancelled";
    t.endedAt = Date.now();
    log(t, reason);
    notify({ type: "cancelled", task: t, summary: summary() });
    schedule();
    return t;
  }

  // Précision sur une tâche : en cours ou en attente → arrêtée puis relancée ; terminée → nouvelle
  // tâche qui ajuste son résultat (lieux déjà ajoutés transmis)
  function refine(id, request, utterance, count = null, criteria = null) {
    const old = tasks.get(id);
    if (!old) return add({ title: "Précision", request, kind: "search", utterance, count, criteria: criteria || [] });
    const wasActive = ["pending", "running"].includes(old.status);
    if (wasActive) cancel(id, "arrêtée : demande précisée, relancée");
    const next = add({
      title: old.title, request, kind: old.kind, utterance, replaces: old.id,
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
    if (["pending", "running"].includes(old.status)) {
      // Groupe encore en cours de recherche : relancé avec un objectif plus grand
      return refine(old.id, request, utterance, (old.requestedCount || 0) + more, criteria);
    }
    const kept = groupPlaces(old).map((p) => p.id);
    const next = add({
      title: old.title, request, kind: "search", utterance, replaces: old.id,
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
      ...(t.criteria.length ? [`Critères : ${t.criteria.map((c) => `${c.value} (${c.type}, ${c.strict ? "strict" : "souple"})`).join(" ; ")}.`] : []),
      ...(t.requestedCount ? [`Nombre de lieux à trouver : ${t.requestedCount}.`] : []),
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
    // Tâche précisée : les lieux de la version précédente devenus trop loin sont retirés d'emblée
    // (pas quand on complète un groupe : ses lieux existants restent tels quels)
    if (!t.extends) for (const id of t.previousAddedIds) tools.enforceDistance(t, id);
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
          output = { status: "error", message: "Arguments invalides ou erreur interne." };
        }
        metrics.time(`function_${call.name}_ms`, Date.now() - started);
        log(t, describeCall(call.name, call.arguments, output));
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(output) });
      }
    }
    return finalText || "Tâche interrompue : trop d'étapes.";
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
        tools: BACKEND_TOOLS,
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
      case "show_place": return args.poi_id ? `bulle ouverte (${args.poi_id})` : "bulle fermée";
      case "pin_steps": return `étapes figées : ${(output.applied || []).map((a) => `${a.name} (${a.position})`).join(", ") || output.status}`;
      case "update_preferences": return `préférences : ${(output.changed || []).join(", ") || output.status}`;
      default: return `${name} → ${output?.status}`;
    }
  }

  // Bouton « Effacer » : les tâches en cours sont arrêtées (leurs résultats tardifs sont ignorés) et
  // le tableau est vidé ; les couleurs repartent de l'orange
  function clearAll() {
    const stopped = list().filter((t) => ["pending", "running"].includes(t.status));
    for (const t of stopped) {
      t.abort.abort();
      t.status = "cancelled";
    }
    tasks.clear();
    heldUtterance = null;
    lastConversation = [];
    nextColor = 0;
    changed();
    return stopped.length;
  }

  return { handleUserTurn, add, cancel, snapshot, summary, searchRunning, clearAll, tasks };
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
