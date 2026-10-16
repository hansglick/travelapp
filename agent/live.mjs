// Session GPT-Live : création (WebRTC, offre SDP du navigateur), suivi par le serveur via la
// connexion « sideband », exécution des fonctions de l'appli et fermeture.
//
// Le navigateur porte l'audio (micro et haut-parleur) ; il ne peut envoyer que session.close.
// Le serveur est le seul à exécuter les fonctions (update_pois, update_preferences, get_selection)
// et à renvoyer leurs résultats au modèle Responses (response.item.create puis response.create).

import WebSocket from "ws";
import {
  LIVE_MODEL, LIVE_INSTRUCTIONS, BACKEND_MODEL, BACKEND_REASONING, BACKEND_INSTRUCTIONS, BACKEND_TOOLS, greetingMessage,
} from "./prompts.mjs";

const API = "https://api.openai.com/v1";
const IDLE_CLOSE_MS = 3 * 60 * 1000;       // personne ne parle depuis 3 min : on ferme (coût)
const MAX_SESSION_MS = 20 * 60 * 1000;     // durée maximale d'une conversation
const CLOSE_TIMEOUT_MS = 15000;
const RESOLUTION_WAIT_MS = 2500;           // update_pois attend au plus ce délai les résultats de Google
const APP_NOTE_DELAY_MS = 800;             // regroupe les informations [APP] rapprochées
const MOVE_NOTICE_M = 300;                 // déplacement signalé au guide au-delà de cette distance

// Pendant une recherche longue, le guide parle de la ville en précisant que la recherche continue.
// S'il se tait, le serveur le relance (seulement pendant un silence, pour ne pas le couper).
const NUDGE_AFTER_MS = 3000;               // pas de relance pour une recherche courte
const NUDGE_SILENCE_MS = 2000;             // silence minimal avant une relance
const NUDGE_EVERY_MS = 9000;               // écart minimal entre deux relances
const NUDGE_MAX = 3;                       // relances au maximum par recherche
const TRANSCRIPT_FLUSH_MS = 1200;          // regroupe les fragments de transcription pour le journal

const NUDGE_FIRST = "La recherche continue en arrière-plan. Dis-le en une courte phrase, puis parle de la ville de l'utilisateur pour lui donner des idées : ses quartiers et leurs ambiances, son histoire, ses incontournables, une anecdote. Ne pose aucune question. Dès que le résultat arrive, termine ta phrase et donne-le.";
const NUDGE_AGAIN = "La recherche est toujours en cours en arrière-plan. Rappelle-le en quelques mots et continue à parler de la ville (autre quartier, autre époque ou autre anecdote), sans poser de question.";

export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

export function createLiveManager({ apiKey, store, resolvePoi, metrics, broadcast, uiConnected }) {
  let session = null; // une seule conversation à la fois (prototype mono-utilisateur)

  function describePlace(place) {
    if (!place) return null;
    return [place.neighborhood, place.city, place.country].filter(Boolean).join(", ");
  }

  function contextLine() {
    const ctx = store.contextForModel();
    const where = ctx.place ? `près de ${describePlace(ctx.place)}` : "position inconnue";
    const gps = ctx.position ? ` (GPS ${ctx.position.lat}, ${ctx.position.lng})` : "";
    const time = ctx.local_time ? ` Il est ${ctx.local_time}.` : "";
    const list = store.selectionForModel().pois;
    const selection = list.length ? ` Liste actuelle : ${list.map((p) => p.name).join(", ")}.` : " La liste de lieux est vide.";
    return `[APP] L'utilisateur est ${where}${gps}.${time}${selection}`;
  }

  // ---- Création ----

  async function create({ sdp }) {
    if (session) await close("replaced");
    const body = {
      session: {
        model: LIVE_MODEL,
        instructions: LIVE_INSTRUCTIONS,
        input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: greetingMessage(contextLine()) }] }],
        delegation: {
          type: "responses",
          responses: {
            model: BACKEND_MODEL,
            instructions: BACKEND_INSTRUCTIONS,
            tools: BACKEND_TOOLS,
            tool_choice: "auto",
            parallel_tool_calls: false,
            reasoning: { effort: BACKEND_REASONING },
            text: { verbosity: "low" },
          },
        },
        // Le navigateur n'est pas une source de confiance : il ne peut que fermer la session
        client: { data_channel: { allowed_client_events: ["session.close"], allowed_server_events: "all" } },
      },
      transport: { type: "webrtc", sdp },
    };
    const started = Date.now();
    const response = await fetch(`${API}/live/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("[live] création refusée", response.status, text.slice(0, 500));
      const error = new Error("Création de la session refusée");
      error.status = response.status;
      error.detail = safeErrorMessage(text);
      throw error;
    }
    const result = JSON.parse(text);
    metrics.reset();
    metrics.time("session_create_ms", Date.now() - started);
    session = newSession(result.session.id);
    attachSideband(session);
    return { session: { id: result.session.id }, transport: { type: "webrtc", sdp: result.transport.sdp } };
  }

  function safeErrorMessage(text) {
    try {
      return JSON.parse(text).error?.message?.slice(0, 300) || null;
    } catch {
      return null;
    }
  }

  function newSession(id) {
    return {
      id,
      ws: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
      handledCalls: new Set(),
      activeResponses: new Map(),   // id Responses → { startedAt, delegationId }
      delegations: new Map(),       // id délégation → instant de création (ms)
      searches: new Map(),          // id de l'élément web_search_call → début
      lastInputEndMs: null,
      awaitingReply: false,
      noteQueue: [],
      noteTimer: null,
      tasks: new Map(),             // tâche du backend (une par délégation) → état, voir newTask
      responseTask: new Map(),      // id Responses → clé de la tâche
      lastSpeechAt: 0,              // dernière parole entendue (utilisateur ou guide)
      transcript: { user: "", guide: "", timer: null },
      followUps: 0,
      announcedPosition: store.context.position,
      timers: [],
      closing: false,
    };
  }

  // ---- Connexion de suivi (sideband) ----

  function attachSideband(s) {
    const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(s.id)}/attach`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    s.ws = ws;
    ws.on("open", () => console.log("[live] sideband connecté", s.id));
    ws.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      try {
        onEvent(s, event);
      } catch (err) {
        console.error("[live] erreur de traitement", event.type, err);
      }
    });
    ws.on("close", (code) => {
      console.log("[live] sideband fermé", code);
      if (session === s) finish(s, s.closing ? "closed" : "connection_lost");
    });
    ws.on("error", (err) => console.error("[live] sideband", err.message));

    // Garde-fous de coût : inactivité prolongée et durée maximale
    s.timers.push(setInterval(() => {
      if (Date.now() - s.lastActivity > IDLE_CLOSE_MS) close("idle");
    }, 15000));
    s.timers.push(setTimeout(() => close("max_duration"), MAX_SESSION_MS));
    s.timers.push(setInterval(() => nudgeDuringSearch(s), 1000));
  }

  // ---- Tâches du backend ----
  // Une tâche = une délégation de GPT-Live (ou une relance de l'appli) : elle peut enchaîner plusieurs
  // réponses Responses (recherche, appel de fonction, suite…) et se termine sur une réponse sans appel.

  function newTask(key, origin) {
    return {
      key, origin, startedAt: Date.now(), done: false,
      searchStartedAt: null,        // première recherche web de la tâche
      nudges: 0, lastNudgeAt: 0,
      addedIds: [],                 // lieux ajoutés par cette tâche
      requestedCount: null,         // nombre de lieux demandés par l'utilisateur
      refinements: [],              // critères précisés par l'utilisateur pendant la recherche
      refinementsDelivered: false,  // déjà transmis à la tâche elle-même
    };
  }

  function taskFor(s, key) {
    if (!s.tasks.has(key)) s.tasks.set(key, newTask(key, key.startsWith("app_") ? "app" : "voice"));
    return s.tasks.get(key);
  }

  // Recherches web en cours dans d'autres tâches que celle qui demande
  function searchesInProgress(s, exceptKey) {
    return [...s.tasks.values()].filter((t) => !t.done && t.searchStartedAt && t.key !== exceptKey);
  }

  function nudgeDuringSearch(s) {
    if (session !== s || s.closing) return;
    const now = Date.now();
    const task = searchesInProgress(s, null)
      .filter((t) => now - t.searchStartedAt >= NUDGE_AFTER_MS && t.nudges < NUDGE_MAX && now - t.lastNudgeAt >= NUDGE_EVERY_MS)[0];
    if (!task || now - s.lastSpeechAt < NUDGE_SILENCE_MS) return;
    task.nudges++;
    task.lastNudgeAt = now;
    metrics.count("search_nudges");
    send(s, { type: "session.instructions.append", event_id: `nudge_${now}`, delegation_id: null, content: task.nudges === 1 ? NUDGE_FIRST : NUDGE_AGAIN });
  }

  // Fin d'une tâche : si l'utilisateur a précisé un critère pendant sa recherche et qu'elle ne l'a pas
  // reçu, l'appli lance la suite : filtrer les lieux ajoutés, puis compléter s'il en manque
  function finishTask(s, task) {
    if (task.done) return;
    task.done = true;
    if (!task.refinements.length || task.refinementsDelivered) return;
    const added = task.addedIds.map((id) => store.pois.get(id)).filter(Boolean);
    if (!added.length) return; // rien n'a été ajouté : le critère reste enregistré pour la suite
    if (s.followUps >= 5) return; // garde-fou contre une boucle de relances
    s.followUps++;
    const list = added.map((p) => `${p.id} « ${p.place?.name || p.name} »`).join(", ");
    const count = task.requestedCount ? `L'utilisateur avait demandé ${task.requestedCount} lieu(x).` : "";
    const text = `[APP] Pendant la recherche précédente, l'utilisateur a précisé : ${task.refinements.map((r) => `« ${r} »`).join(", ")}. `
      + `Lieux ajoutés par cette recherche : ${list}. ${count} `
      + "1) Retire (update_pois remove) ceux qui ne respectent pas ces critères d'après tes sources ; en cas de doute, garde-les. "
      + "2) S'il en reste moins que demandé, cherche des compléments qui respectent tous les critères et ajoute-les. "
      + "Puis réponds brièvement au guide : ce qui a été retiré, ajouté, ou que tout convenait.";
    console.log("[live] suite après précision :", task.refinements.join(" | "));
    const key = `app_${Date.now()}`;
    s.pendingAppTask = taskFor(s, key);
    send(s, { type: "response.item.create", event_id: `${key}_msg`, item: { type: "message", role: "developer", content: [{ type: "input_text", text }] } });
    send(s, { type: "response.create", event_id: `${key}_go` });
  }

  // Journal lisible de la conversation : fragments regroupés par locuteur
  function logTranscript(s, who, delta) {
    const t = s.transcript;
    t[who] += delta;
    clearTimeout(t.timer);
    t.timer = setTimeout(() => {
      for (const k of ["user", "guide"]) {
        if (t[k].trim()) console.log(k === "user" ? "[utilisateur]" : "[guide]", t[k].trim());
        t[k] = "";
      }
    }, TRANSCRIPT_FLUSH_MS);
  }

  function send(s, event) {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(event));
  }

  function onEvent(s, event) {
    switch (event.type) {
      case "session.started":
        broadcast({ type: "voice", state: "listening" });
        break;

      case "session.input_transcript.delta":
        s.lastActivity = s.lastSpeechAt = Date.now();
        s.lastInputEndMs = event.end_ms;
        s.awaitingReply = true;
        logTranscript(s, "user", event.delta || "");
        break;

      case "session.output_transcript.delta":
        s.lastActivity = s.lastSpeechAt = Date.now();
        logTranscript(s, "guide", event.delta || "");
        // Temps de réaction vocale : fin de la parole de l'utilisateur → début de la réponse
        if (s.awaitingReply && s.lastInputEndMs != null) metrics.time("voice_reaction_ms", event.start_ms - s.lastInputEndMs);
        s.awaitingReply = false;
        break;

      case "session.delegation.created":
        s.delegations.set(event.delegation.id, Date.now());
        taskFor(s, event.delegation.id);
        metrics.count("delegations");
        broadcast({ type: "agent", state: "working" });
        break;

      case "response.event":
        onResponseEvent(s, event.event || {}, event.delegation_id);
        break;

      case "session.usage.updated":
        metrics.voiceSeconds(event.usage?.seconds || 0);
        break;

      case "error":
        console.warn("[live] erreur", event.error?.code, event.error?.message);
        if (event.error?.code === "responses_validation_failed") broadcast({ type: "voice", state: "error", message: "Configuration de l'agent refusée." });
        break;

      case "session.closed":
        metrics.voiceSeconds(event.usage?.seconds || 0);
        console.log("[live] session fermée :", event.reason);
        finish(s, event.reason || "closed");
        break;
    }
  }

  // Tâche d'un événement : la délégation de GPT-Live, sinon la relance de l'appli en cours
  function taskKeyOf(s, ev, delegationId) {
    if (delegationId) return delegationId;
    const responseId = ev.response?.id || ev.response_id;
    if (responseId && s.responseTask.has(responseId)) return s.responseTask.get(responseId);
    return s.pendingAppTask?.key || "app_unknown";
  }

  function onResponseEvent(s, ev, delegationId) {
    const task = taskFor(s, taskKeyOf(s, ev, delegationId));
    switch (ev.type) {
      case "response.created":
        s.activeResponses.set(ev.response?.id, { startedAt: Date.now(), delegationId });
        s.responseTask.set(ev.response?.id, task.key);
        break;

      case "response.output_item.added":
        if (ev.item?.type === "web_search_call") {
          s.searches.set(ev.item.id, Date.now());
          task.searchStartedAt ||= Date.now();
          broadcast({ type: "agent", state: "searching" });
        }
        break;

      case "response.output_item.done": {
        const item = ev.item || {};
        if (item.type === "web_search_call") {
          metrics.count("web_search");
          const start = s.searches.get(item.id);
          if (start) metrics.time("web_search_ms", Date.now() - start);
        } else if (item.type === "message") {
          const text = (item.content || []).map((c) => c.text || "").join(" ").trim();
          if (text) console.log("[backend →  guide]", text.slice(0, 400));
        } else if (item.type === "function_call") {
          const created = s.delegations.get(delegationId);
          if (created) {
            metrics.time("delegation_to_first_tool_ms", Date.now() - created);
            s.delegations.delete(delegationId); // seul le premier appel de chaque délégation compte
          }
          task.hasOpenCall = true;
          handleFunctionCall(s, item, task);
        }
        break;
      }

      case "response.completed":
      case "response.failed":
      case "response.incomplete":
      case "response.cancelled": {
        const active = s.activeResponses.get(ev.response?.id);
        if (active) metrics.time("backend_response_ms", Date.now() - active.startedAt);
        s.activeResponses.delete(ev.response?.id);
        metrics.backendUsage(ev.response?.usage);
        if (ev.type !== "response.completed") console.warn("[live] réponse backend", ev.type, ev.response?.error?.message || "");
        // Réponse sans appel de fonction : la tâche est terminée (sinon une suite va être demandée)
        if (!task.hasOpenCall) finishTask(s, task);
        task.hasOpenCall = false;
        if (!s.activeResponses.size) broadcast({ type: "agent", state: "idle" });
        break;
      }
    }
  }

  // ---- Fonctions de l'appli ----

  async function handleFunctionCall(s, item, task) {
    if (s.handledCalls.has(item.call_id)) return; // déjà exécutée : on ne la rejoue pas
    s.handledCalls.add(item.call_id);
    const started = Date.now();
    let output;
    try {
      const args = item.arguments ? JSON.parse(item.arguments) : {};
      output = await runFunction(s, task, item.name, args);
      // Critère précisé par l'utilisateur pendant cette recherche : transmis à la tâche elle-même,
      // qui peut encore filtrer et compléter ses résultats
      if (task.refinements.length && !task.refinementsDelivered && item.name !== "note_refinement") {
        task.refinementsDelivered = true;
        output.user_refinements_during_search = {
          criteria: task.refinements,
          instruction: "Pendant ta recherche, l'utilisateur a précisé ces critères. Retire les lieux que tu as ajoutés qui ne les respectent pas, et complète si nécessaire jusqu'au nombre demandé.",
        };
      }
    } catch (err) {
      console.warn("[live] fonction", item.name, err.message);
      output = { status: "error", message: "Arguments invalides ou erreur interne." };
    }
    metrics.time(`function_${item.name}_ms`, Date.now() - started);
    console.log(`[live] ${item.name} →`, output.status, output.code || "", output.version ?? "");
    if (session !== s || s.closing) return; // session terminée entre-temps : le résultat est ignoré
    send(s, { type: "response.item.create", event_id: `out_${item.call_id}`, item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(output) } });
    send(s, { type: "response.create", event_id: `continue_${item.call_id}` });
  }

  async function runFunction(s, task, name, args) {
    if (name === "get_selection") {
      const busy = searchesInProgress(s, task.key).length > 0;
      return { status: "ok", ...store.selectionForModel(), ...(busy ? { search_in_progress: true } : {}) };
    }
    if (name === "update_preferences") return store.updatePreferences(args);
    if (name === "pin_steps") return store.pinSteps(args);
    if (name === "find_places_near") return findPlacesNear(args);
    if (name === "show_place") {
      if (!uiConnected()) return { status: "error", message: "L'écran de l'application n'est pas ouvert." };
      if (args.poi_id === null) {
        broadcast({ type: "ui", action: "close_bubble" });
        return { status: "ok", message: "Bulle fermée." };
      }
      const poi = store.pois.get(args.poi_id);
      if (!poi) return { status: "error", message: "Identifiant inconnu : relis la sélection." };
      if (poi.status !== "resolved") return { status: "error", message: "Ce lieu n'est pas encore placé sur la carte : pas de bulle ni de photos." };
      broadcast({ type: "ui", action: "open_bubble", id: poi.id });
      return { status: "ok", message: `Bulle de « ${poi.place?.name || poi.name} » ouverte sur la carte (photos et description).` };
    }
    if (name === "note_refinement") {
      const criterion = typeof args.criterion === "string" ? args.criterion.trim().slice(0, 160) : "";
      if (!criterion) return { status: "error", message: "criterion manquant." };
      store.updatePreferences({ add_note: criterion }); // gardé pour les recherches suivantes
      const running = searchesInProgress(s, task.key);
      for (const t of running) t.refinements.push(criterion);
      return running.length
        ? { status: "noted", message: "Critère noté : il sera appliqué aux résultats de la recherche en cours (filtrage, puis compléments si besoin) et aux recherches suivantes. Ne relance pas de recherche." }
        : { status: "no_search_in_progress", message: "Aucune recherche en cours : le critère est enregistré. Applique-le directement à la liste actuelle si besoin." };
    }
    if (name === "update_pois") {
      const result = store.updatePois(args);
      if (Number.isInteger(args.requested_count) && args.requested_count > 0) task.requestedCount = args.requested_count;
      if (result.status === "applied" && result.added?.length) {
        task.addedIds.push(...result.added.map((p) => p.id));
        // Localisation sur la carte : on attend un court instant pour renvoyer au modèle le statut
        // de chaque lieu (il peut corriger une requête introuvable dans la foulée). Les lieux choisis
        // parmi les candidats de find_places_near sont déjà localisés.
        const pending = result.added.filter((p) => p.status === "pending").map((p) => resolveAndStore(p.id));
        await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, RESOLUTION_WAIT_MS))]);
        const byId = new Map(store.selectionForModel().pois.map((p) => [p.id, p]));
        result.added = result.added.map((p) => ({ ...p, status: byId.get(p.id)?.status || "removed_duplicate" }));
        result.selection = store.selectionForModel();
        result.version = store.version;
        delete result.note;
        if (result.added.some((p) => p.status === "pending")) result.note = "Certains lieux sont encore en cours de localisation.";
      }
      return result;
    }
    return { status: "error", message: `Fonction inconnue : ${name}` };
  }

  // Lieux autour d'un repère : un lieu de la liste, la position de l'utilisateur, ou un endroit nommé
  async function findPlacesNear(args) {
    const what = typeof args.what === "string" ? args.what.trim().slice(0, 120) : "";
    if (!what) return { status: "error", message: "what manquant." };
    const radius = Math.min(2000, Math.max(100, Number.isInteger(args.radius_m) ? args.radius_m : 400));
    const position = store.context.position;
    // Repères : l'endroit nommé (« près du terrain de foot ») centre la recherche ; le lieu de la liste
    // sert à situer les candidats (« au sud de la forteresse »). À défaut, l'utilisateur.
    const anchors = [];
    if (args.anchor_place) {
      const found = await resolvePoi.locate(args.anchor_place.slice(0, 160), position);
      if (!found) return { status: "not_found", message: `Repère introuvable : « ${args.anchor_place} ».` };
      anchors.push(found);
    }
    if (args.anchor_poi_id) {
      const poi = store.pois.get(args.anchor_poi_id);
      if (!poi?.place) return { status: "error", message: "Repère inconnu ou pas encore placé sur la carte." };
      anchors.push({ name: poi.place.name || poi.name, location: poi.place.location });
    }
    if (!anchors.length) {
      if (!position) return { status: "error", message: "Aucun repère : position de l'utilisateur inconnue." };
      anchors.push({ name: "l'utilisateur", location: position });
    }
    const found = await resolvePoi.searchNear({ textQuery: what, anchors, radius, position });
    const anchorNames = anchors.map((a) => a.name).join(" et ");
    console.log(`[places] « ${what} » près de ${anchorNames} :`, found.map((c) => `${c.place.name} (${c.direction})`).join(" | ") || "rien");
    if (!found.length) return { status: "not_found", anchors: anchorNames, message: `Aucun résultat pour « ${what} » à moins de ${radius} m.` };
    return {
      status: "ok",
      anchors: anchorNames,
      candidates: store.rememberCandidates(found),
      note: "Choisis le candidat qui correspond à la description de l'utilisateur et ajoute-le avec update_pois (candidate_id). Si plusieurs correspondent, propose-les à l'utilisateur (nom et position en quelques mots) et demande-lui lequel.",
    };
  }

  // Résolution Google d'un lieu ajouté, puis mise à jour de l'état (ignorée si le lieu a été retiré)
  async function resolveAndStore(id) {
    const poi = store.pois.get(id);
    if (!poi) return;
    const resolution = await resolvePoi(poi, store.context.position);
    if (!store.pois.has(id)) return; // retiré pendant la recherche : résultat ignoré
    if (resolution.status === "resolved") {
      const twin = [...store.pois.values()].find((p) => p.id !== id && p.place?.placeId === resolution.place.placeId);
      if (twin) {
        store.removeDuplicate(id);
        appNote(`« ${poi.name} » correspond au même lieu que « ${twin.place.name} », déjà dans la liste : le doublon a été retiré.`);
        return;
      }
    }
    store.setResolution(id, {
      status: resolution.status === "error" ? "not_found" : resolution.status,
      place: resolution.place,
      candidates: resolution.candidates,
    });
    if (resolution.status !== "resolved") {
      console.log(`[places] ${resolution.status} : ${poi.query} → ${(resolution.candidates || []).map((c) => c.name).join(" / ") || "aucun résultat"}`);
      const why = resolution.status === "ambiguous"
        ? `plusieurs lieux possibles (${resolution.candidates.map((c) => c.name).join(", ")})`
        : resolution.status === "error" ? "recherche Google indisponible" : "introuvable";
      appNote(`« ${poi.name} » (${id}) n'a pas pu être placé sur la carte : ${why}. Si l'utilisateur y tient, demande au backend de corriger la recherche ou de proposer une alternative.`);
    }
  }

  // ---- Informations de l'appli transmises au guide ([APP], sans les lire à voix haute) ----

  function appNote(text) {
    const s = session;
    if (!s || s.closing) return;
    s.noteQueue.push(text);
    clearTimeout(s.noteTimer);
    s.noteTimer = setTimeout(() => {
      const content = `[APP] ${s.noteQueue.join(" ")}`.slice(0, 1500); // 500 jetons au maximum
      s.noteQueue = [];
      send(s, { type: "session.thinking.append", event_id: `note_${Date.now()}`, delegation_id: null, content });
    }, APP_NOTE_DELAY_MS);
  }

  // Position mise à jour par l'appli : signalée au guide si le déplacement est significatif
  function positionChanged() {
    const s = session;
    const position = store.context.position;
    if (!s || !position) return;
    if (s.announcedPosition && distanceM(s.announcedPosition, position) < MOVE_NOTICE_M) return;
    s.announcedPosition = position;
    appNote(contextLine().replace("[APP] ", "Nouvelle position : "));
  }

  // ---- Fermeture ----

  async function close(reason = "close_requested") {
    const s = session;
    if (!s || s.closing) return;
    s.closing = true;
    console.log("[live] fermeture demandée :", reason);
    send(s, { type: "session.close", event_id: `close_${Date.now()}` });
    // Sans session.closed dans le délai : on libère tout de même (consommation finale non confirmée)
    s.timers.push(setTimeout(() => finish(s, `${reason} (fin non confirmée)`), CLOSE_TIMEOUT_MS));
  }

  function finish(s, reason) {
    if (session !== s) return;
    session = null;
    s.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    clearTimeout(s.noteTimer);
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
    const summary = metrics.summary();
    console.log("[live] bilan de la session", JSON.stringify(summary));
    broadcast({ type: "voice", state: "closed", reason });
  }

  // Demande tapée transmise directement au modèle Responses (tests sans micro)
  function typed(text) {
    const s = session;
    if (!s || s.closing) return false;
    s.pendingAppTask = taskFor(s, `app_typed_${Date.now()}`);
    send(s, { type: "response.item.create", event_id: `typed_${Date.now()}`, item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    send(s, { type: "response.create", event_id: `typed_go_${Date.now()}` });
    return true;
  }

  return {
    create,
    close,
    typed,
    appNote,
    positionChanged,
    active: () => Boolean(session && !session.closing),
  };
}
