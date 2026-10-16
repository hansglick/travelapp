// Session GPT-Live : création (WebRTC, offre SDP du navigateur), suivi par le serveur via la
// connexion « sideband », et fermeture.
//
// Délégation « par l'application » : GPT-Live ne fait que converser. Le serveur écoute la
// transcription ; à chaque fin de prise de parole, le tableau des tâches (tasks.mjs) détecte et lance
// les tâches, puis le serveur informe le guide de leur avancement et lui transmet les résultats.
// Le navigateur porte l'audio (micro et haut-parleur) ; il ne peut envoyer que session.close.

import WebSocket from "ws";
import { LIVE_MODEL, LIVE_INSTRUCTIONS, greetingMessage } from "./prompts.mjs";

const API = "https://api.openai.com/v1";
const IDLE_CLOSE_MS = 3 * 60 * 1000;       // personne ne parle depuis 3 min : on ferme (coût)
const MAX_SESSION_MS = 20 * 60 * 1000;     // durée maximale d'une conversation
const CLOSE_TIMEOUT_MS = 15000;
const APP_NOTE_DELAY_MS = 800;             // regroupe les informations [APP] rapprochées
const MOVE_NOTICE_M = 300;                 // déplacement signalé au guide au-delà de cette distance
const TURN_END_MS = 1300;                  // silence qui marque la fin d'une prise de parole
const CONVERSATION_KEEP = 20;              // répliques gardées comme contexte pour les tâches

// Pendant une recherche longue, le guide parle de la météo, des événements puis de la ville, en
// rappelant que la recherche continue. S'il se tait, le serveur le relance (seulement pendant un
// silence, et seulement tant qu'une tâche de recherche est réellement en cours).
const NUDGE_AFTER_MS = 4000;               // pas de relance pour une recherche courte
const NUDGE_SILENCE_MS = 2500;             // silence minimal avant une relance
const NUDGE_EVERY_MS = 12000;              // écart minimal entre deux relances
const NUDGE_MAX = 2;                       // relances au maximum par tâche

const NUDGE_FIRST = "Une recherche est toujours en cours en arrière-plan. Dis-le en une courte phrase, puis donne des idées à l'utilisateur : d'abord la météo des prochains jours, puis les événements prévus cette semaine, d'après les informations [APP] reçues ; à défaut, parle de la ville. Ne pose aucune question.";
const NUDGE_AGAIN = "La recherche est toujours en cours. Rappelle-le en quelques mots et continue avec une autre idée (un autre événement prévu, sinon la ville), sans poser de question.";

export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

export function createLiveManager({ apiKey, store, metrics, broadcast, briefing, board }) {
  let session = null; // une seule conversation à la fois (prototype mono-utilisateur)
  // Conversation transcrite (contexte des tâches), gardée d'une session à l'autre
  const conversation = [];

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
        delegation: { type: "client" },
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
    sendBriefing(session);
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
      opened: null,
      lastActivity: Date.now(),
      lastSpeechAt: 0,              // dernière parole entendue (utilisateur ou guide)
      lastInputEndMs: null,
      awaitingReply: false,
      userTurn: "", userTimer: null, // prise de parole en cours de l'utilisateur
      guideTurn: "", guideTimer: null,
      noteQueue: [],
      noteTimer: null,
      announcedPosition: store.context.position,
      timers: [],
      closing: false,
    };
  }

  // Météo et événements de la semaine, préparés pendant que la conversation démarre, puis transmis
  // au guide sans qu'il les lise : il s'en sert pendant l'attente des recherches
  async function sendBriefing(s) {
    if (!briefing) return;
    const started = Date.now();
    const text = await briefing(store.context).catch(() => null);
    metrics.time("briefing_ms", Date.now() - started);
    if (!text) return;
    await s.opened;
    if (session !== s || s.closing) return;
    console.log("[briefing]", text.replace(/\n/g, " | ").slice(0, 300));
    send(s, {
      type: "session.thinking.append",
      event_id: `briefing_${Date.now()}`,
      delegation_id: null,
      content: `[APP] Sujets pour les moments d'attente pendant une recherche, dans cet ordre : d'abord la météo, puis les événements à venir.\n${text}`.slice(0, 1500),
    });
  }

  // ---- Connexion de suivi (sideband) ----

  function attachSideband(s) {
    const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(s.id)}/attach`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    s.ws = ws;
    s.opened = new Promise((resolve) => ws.once("open", resolve));
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
        onUserSpeech(s, event.delta || "");
        break;

      case "session.output_transcript.delta":
        s.lastActivity = s.lastSpeechAt = Date.now();
        if (s.awaitingReply && s.lastInputEndMs != null) metrics.time("voice_reaction_ms", Math.max(0, event.start_ms - s.lastInputEndMs));
        s.awaitingReply = false;
        onGuideSpeech(s, event.delta || "");
        break;

      // Le guide ne doit rien déléguer ; s'il le fait quand même, on lui rappelle que l'appli s'en charge
      case "session.delegation.created":
        if (event.delegation?.target === "client") {
          send(s, {
            type: "session.thinking.append", event_id: `deleg_${Date.now()}`, delegation_id: event.delegation.id,
            content: "Rien à faire : l'application détecte et exécute elle-même les demandes. Attends les messages [APP].",
          });
        }
        break;

      case "session.usage.updated":
        metrics.voiceSeconds(event.usage?.seconds || 0);
        break;

      case "error":
        console.warn("[live] erreur", event.error?.code, event.error?.message);
        break;

      case "session.closed":
        metrics.voiceSeconds(event.usage?.seconds || 0);
        console.log("[live] session fermée :", event.reason);
        finish(s, event.reason || "closed");
        break;
    }
  }

  // ---- Prises de parole ----

  // Fin de prise de parole de l'utilisateur (silence) : la phrase complète part au tableau des tâches
  function onUserSpeech(s, delta) {
    s.userTurn += delta;
    clearTimeout(s.userTimer);
    s.userTimer = setTimeout(() => {
      const text = s.userTurn.replace(/\s+/g, " ").trim();
      s.userTurn = "";
      if (!text) return;
      console.log("[utilisateur]", text);
      remember(`Utilisateur : ${text}`);
      board().handleUserTurn(text, conversation.slice(-10));
    }, TURN_END_MS);
  }

  function onGuideSpeech(s, delta) {
    s.guideTurn += delta;
    clearTimeout(s.guideTimer);
    s.guideTimer = setTimeout(() => {
      const text = s.guideTurn.replace(/\s+/g, " ").trim();
      s.guideTurn = "";
      if (!text) return;
      console.log("[guide]", text);
      remember(`Guide : ${text}`);
    }, TURN_END_MS);
  }

  function remember(line) {
    conversation.push(line.slice(0, 600));
    if (conversation.length > CONVERSATION_KEEP) conversation.shift();
  }

  // ---- Avancement des tâches, transmis au guide ----

  function onTaskEvent({ type, task, summary }) {
    const s = session;
    console.log(`[tâches] ${task.id} ${type} « ${task.title} »${type === "done" || type === "failed" ? ` : ${task.result}` : ""}`);
    broadcast({ type: "agent", state: board().searchRunning().length ? "searching" : summary.startsWith("Plus aucune") ? "idle" : "working" });
    if (!s || s.closing) return;
    if (type === "started") {
      appNote(`Tâche lancée : « ${task.title} ». ${summary}`);
    } else if (type === "done" || type === "failed") {
      // Résultat à annoncer : le guide le dit avec ses mots
      send(s, {
        type: "session.commentary.append", event_id: `task_${task.id}_${Date.now()}`, delegation_id: null,
        content: `[APP] ${type === "done" ? "Tâche terminée" : "Tâche échouée"} — « ${task.title} » : ${task.result}`.slice(0, 1400),
      });
      appNote(summary);
    } else if (type === "cancelled") {
      appNote(`Tâche « ${task.title} » arrêtée${task.replacedBy ? " et relancée avec la précision" : ""}. ${summary}`);
    }
  }

  // Relance du guide pendant une recherche longue, seulement s'il se tait
  function nudgeDuringSearch(s) {
    if (session !== s || s.closing) return;
    const now = Date.now();
    if (now - s.lastSpeechAt < NUDGE_SILENCE_MS) return;
    const task = board().searchRunning()
      .find((t) => now - t.startedAt >= NUDGE_AFTER_MS && t.nudges < NUDGE_MAX && now - t.lastNudgeAt >= NUDGE_EVERY_MS);
    if (!task) return;
    task.nudges++;
    task.lastNudgeAt = now;
    metrics.count("search_nudges");
    send(s, { type: "session.instructions.append", event_id: `nudge_${now}`, delegation_id: null, content: task.nudges === 1 ? NUDGE_FIRST : NUDGE_AGAIN });
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

  // Demande tapée (tests sans micro) : traitée comme une prise de parole de l'utilisateur
  function typed(text) {
    console.log("[utilisateur, tapé]", text);
    remember(`Utilisateur : ${text}`);
    return board().handleUserTurn(text, conversation.slice(-10));
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
    clearTimeout(s.userTimer);
    clearTimeout(s.guideTimer);
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
    console.log("[live] bilan de la session", JSON.stringify(metrics.summary()));
    broadcast({ type: "voice", state: "closed", reason });
  }

  return {
    create,
    close,
    typed,
    appNote,
    positionChanged,
    onTaskEvent,
    active: () => Boolean(session && !session.closing),
  };
}
