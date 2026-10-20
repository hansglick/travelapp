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


export function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

export function createLiveManager({ apiKey, store, metrics, broadcast, board }) {
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
      createdAt: Date.now(),
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
      finish(s, s.closing ? "closed" : "connection_lost");
    });
    ws.on("error", (err) => console.error("[live] sideband", err.message));

    // Garde-fous de coût : inactivité prolongée et durée maximale. Chaque minuterie ne ferme que SA
    // session (jamais celle qui l'a remplacée).
    s.timers.push(setInterval(() => {
      if (Date.now() - s.lastActivity > IDLE_CLOSE_MS) close("idle", s);
    }, 15000));
    s.timers.push(setTimeout(() => close("max_duration", s), MAX_SESSION_MS));
  }

  function send(s, event) {
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(event));
  }

  function onEvent(s, event) {
    switch (event.type) {
      case "session.started":
        console.log(`[live] session démarrée (${Math.round((Date.now() - s.createdAt) / 1000)} s après la création)`);
        broadcast({ type: "voice", state: "listening" });
        break;

      // État de la connexion audio entre le navigateur et OpenAI
      case "transport.failed":
      case "transport.answered":
      case "transport.ringing":
        console.log(`[live] ${event.type}`, JSON.stringify(event).slice(0, 300));
        break;

      case "info":
        console.log("[live] info", event.code, event.message);
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
        console.log(`[live] session fermée : ${event.reason} (${Math.round((Date.now() - s.createdAt) / 1000)} s après la création)`);
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

  function onTaskEvent({ type, task, summary, question }) {
    const s = session;
    console.log(`[tâches] ${task.id} ${type} « ${task.title} »${type === "done" || type === "failed" ? ` : ${task.result}` : ""}`);
    broadcast({ type: "agent", state: board().searchRunning().length ? "searching" : summary.startsWith("Plus aucune") ? "idle" : "working" });
    if (!s || s.closing) return;
    // Bouton de la carte (découverte de la ville) : hors de la conversation, le guide n'en dit rien
    if (task.kind === "discover") return;
    if (type === "question") {
      // Question d'affinage avant une recherche : le guide la pose tout de suite
      send(s, {
        type: "session.commentary.append", event_id: `question_${task.id}_${Date.now()}`, delegation_id: null,
        content: `[APP] Question d'affinage pour la recherche « ${task.title} », à poser maintenant avec tes mots, puis attends la réponse : « ${question} »`.slice(0, 1400),
      });
    } else if (type === "started" && task.kind === "info") {
      appNote(`Question en cours de vérification : « ${task.title} ». Réponse dans quelques secondes : dis seulement « je regarde », sans parler de météo ni d'événements.`);
    } else if (type === "started") {
      appNote(`Tâche lancée : « ${task.title} ». ${summary}`);
    } else if (type === "done" || type === "failed") {
      // Recherche, localisation, point de retour : le guide dit seulement que c'est fait ; question
      // sur un lieu ou modification de la liste : il donne la réponse
      const brief = type === "done" && ["search", "locate", "self"].includes(task.kind);
      const content = brief
        ? `[APP] Tâche terminée — « ${task.title} ». Dis en une phrase courte combien de lieux sont affichés, sans les détailler ; si une analyse web est en cours, dis ce que tu vérifies (« J'ai trouvé 12 restaurants thaïs, je vérifie lesquels servent du poisson ») ; si des termes n'ont pas été pris en compte (trop vagues), dis-le en quelques mots (« je ne peux pas savoir s'ils sont petits »). Pour toi : ${task.result}`
        : `[APP] ${type === "done" ? "Tâche terminée" : "Tâche échouée"} — « ${task.title} » : ${task.result}`;
      send(s, {
        type: "session.commentary.append", event_id: `task_${task.id}_${Date.now()}`, delegation_id: null,
        content: content.slice(0, 1400),
      });
      appNote(summary);
    } else if (type === "cancelled") {
      appNote(`Tâche « ${task.title} » arrêtée${task.replacedBy ? " et relancée avec la précision" : ""}. ${summary}`);
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

  // Bouton « Effacer » : la conversation retenue comme contexte des tâches est oubliée, ainsi que la
  // phrase en cours de transcription
  function clearConversation() {
    conversation.length = 0;
    const s = session;
    if (s) {
      clearTimeout(s.userTimer);
      s.userTurn = "";
    }
  }

  // Demande tapée (tests sans micro) : traitée comme une prise de parole de l'utilisateur
  function typed(text) {
    console.log("[utilisateur, tapé]", text);
    remember(`Utilisateur : ${text}`);
    return board().handleUserTurn(text, conversation.slice(-10));
  }

  // ---- Fermeture ----

  // s : la session à fermer (par défaut, la session en cours)
  async function close(reason = "close_requested", s = session) {
    if (!s || s.closing) return;
    s.closing = true;
    console.log(`[live] fermeture demandée : ${reason} (${Math.round((Date.now() - s.createdAt) / 1000)} s après la création)`);
    send(s, { type: "session.close", event_id: `close_${Date.now()}` });
    // Sans session.closed dans le délai : on libère tout de même (consommation finale non confirmée)
    s.timers.push(setTimeout(() => finish(s, `${reason} (fin non confirmée)`), CLOSE_TIMEOUT_MS));
  }

  // Nettoyage d'une session terminée, qu'elle soit encore la session en cours ou qu'elle ait été
  // remplacée entre-temps : ses minuteries sont toujours arrêtées
  function finish(s, reason) {
    if (s.finished) return;
    s.finished = true;
    s.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    clearTimeout(s.noteTimer);
    clearTimeout(s.userTimer);
    clearTimeout(s.guideTimer);
    if (s.ws && s.ws.readyState <= WebSocket.OPEN) s.ws.close();
    if (session !== s) {
      console.log(`[live] ancienne session nettoyée (${reason})`);
      return;
    }
    session = null;
    // Plus personne pour répondre aux questions d'affinage : les recherches partent avec ce qu'on sait
    board().launchClarifying("fin de la conversation");
    console.log("[live] bilan de la session", JSON.stringify(metrics.summary()));
    broadcast({ type: "voice", state: "closed", reason });
  }

  // Information à dire à l'utilisateur maintenant (fin de l'analyse web d'une recherche…)
  function announce(text) {
    const s = session;
    if (!s || s.closing) return;
    send(s, { type: "session.commentary.append", event_id: `announce_${Date.now()}`, delegation_id: null, content: `[APP] ${text}`.slice(0, 1400) });
  }

  return {
    create,
    close,
    typed,
    clearConversation,
    appNote,
    announce,
    positionChanged,
    onTaskEvent,
    active: () => Boolean(session && !session.closing),
  };
}
