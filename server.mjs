// Serveur du prototype « Que fait-on ? » : sert la page, garde les clés API, gère les comptes
// (pseudo + code PIN, inscription sur invitation), et pour chaque compte : sa liste de lieux, ses
// tâches, sa conversation GPT-Live, enregistrées dans SQLite.
// Lancement : npm start, puis http://localhost:8000

import http from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createResolver, reverseGeocode } from "./agent/places.mjs";
import { distanceM } from "./agent/live.mjs";
import { createMetrics } from "./agent/metrics.mjs";
import { openDatabase, createAccounts, createWorkspaceStorage, createTripStorage, createPhrasebookStorage } from "./agent/db.mjs";
import { createPractical } from "./agent/practical.mjs";
import { createNamer } from "./agent/naming.mjs";
import { createWorkspaces } from "./agent/workspace.mjs";

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
const MAX_SESSIONS_PER_HOUR = Number(process.env.MAX_SESSIONS_PER_HOUR) || 30; // garde-fou de coût (tous comptes)
const MAX_BODY = 64 * 1024;
const GEOCODE_MIN_MOVE_M = 300;
const COOKIE = "qfo_session";

// ---- Clés et réglages : variables d'environnement, sinon fichiers .env (jamais envoyés au navigateur) ----

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
const env = (name) => process.env[name] || localEnv[name] || "";
const openaiEnvFile = env("OPENAI_ENV_FILE");
const OPENAI_API_KEY = env("OPENAI_API_KEY") || readEnvFile(openaiEnvFile && resolve(ROOT, openaiEnvFile)).OPENAI_API_KEY;
const GOOGLE_API_KEY = env("GOOGLE_MAPS_API_KEY");
// Clé donnée à la page pour la carte (facultative) : peut être restreinte au site ; sinon la même clé
const GOOGLE_BROWSER_KEY = env("GOOGLE_MAPS_BROWSER_KEY") || GOOGLE_API_KEY;
// Codes d'invitation à usage unique (séparés par des virgules) et emplacement de la base
const INVITE_CODES = env("INVITE_CODES").split(",").map((c) => c.trim()).filter(Boolean);
const DB_PATH = env("DB_PATH") || join(ROOT, "data", "qfo.sqlite");
const DEV = process.env.QFO_DEV === "1";

if (!OPENAI_API_KEY) console.warn("⚠ OPENAI_API_KEY introuvable : la conversation vocale sera indisponible.");
if (!GOOGLE_API_KEY) console.warn("⚠ GOOGLE_MAPS_API_KEY introuvable : les lieux ne pourront pas être localisés.");
if (!INVITE_CODES.length) console.warn("⚠ INVITE_CODES vide : personne ne pourra créer de compte.");

// ---- Comptes, espaces, services partagés ----

const db = openDatabase(DB_PATH);
const accounts = createAccounts(db, { inviteCodes: INVITE_CODES, devInvite: DEV ? "DEV" : null });
const sharedMetrics = createMetrics(); // Google et météo, communs à tous les comptes
const resolvePoi = createResolver({ apiKey: GOOGLE_API_KEY, metrics: sharedMetrics });
const trips = createTripStorage(db);
const workspaces = createWorkspaces({ apiKey: OPENAI_API_KEY, resolvePoi, storage: createWorkspaceStorage(db), trips });
const suggestNames = OPENAI_API_KEY ? createNamer({ apiKey: OPENAI_API_KEY, metrics: sharedMetrics }) : null;
const practical = createPractical({ apiKey: OPENAI_API_KEY, metrics: sharedMetrics, storage: createPhrasebookStorage(db) });

// ---- HTTP ----

const STATIC = { "/": "index.html", "/index.html": "index.html" };
// Mode test : pages de démonstration (dev/)
if (DEV) STATIC["/demo-info"] = "dev/demo-info.html";
const TYPES = { ".html": "text/html; charset=utf-8", ".json": "application/json" };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
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

function sessionToken(req) {
  const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE.length + 1)) : null;
}

// Cookie de connexion : invisible pour le code de la page, envoyé seulement à ce site
function sessionCookie(req, token, maxAge) {
  const secure = process.env.RENDER || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

const validPosition = (p) =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

const sessionStarts = []; // heures de création des dernières conversations (limite par heure, tous comptes)

// Routes publiques : comptes, configuration de la carte
const publicRoutes = {
  "POST /api/auth/register": async (req, res) => {
    const result = accounts.register(await readJson(req));
    if (result.error) return json(res, result.status, { error: result.error });
    console.log(`[comptes] nouveau compte « ${result.user.pseudo} »`);
    json(res, 201, { pseudo: result.user.pseudo }, { "Set-Cookie": sessionCookie(req, result.session.token, result.session.maxAge) });
  },

  "POST /api/auth/login": async (req, res) => {
    const result = accounts.login(await readJson(req));
    if (result.error) return json(res, result.status, { error: result.error });
    json(res, 200, { pseudo: result.user.pseudo }, { "Set-Cookie": sessionCookie(req, result.session.token, result.session.maxAge) });
  },

  "POST /api/auth/logout": async (req, res) => {
    const token = sessionToken(req);
    if (token) accounts.logout(token);
    json(res, 200, { ok: true }, { "Set-Cookie": sessionCookie(req, "", 0) });
  },

  "GET /api/auth/me": (req, res) => {
    const user = accounts.userForToken(sessionToken(req));
    if (!user) return json(res, 401, { error: "Non connecté." });
    json(res, 200, { pseudo: user.pseudo });
  },

  // Clé Google pour la carte : lue dans .env, jamais écrite dans le code de la page (dépôt public)
  "GET /api/config": (req, res) => json(res, 200, { googleMapsKey: GOOGLE_BROWSER_KEY || null, mapboxToken: env("MAPBOX_TOKEN") || null }),
};

// Routes d'un compte connecté : ws = son espace
const routes = {
  "GET /api/events": (req, res, ws) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify({ type: "state", ...ws.store.snapshot() })}\n\n`);
    res.write(`data: ${JSON.stringify(ws.voiceState())}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "tasks", tasks: ws.board.snapshot() })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: "itinerary", current: ws.linked() })}\n\n`);
    ws.clients.add(res);
    ws.watchClients();
    const ping = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
      clearInterval(ping);
      ws.clients.delete(res);
      ws.watchClients();
    });
  },

  // Offre SDP du navigateur → session GPT-Live (la clé reste ici)
  "POST /api/live/session": async (req, res, ws) => {
    if (!OPENAI_API_KEY) return json(res, 503, { error: "Clé OpenAI absente sur le serveur." });
    const hourAgo = Date.now() - 3600_000;
    while (sessionStarts.length && sessionStarts[0] < hourAgo) sessionStarts.shift();
    if (sessionStarts.length >= MAX_SESSIONS_PER_HOUR) return json(res, 429, { error: "Trop de conversations cette heure-ci." });
    sessionStarts.push(Date.now());
    const { sdp } = await readJson(req);
    if (typeof sdp !== "string" || !sdp.trim() || sdp.length > MAX_BODY) return json(res, 400, { error: "Offre SDP manquante." });
    try {
      json(res, 201, await ws.live.create({ sdp }));
    } catch (err) {
      json(res, err.status && err.status < 500 ? err.status : 502, { error: "La session vocale n'a pas pu démarrer.", detail: err.detail || null });
    }
  },

  "POST /api/live/close": async (req, res, ws) => {
    const info = await readJson(req).catch(() => ({}));
    if (info.reason) {
      const clip = (v) => String(v ?? "-").slice(0, 120);
      console.log(`[live ${ws.user.pseudo}] le navigateur abandonne : ${clip(info.reason)} (connexion ${clip(info.connection)}, ICE ${clip(info.ice)}, canal ${clip(info.channel)})`);
    }
    await ws.live.close(info.reason ? "browser_gave_up" : "close_requested");
    json(res, 200, { ok: true });
  },

  // Contexte fourni par l'appli : position (géolocalisation de l'appli, jamais estimée par le modèle)
  "POST /api/context": async (req, res, ws) => {
    const { position, source, timezone } = await readJson(req);
    if (!validPosition(position)) return json(res, 400, { error: "Position invalide." });
    const patch = { position: { lat: position.lat, lng: position.lng }, positionSource: source === "gps" ? "gps" : "app" };
    if (typeof timezone === "string" && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone)) patch.timezone = timezone;
    ws.store.setContext(patch);
    json(res, 200, { ok: true });
    // Ville et quartier : seulement si la position a beaucoup changé (coût du géocodage)
    if (GOOGLE_API_KEY && (!ws.lastGeocoded || distanceM(ws.lastGeocoded, patch.position) >= GEOCODE_MIN_MOVE_M)) {
      ws.lastGeocoded = patch.position;
      const place = await reverseGeocode(GOOGLE_API_KEY, patch.position);
      sharedMetrics.count("google_geocode");
      if (place) ws.store.setContext({ place });
    }
    ws.live.positionChanged();
  },

  // Infos pratiques du point de départ : météo (toujours) et guide de conversation (au « Let's Go! » ;
  // à l'ouverture d'un itinéraire, celui de l'itinéraire est gardé). Réponse immédiate ; les infos
  // arrivent ensuite avec l'état de la liste.
  "POST /api/practical": async (req, res, ws) => {
    const { position, phrasebook } = await readJson(req);
    if (!validPosition(position)) return json(res, 400, { error: "Position invalide." });
    json(res, 202, { ok: true });
    const pos = { lat: position.lat, lng: position.lng };
    const place = GOOGLE_API_KEY ? await reverseGeocode(GOOGLE_API_KEY, pos) : null;
    if (place) sharedMetrics.count("google_geocode");
    const weather = await practical.weather(pos).catch((err) => {
      console.warn("[infos pratiques] météo :", err.message);
      return null;
    });
    ws.store.setPractical({
      weather,
      place: place ? { city: place.city || place.neighborhood, neighborhood: place.neighborhood, region: place.region, country: place.country, countryCode: place.countryCode } : null,
      ...(phrasebook ? { phrasebook: { pending: true }, facts: { pending: true }, news: { pending: true } } : {}),
    });
    if (!phrasebook) return;
    // Guide de conversation et fun facts : en parallèle, en arrière-plan (indépendants des tâches
    // du guide vocal) ; chacun s'affiche dès qu'il est prêt
    const ready = (name) => (value) => ws.store.setPractical({ [name]: value });
    const failed = (name, label) => (err) => {
      console.warn(`[infos pratiques] ${label} :`, err.message);
      ws.store.setPractical({ [name]: null });
    };
    if (!OPENAI_API_KEY || !place?.country) return ws.store.setPractical({ phrasebook: null, facts: null, news: null });
    practical.phrasebook({ city: place.city || place.neighborhood, region: place.region, country: place.country })
      .then(ready("phrasebook"), failed("phrasebook", "guide"));
    practical.funFacts({ neighborhood: place.neighborhood, city: place.city, country: place.country })
      .then(ready("facts"), failed("facts", "fun facts"));
    practical.news({ city: place.city || place.neighborhood, country: place.country, timezone: weather?.timezone || ws.store.context.timezone })
      .then(ready("news"), failed("news", "actualités"));
  },

  // Bulle ouverte à l'écran (ou fermée : id null) : lieu visé par « il », « ce point »…
  "POST /api/focus": async (req, res, ws) => {
    const { id } = await readJson(req);
    ws.store.focus = typeof id === "string" && ws.store.pois.has(id) ? { id, at: Date.now() } : null;
    res.writeHead(204).end();
  },

  // Action de l'utilisateur sur un lieu dans l'interface : décoché / recoché / visité
  "POST /api/pois/update": async (req, res, ws) => {
    const { id, included, visited } = await readJson(req);
    if (typeof id !== "string") return json(res, 400, { error: "id manquant." });
    let poi = null;
    if (typeof included === "boolean") {
      poi = ws.store.setIncluded(id, included);
      if (poi) ws.live.appNote(included
        ? `L'utilisateur a remis « ${poi.place?.name || poi.name} » dans son itinéraire depuis l'écran.`
        : `L'utilisateur a retiré « ${poi.place?.name || poi.name} » de son itinéraire depuis l'écran (il reste dans la liste, décoché) : ne le considère plus comme sélectionné.`);
    }
    if (visited === true) {
      poi = ws.store.setVisited(id);
      if (poi) ws.live.appNote(`L'utilisateur vient d'arriver à « ${poi.place?.name || poi.name} ».`);
    }
    json(res, 200, { ok: true, version: ws.store.version });
  },

  // Bouton « Effacer » : tout repart de zéro (lieux, tâches, contexte) ; préférences gardées
  "POST /api/pois/clear": async (req, res, ws) => {
    // Tâches arrêtées d'abord (aucune ne peut plus ajouter de lieu), puis lieux effacés
    const stopped = ws.board.clearAll();
    const count = ws.store.clearPois();
    ws.live.clearConversation(); // le contexte de la conversation est oublié aussi
    if (ws.linked()) ws.unlink(); // l'itinéraire ouvert reste enregistré tel quel
    ws.live.appNote(`L'utilisateur a tout effacé depuis l'écran : la liste de lieux est vide, toutes les tâches${stopped ? " (y compris celles en cours)" : ""} sont annulées, et tout ce qui a été demandé jusqu'ici est oublié. Repars de zéro : ne parle plus des anciens lieux, des anciennes recherches ni des demandes précédentes. Seules ses préférences sont conservées.`);
    json(res, 200, { ok: true, removed: count, stoppedTasks: stopped, version: ws.store.version });
  },

  // Cadenas posé ou retiré à la main dans la page : pin = { position: "index", index } ou null
  "POST /api/pois/pin": async (req, res, ws) => {
    const { id, pin } = await readJson(req);
    if (typeof id !== "string") return json(res, 400, { error: "id manquant." });
    const result = pin ? ws.store.pinSteps({ pins: [{ id, ...pin }] }) : ws.store.pinSteps({ unpin_ids: [id] });
    const changed = result.applied?.[0];
    if (changed) ws.live.appNote(pin
      ? `L'utilisateur a figé « ${changed.name} » en ${changed.position} depuis l'écran.`
      : `L'utilisateur a retiré le cadenas de « ${changed.name} » depuis l'écran.`);
    json(res, 200, { ok: result.status === "applied", version: ws.store.version });
  },

  // Numéros d'étape affichés par la page ({ id: numéro }), pour « supprime le point n° 6 »
  "POST /api/pois/numbers": async (req, res, ws) => {
    const { numbers } = await readJson(req);
    if (!numbers || typeof numbers !== "object") return json(res, 400, { error: "numbers manquant." });
    ws.store.setMapNumbers(numbers);
    res.writeHead(204).end();
  },

  // Confirmation d'affichage d'une version de la liste (délai d'actualisation de l'interface)
  "POST /api/ui-ack": async (req, res, ws) => {
    const { version } = await readJson(req);
    const sent = ws.sentAt.get(version);
    if (sent) ws.metrics.time("ui_refresh_ms", Date.now() - sent);
    res.writeHead(204).end();
  },

  // ---- Séjours et itinéraires ----

  "GET /api/trips": (req, res, ws) => json(res, 200, { trips: trips.list(ws.user.id), current: ws.linked() }),

  "POST /api/trips": async (req, res, ws) => {
    const result = trips.createTrip(ws.user.id, (await readJson(req)).name);
    if (result.error) return json(res, result.status, { error: result.error });
    json(res, 201, result);
  },

  // Enregistre la carte actuelle dans un séjour ; le nom doit être libre dans ce séjour
  "POST /api/itineraries": async (req, res, ws) => {
    const { tripId, name } = await readJson(req);
    if (!ws.store.pois.size) return json(res, 400, { error: "La carte est vide : rien à enregistrer." });
    const result = ws.saveAsItinerary(Number(tripId), name);
    if (result.error) return json(res, result.status, { error: result.error });
    console.log(`[comptes] ${ws.user.pseudo} enregistre « ${result.itinerary.name} » (séjour « ${result.itinerary.tripName} »)`);
    json(res, 201, result);
  },

  "POST /api/itineraries/open": async (req, res, ws) => {
    const result = ws.openItinerary(Number((await readJson(req)).id));
    if (result.error) return json(res, result.status, { error: result.error });
    json(res, 200, result);
  },

  // Noms proposés pour un nouveau séjour et pour l'itinéraire
  "GET /api/names/suggest": async (req, res, ws) => {
    if (!suggestNames) return json(res, 503, { error: "Suggestions indisponibles." });
    const list = trips.list(ws.user.id);
    const visible = [...ws.store.pois.values()].filter((p) => p.included || p.visitedAt);
    try {
      json(res, 200, await suggestNames({
        pois: visible.map((p) => ({ name: p.place?.name || p.name, category: p.category })),
        tasks: ws.board.snapshot().map((t) => [t.title, ...(t.criteria || []).map((c) => c.value)].join(" : ")),
        place: ws.store.context.place,
        timezone: ws.store.context.timezone,
        existingTrips: list.map((t) => t.name),
        existingItineraries: list.flatMap((t) => t.itineraries.map((i) => i.name)),
      }));
    } catch (err) {
      console.warn("[noms]", err.message);
      json(res, 502, { error: "Suggestions indisponibles." });
    }
  },

  "GET /api/metrics": (req, res, ws) => json(res, 200, { compte: ws.metrics.summary(), services: sharedMetrics.summary() }),

  // Tests sans micro (QFO_DEV=1) : demande tapée, traitée comme une prise de parole
  "POST /api/dev/say": async (req, res, ws) => {
    if (!DEV) return json(res, 404, { error: "Introuvable." });
    const { text } = await readJson(req);
    if (typeof text !== "string" || !text.trim()) return json(res, 400, { error: "text manquant." });
    await ws.live.typed(text.slice(0, 500));
    json(res, 200, { ok: true, tasks: ws.board.snapshot().slice(0, 5).map((t) => `${t.id} ${t.status} ${t.title}`) });
  },

  // Repartir d'une liste vide (tests)
  "POST /api/reset": async (req, res, ws) => {
    if (!DEV) return json(res, 404, { error: "Introuvable." });
    const context = ws.store.context;
    ws.board.clearAll();
    ws.store.reset();
    ws.live.clearConversation();
    ws.store.context = context;
    ws.store.emit("change", {});
    json(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const key = `${req.method} ${url.pathname}`;
  // Vérification de santé de Render : publique, sans aucune donnée
  if (url.pathname === "/healthz") return json(res, 200, { ok: true });
  try {
    const publicRoute = publicRoutes[key];
    const route = routes[key];
    if (publicRoute || route) {
      // Seule la page servie par ce serveur peut appeler l'API
      if (req.method === "POST" && !ALLOWED_ORIGINS.has(req.headers.origin)) return json(res, 403, { error: "Origine non autorisée." });
      if (publicRoute) return await publicRoute(req, res);
      const user = accounts.userForToken(sessionToken(req));
      if (!user) return json(res, 401, { error: "Non connecté." });
      return await route(req, res, workspaces.open(user));
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

// Arrêt (déploiement Render, Ctrl + C) : les espaces sont enregistrés avant de quitter
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    workspaces.saveAll();
    db.close();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  const invites = accounts.invitesStatus();
  console.log(`Que fait-on ? → ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
  console.log(`Clés : OpenAI ${OPENAI_API_KEY ? "✓" : "✗"}, Google ${GOOGLE_API_KEY ? "✓" : "✗"}${GOOGLE_BROWSER_KEY !== GOOGLE_API_KEY ? " (+ clé navigateur)" : ""}`);
  console.log(`Base : ${DB_PATH} · invitations utilisées : ${invites.filter((i) => i.used).length}/${invites.length}${DEV ? " · mode test (invitation DEV)" : ""}`);
});
