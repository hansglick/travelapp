// Serveur du prototype « Que fait-on ? » : sert la page, garde les clés API, crée et suit les
// sessions GPT-Live, détient la liste des POI et pousse ses changements au navigateur (flux SSE).
// Lancement : npm start, puis http://localhost:8000

import http from "node:http";
import { timingSafeEqual, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PoiStore } from "./agent/store.mjs";
import { createResolver, reverseGeocode } from "./agent/places.mjs";
import { createLiveManager, distanceM } from "./agent/live.mjs";
import { createMetrics } from "./agent/metrics.mjs";
import { createBriefing } from "./agent/briefing.mjs";
import { createTools } from "./agent/tools.mjs";
import { createTaskBoard } from "./agent/tasks.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
// En local, le serveur n'écoute que le PC ; sur Render (variable RENDER fournie par Render), tout le réseau
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
// Origines autorisées à appeler l'API : la page locale, et l'adresse publique (fournie par Render)
const ALLOWED_ORIGINS = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  process.env.RENDER_EXTERNAL_URL,
  process.env.PUBLIC_URL,
].filter(Boolean));
const MAX_SESSIONS_PER_HOUR = Number(process.env.MAX_SESSIONS_PER_HOUR) || 30; // garde-fou de coût
const MAX_BODY = 64 * 1024;
const GEOCODE_MIN_MOVE_M = 300;

// ---- Clés : variables d'environnement, sinon fichiers .env (jamais envoyées au navigateur) ----

function readEnvFile(path) {
  if (!path || !existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

const localEnv = readEnvFile(join(ROOT, ".env"));
const openaiEnvFile = process.env.OPENAI_ENV_FILE || localEnv.OPENAI_ENV_FILE;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || localEnv.OPENAI_API_KEY || readEnvFile(openaiEnvFile && resolve(ROOT, openaiEnvFile)).OPENAI_API_KEY;
const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY || localEnv.GOOGLE_MAPS_API_KEY;
// Clé donnée à la page pour la carte (facultative) : peut être restreinte au site ; sinon la même clé
const GOOGLE_BROWSER_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY || localEnv.GOOGLE_MAPS_BROWSER_KEY || GOOGLE_API_KEY;
// Mot de passe d'accès (facultatif) : demandé par le navigateur avant d'ouvrir l'application
const APP_PASSWORD = process.env.APP_PASSWORD || localEnv.APP_PASSWORD || "";

if (!OPENAI_API_KEY) console.warn("⚠ OPENAI_API_KEY introuvable : la conversation vocale sera indisponible.");
if (!GOOGLE_API_KEY) console.warn("⚠ GOOGLE_MAPS_API_KEY introuvable : les lieux ne pourront pas être localisés.");

// ---- État, mesures, résolution Google, sessions GPT-Live ----

const store = new PoiStore();
const metrics = createMetrics();
const resolvePoi = createResolver({ apiKey: GOOGLE_API_KEY, metrics });

// Navigateurs abonnés au flux d'événements
const clients = new Set();
let voiceState = { type: "voice", state: "closed" };

function broadcast(message) {
  if (message.type === "voice") voiceState = message;
  const data = `data: ${JSON.stringify(message)}\n\n`;
  for (const res of clients) res.write(data);
}

const briefing = OPENAI_API_KEY ? createBriefing({ apiKey: OPENAI_API_KEY, metrics }) : null;
// Tableau des tâches (détection et exécution) et session vocale, qui se tiennent mutuellement informés
let board = null;
const live = createLiveManager({ apiKey: OPENAI_API_KEY, store, metrics, broadcast, briefing, board: () => board });
const tools = createTools({ store, resolvePoi, broadcast, uiConnected: () => clients.size > 0, appNote: (text) => live.appNote(text) });
let tasksTimer = null;
board = createTaskBoard({
  apiKey: OPENAI_API_KEY, store, tools, metrics,
  // Écran « Tâches » mis à jour en direct (regroupé sur 100 ms)
  onChange: () => {
    clearTimeout(tasksTimer);
    tasksTimer = setTimeout(() => broadcast({ type: "tasks", tasks: board.snapshot() }), 100);
  },
  notify: (event) => live.onTaskEvent(event),
});

// Chaque changement de l'état est poussé au navigateur (regroupé sur quelques ms) ; le navigateur
// confirme l'affichage, ce qui mesure le délai d'actualisation de l'interface
const sentAt = new Map();
let stateTimer = null;
store.on("change", () => {
  clearTimeout(stateTimer);
  stateTimer = setTimeout(() => {
    sentAt.set(store.version, Date.now());
    if (sentAt.size > 100) sentAt.delete(sentAt.keys().next().value);
    broadcast({ type: "state", ...store.snapshot() });
  }, 30);
});

// Plus aucun navigateur connecté : la conversation est fermée au bout de 30 s (coût)
let orphanTimer = null;
function watchClients() {
  clearTimeout(orphanTimer);
  if (!clients.size && live.active()) orphanTimer = setTimeout(() => live.close("client_gone"), 30000);
}

// ---- HTTP ----

const STATIC = { "/": "index.html", "/index.html": "index.html" };
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Requête trop volumineuse"), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("JSON invalide"), { status: 400 });
  }
}

const validPosition = (p) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

let lastGeocoded = null;
const sessionStarts = []; // heures de création des dernières conversations (limite par heure)

// Accès protégé par mot de passe (authentification HTTP « Basic », n'importe quel identifiant)
const digest = (text) => createHash("sha256").update(text).digest();
function authorized(req) {
  if (!APP_PASSWORD) return true;
  const [scheme, encoded] = (req.headers.authorization || "").split(" ");
  if (scheme !== "Basic" || !encoded) return false;
  const password = Buffer.from(encoded, "base64").toString("utf8").split(":").slice(1).join(":");
  return timingSafeEqual(digest(password), digest(APP_PASSWORD));
}

const routes = {
  "GET /api/events": (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "state", ...store.snapshot() })}\n\n`);
    res.write(`data: ${JSON.stringify(voiceState)}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "tasks", tasks: board.snapshot() })}\n\n`);
    clients.add(res);
    watchClients();
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
      watchClients();
    });
  },

  // Offre SDP du navigateur → session GPT-Live (la clé reste ici)
  "POST /api/live/session": async (req, res) => {
    if (!OPENAI_API_KEY) return json(res, 503, { error: "Clé OpenAI absente sur le serveur." });
    const hourAgo = Date.now() - 3600_000;
    while (sessionStarts.length && sessionStarts[0] < hourAgo) sessionStarts.shift();
    if (sessionStarts.length >= MAX_SESSIONS_PER_HOUR) return json(res, 429, { error: "Trop de conversations cette heure-ci." });
    sessionStarts.push(Date.now());
    const { sdp } = await readJson(req);
    if (typeof sdp !== "string" || !sdp.trim() || sdp.length > MAX_BODY) return json(res, 400, { error: "Offre SDP manquante." });
    try {
      json(res, 201, await live.create({ sdp }));
    } catch (err) {
      json(res, err.status && err.status < 500 ? err.status : 502, { error: "La session vocale n'a pas pu démarrer.", detail: err.detail || null });
    }
  },

  "POST /api/live/close": async (req, res) => {
    const info = await readJson(req).catch(() => ({}));
    if (info.reason) {
      const clip = (v) => String(v ?? "-").slice(0, 120);
      console.log(`[live] le navigateur abandonne : ${clip(info.reason)} (connexion ${clip(info.connection)}, ICE ${clip(info.ice)}, canal ${clip(info.channel)})`);
    }
    await live.close(info.reason ? "browser_gave_up" : "close_requested");
    json(res, 200, { ok: true });
  },

  // Contexte fourni par l'appli : position (géolocalisation de l'appli, jamais estimée par le modèle)
  "POST /api/context": async (req, res) => {
    const { position, source, timezone } = await readJson(req);
    if (!validPosition(position)) return json(res, 400, { error: "Position invalide." });
    const patch = { position: { lat: position.lat, lng: position.lng }, positionSource: source === "gps" ? "gps" : "app" };
    if (typeof timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone)) patch.timezone = timezone;
    store.setContext(patch);
    json(res, 200, { ok: true });
    // Ville et quartier : seulement si la position a beaucoup changé (coût du géocodage)
    if (GOOGLE_API_KEY && (!lastGeocoded || distanceM(lastGeocoded, patch.position) >= GEOCODE_MIN_MOVE_M)) {
      lastGeocoded = patch.position;
      const place = await reverseGeocode(GOOGLE_API_KEY, patch.position);
      metrics.count("google_geocode");
      if (place) store.setContext({ place });
    }
    live.positionChanged();
  },

  // Action de l'utilisateur sur un lieu dans l'interface : décoché / recoché / visité
  "POST /api/pois/update": async (req, res) => {
    const { id, included, visited } = await readJson(req);
    if (typeof id !== "string") return json(res, 400, { error: "id manquant." });
    let poi = null;
    if (typeof included === "boolean") {
      poi = store.setIncluded(id, included);
      if (poi) live.appNote(included
        ? `L'utilisateur a remis « ${poi.place?.name || poi.name} » dans son itinéraire depuis l'écran.`
        : `L'utilisateur a retiré « ${poi.place?.name || poi.name} » de son itinéraire depuis l'écran (il reste dans la liste, décoché) : ne le considère plus comme sélectionné.`);
    }
    if (visited === true) {
      poi = store.setVisited(id);
      if (poi) live.appNote(`L'utilisateur vient d'arriver à « ${poi.place?.name || poi.name} ».`);
    }
    json(res, 200, { ok: true, version: store.version });
  },

  // Bouton « Effacer » de la liste : tous les lieux disparaissent (préférences gardées)
  "POST /api/pois/clear": async (req, res) => {
    const count = store.clearPois();
    board.resetColors(); // les couleurs repartent de l'orange
    if (count) live.appNote("L'utilisateur a effacé tous les lieux depuis l'écran : la liste est vide. Ses préférences sont conservées. Ne parle plus des anciens lieux comme s'ils étaient sélectionnés.");
    json(res, 200, { ok: true, removed: count, version: store.version });
  },

  // Cadenas posé ou retiré à la main dans la page : pin = { position: "index", index } ou null
  "POST /api/pois/pin": async (req, res) => {
    const { id, pin } = await readJson(req);
    if (typeof id !== "string") return json(res, 400, { error: "id manquant." });
    const result = pin ? store.pinSteps({ pins: [{ id, ...pin }] }) : store.pinSteps({ unpin_ids: [id] });
    const changed = result.applied?.[0];
    if (changed) live.appNote(pin
      ? `L'utilisateur a figé « ${changed.name} » en ${changed.position} depuis l'écran.`
      : `L'utilisateur a retiré le cadenas de « ${changed.name} » depuis l'écran.`);
    json(res, 200, { ok: result.status === "applied", version: store.version });
  },

  // Numéros d'étape affichés par la page ({ id: numéro }), pour « supprime le point n° 6 »
  "POST /api/pois/numbers": async (req, res) => {
    const { numbers } = await readJson(req);
    if (!numbers || typeof numbers !== "object") return json(res, 400, { error: "numbers manquant." });
    store.setMapNumbers(numbers);
    res.writeHead(204).end();
  },

  // Confirmation d'affichage d'une version de la liste (délai d'actualisation de l'interface)
  "POST /api/ui-ack": async (req, res) => {
    const { version } = await readJson(req);
    const sent = sentAt.get(version);
    if (sent) metrics.time("ui_refresh_ms", Date.now() - sent);
    res.writeHead(204).end();
  },

  "GET /api/metrics": (req, res) => json(res, 200, metrics.summary()),

  // Clé Google pour la carte : lue dans .env, jamais écrite dans le code de la page (dépôt public)
  "GET /api/config": (req, res) => json(res, 200, { googleMapsKey: GOOGLE_BROWSER_KEY || null }),

  // Tests sans micro (QFO_DEV=1) : demande tapée, traitée comme une prise de parole (pas besoin de
  // session vocale) ; la réponse arrive une fois les tâches détectées
  "POST /api/dev/say": async (req, res) => {
    if (process.env.QFO_DEV !== "1") return json(res, 404, { error: "Introuvable." });
    const { text } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text manquant." });
    await live.typed(text.slice(0, 500));
    json(res, 200, { ok: true, tasks: board.snapshot().slice(0, 5).map((t) => `${t.id} ${t.status} ${t.title}`) });
  },

  // Repartir d'une liste vide (tests)
  "POST /api/reset": async (req, res) => {
    const context = store.context;
    store.reset();
    board.resetColors();
    store.context = context;
    store.emit("change", {});
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = routes[`${req.method} ${url.pathname}`];
  // Vérification de santé de Render : publique, sans aucune donnée
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  if (!authorized(req)) {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Que fait-on", charset="UTF-8"', "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Mot de passe requis.");
  }
  try {
    if (route) {
      // Seule la page servie par ce serveur peut appeler l'API
      if (req.method === "POST" && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: "Origine non autorisée." });
      return await route(req, res);
    }
    const file = STATIC[url.pathname];
    if (req.method !== "GET" || !file) return json(res, 404, { error: "Introuvable." });
    const body = await readFile(join(ROOT, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch (err) {
    console.error(`[http] ${req.method} ${url.pathname}`, err.message);
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : "Erreur interne." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Que fait-on ? → ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
  console.log(`Clés : OpenAI ${OPENAI_API_KEY ? "✓" : "✗"}, Google ${GOOGLE_API_KEY ? "✓" : "✗"}${GOOGLE_BROWSER_KEY !== GOOGLE_API_KEY ? " (+ clé navigateur)" : ""}, mot de passe ${APP_PASSWORD ? "✓" : "aucun"}`);
});
