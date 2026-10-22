// Comptes et données enregistrées (SQLite intégré à Node). Comme dans hebrew-app : une identité
// légère (pseudo + code PIN de 4 chiffres), pas une vraie authentification. L'inscription demande
// un code d'invitation à usage unique.
// Sur Render, la base vit sur le disque persistant (DB_PATH=/var/data/qfo.sqlite), qui survit aux
// déploiements ; en local, dans prototype/data/ (non publié).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SESSION_DAYS = 180;          // durée d'une connexion retenue par le téléphone
const MAX_FAILS = 5;               // codes PIN faux avant blocage temporaire du pseudo
const LOCK_MS = 15 * 60 * 1000;

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pseudo TEXT NOT NULL UNIQUE COLLATE NOCASE,
      pin_hash TEXT NOT NULL,
      invite_code TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS invites_used (
      code TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      used_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL COLLATE NOCASE,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS itineraries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id INTEGER NOT NULL REFERENCES trips(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL COLLATE NOCASE,
      data TEXT NOT NULL,
      poi_count INTEGER NOT NULL DEFAULT 0,
      visited_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (trip_id, name)
    );
    CREATE TABLE IF NOT EXISTS discoveries (
      place_key TEXT PRIMARY KEY COLLATE NOCASE,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS menus (
      place_id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dishes (
      dish TEXT PRIMARY KEY COLLATE NOCASE,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phrasebooks (
      country TEXT PRIMARY KEY COLLATE NOCASE,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

// « Découverte de la ville », commune à tous les comptes : une par quartier (ou ville). Sélection du
// modèle et identifiants Google sans limite ; coordonnées et tracés datés (30 jours au plus, voir
// discovery.mjs)
export function createDiscoveryStorage(db) {
  const get = db.prepare("SELECT data FROM discoveries WHERE place_key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO discoveries (place_key, data, updated_at) VALUES (?, ?, ?)");
  return {
    get: (key) => {
      const row = get.get(key);
      return row ? JSON.parse(row.data) : null;
    },
    set: (key, data) => put.run(key, JSON.stringify(data), Date.now()),
  };
}

// Guides de conversation (écran « Infos pratiques »), communs à tous les comptes : un par pays
export function createPhrasebookStorage(db) {
  const get = db.prepare("SELECT data FROM phrasebooks WHERE country = ?");
  const put = db.prepare("INSERT OR REPLACE INTO phrasebooks (country, data, created_at) VALUES (?, ?, ?)");
  return {
    get: (country) => {
      const row = get.get(country);
      return row ? JSON.parse(row.data) : null;
    },
    set: (country, data) => put.run(country, JSON.stringify(data), Date.now()),
  };
}

// Plats (« couscous », « dorade ») et probabilité de chaque type de restaurant Google de les servir,
// communs à tous les comptes : calculés une fois par plat, sans expiration (ce ne sont pas des
// données Google)
export function createDishStorage(db) {
  const get = db.prepare("SELECT data FROM dishes WHERE dish = ?");
  const put = db.prepare("INSERT OR REPLACE INTO dishes (dish, data, created_at) VALUES (?, ?, ?)");
  return {
    get: (dish) => {
      const row = get.get(dish);
      return row ? JSON.parse(row.data) : null;
    },
    set: (dish, data) => put.run(dish, JSON.stringify(data), Date.now()),
  };
}

// Menus des restaurants relevés par l'analyse web, communs à tous les comptes : par identifiant Google,
// les plats vus avec leur groupe (entrées, plats, desserts…, au choix du modèle), les régimes repérés
// (végétarien, vegan, sans gluten, halal), les verdicts des critères vérifiés (« poisson » : oui ou
// non) et le nom du lieu tel que l'analyse l'a lu sur le web (pas celui de Google) ; jamais le menu
// recopié. Valables 6 mois : au-delà, le restaurant est revérifié. Coordonnées Google : 30 jours au
// plus (règles de Google), pour l'écran des menus autour de l'utilisateur.
export const MENU_VALID_MS = 182 * 24 * 3600 * 1000;
export const MENU_LOCATION_MS = 30 * 24 * 3600 * 1000;
const MENU_MAX_DISHES = 120;
export const EXTERNAL_GROUP = "Source ext."; // plats confirmés ailleurs que sur la carte relevée (avis, presse…)
const menuKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function createMenuStorage(db) {
  const get = db.prepare("SELECT data, updated_at FROM menus WHERE place_id = ?");
  const put = db.prepare("INSERT OR REPLACE INTO menus (place_id, data, updated_at) VALUES (?, ?, ?)");
  // { dishes: [{ name, group }], diets, source, verdicts: { clé: { label, answer, note, at } } } d'un
  // restaurant, relevé il y a moins de 6 mois ; sinon null. Anciens relevés : plats sans groupe.
  const fresh = (placeId) => {
    const row = get.get(placeId);
    if (!row || Date.now() - row.updated_at > MENU_VALID_MS) return null;
    const data = JSON.parse(row.data);
    const dishes = (data.dishes || []).map((d) => (typeof d === "string" ? { name: d, group: null } : d));
    const verdicts = Object.fromEntries(Object.entries(data.verdicts || {}).filter(([, v]) => Date.now() - v.at <= MENU_VALID_MS));
    const location = data.location && Date.now() - data.locatedAt <= MENU_LOCATION_MS ? data.location : null;
    return { dishes, diets: data.diets || [], source: data.source || null, verdicts, name: data.name || null, location, updatedAt: row.updated_at };
  };
  return {
    get: fresh,
    // Nouveau relevé : ajouté à celui encore valable (une vérification ne voit souvent qu'une partie
    // de la carte), la date repart de maintenant. verdict : { label, answer: yes | no, note } ; name :
    // nom lu sur le web ; location : coordonnées Google (datées, 30 jours au plus)
    // confirmedDish : le plat confirmé par une vérification ; ajouté seulement si la carte relevée ne le
    // contient pas déjà sous un nom qui le comprend (« pizza margherita »), dans la rubrique
    // « Source ext. » avec le lien de la page qui le cite (confirmedUrl)
    add: (placeId, { dishes = [], diets = [], source = null, verdict = null, name = null, location = null, confirmedDish = null, confirmedUrl = null }) => {
      if (!dishes.length && !diets.length && !verdict && !confirmedDish) return;
      const old = fresh(placeId) || { dishes: [], diets: [], verdicts: {} };
      const saved = get.get(placeId);
      const before = saved ? JSON.parse(saved.data) : {};
      // Un plat déjà connu garde son groupe, sauf s'il n'en avait pas
      const byName = new Map(old.dishes.map((d) => [menuKey(d.name), d]));
      for (const d of dishes) {
        const known = byName.get(menuKey(d.name));
        if (!known) byName.set(menuKey(d.name), d);
        else if (!known.group && d.group) known.group = d.group;
      }
      const external = confirmedDish && byName.get(menuKey(confirmedDish));
      if (external?.group === EXTERNAL_GROUP && !external.url && confirmedUrl) external.url = confirmedUrl; // lien trouvé depuis
      else if (confirmedDish && ![...byName.values()].some((d) => menuKey(d.name).includes(menuKey(confirmedDish)))) {
        byName.set(menuKey(confirmedDish), { name: confirmedDish, group: EXTERNAL_GROUP, url: confirmedUrl || null });
      }
      const verdicts = { ...old.verdicts };
      if (verdict) verdicts[menuKey(verdict.label)] = { ...verdict, at: Date.now() };
      const data = {
        dishes: [...byName.values()].slice(0, MENU_MAX_DISHES),
        diets: [...new Set([...old.diets, ...diets])],
        source: source || old.source || null,
        verdicts,
        name: name || old.name || before.name || null,
        location: location || before.location || null,
        locatedAt: location ? Date.now() : before.locatedAt || null,
      };
      put.run(placeId, JSON.stringify(data), Date.now());
    },
    // Tous les menus encore valables (écran « Menus connus ») : { placeId, ...menu }
    list: () => db.prepare("SELECT place_id FROM menus WHERE updated_at > ?").all(Date.now() - MENU_VALID_MS)
      .map((r) => ({ placeId: r.place_id, ...fresh(r.place_id) })),
    // Coordonnées redemandées à Google (menu relevé sans elles, ou trop vieilles) : la date du relevé
    // ne change pas
    setLocation: (placeId, location) => {
      const row = get.get(placeId);
      if (!row) return;
      const data = { ...JSON.parse(row.data), location, locatedAt: Date.now() };
      put.run(placeId, JSON.stringify(data), row.updated_at);
    },
  };
}

// Pseudo : 2 à 30 caractères (lettres, chiffres, espace, tiret, point, souligné)
export function cleanPseudo(raw) {
  const pseudo = String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
  return /^[\p{L}\p{N} ._-]{2,30}$/u.test(pseudo) ? pseudo : null;
}

const validPin = (pin) => typeof pin === "string" && /^\d{4}$/.test(pin);

function hashPin(pin, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

function checkPin(pin, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = scryptSync(pin, salt, 32);
  return timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

export function createAccounts(db, { inviteCodes, devInvite = null }) {
  const fails = new Map(); // pseudo (minuscules) → { count, until }
  const normalizeCode = (code) => String(code || "").trim().toUpperCase();
  const validCodes = new Set(inviteCodes.map(normalizeCode).filter(Boolean));

  function newSession(userId) {
    const token = randomBytes(32).toString("hex");
    const now = Date.now();
    db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(token, userId, now, now + SESSION_DAYS * 86400000);
    return { token, maxAge: SESSION_DAYS * 86400 };
  }

  // Inscription : code d'invitation valide et pas encore utilisé, pseudo libre, PIN à 4 chiffres
  function register({ invite, pseudo, pin }) {
    const code = normalizeCode(invite);
    const isDev = devInvite && code === normalizeCode(devInvite); // tests locaux, réutilisable
    if (!isDev && !validCodes.has(code)) return { error: "Code d'invitation inconnu.", status: 403 };
    if (!isDev && db.prepare("SELECT 1 FROM invites_used WHERE code = ?").get(code)) {
      return { error: "Ce code d'invitation a déjà servi.", status: 409 };
    }
    const name = cleanPseudo(pseudo);
    if (!name) return { error: "Pseudo invalide (2 à 30 lettres ou chiffres).", status: 400 };
    if (!validPin(pin)) return { error: "Le code PIN doit contenir 4 chiffres.", status: 400 };
    if (db.prepare("SELECT 1 FROM users WHERE pseudo = ?").get(name)) return { error: "Ce pseudo est déjà pris.", status: 409 };
    const now = Date.now();
    const { lastInsertRowid } = db.prepare("INSERT INTO users (pseudo, pin_hash, invite_code, created_at) VALUES (?, ?, ?, ?)")
      .run(name, hashPin(pin), isDev ? null : code, now);
    const userId = Number(lastInsertRowid);
    if (!isDev) db.prepare("INSERT INTO invites_used (code, user_id, used_at) VALUES (?, ?, ?)").run(code, userId, now);
    return { user: { id: userId, pseudo: name }, session: newSession(userId) };
  }

  // Connexion : pseudo + PIN ; après MAX_FAILS erreurs, le pseudo est bloqué LOCK_MS
  function login({ pseudo, pin }) {
    const name = cleanPseudo(pseudo);
    const key = (name || "").toLowerCase();
    const f = fails.get(key);
    if (f && f.until > Date.now()) return { error: "Trop d'essais : réessaie dans quelques minutes.", status: 429 };
    const row = name && validPin(pin) ? db.prepare("SELECT id, pseudo, pin_hash FROM users WHERE pseudo = ?").get(name) : null;
    if (!row || !checkPin(pin, row.pin_hash)) {
      const count = (f && f.until <= Date.now() && f.until ? 0 : f?.count || 0) + 1;
      fails.set(key, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      return { error: "Pseudo ou code PIN incorrect.", status: 401 };
    }
    fails.delete(key);
    return { user: { id: row.id, pseudo: row.pseudo }, session: newSession(row.id) };
  }

  function userForToken(token) {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const row = db.prepare(`SELECT u.id, u.pseudo, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, pseudo: row.pseudo };
  }

  function logout(token) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  }

  function invitesStatus() {
    const used = new Set(db.prepare("SELECT code FROM invites_used").all().map((r) => r.code));
    return [...validCodes].map((code) => ({ code, used: used.has(code) }));
  }

  return { register, login, userForToken, logout, invitesStatus };
}

// Nom de séjour ou d'itinéraire : 1 à 60 caractères, espaces superflus retirés
export function cleanName(raw) {
  const name = String(raw || "").normalize("NFC").replace(/\s+/g, " ").trim();
  return name && name.length <= 60 ? name : null;
}

// Séjours (dossiers) et itinéraires enregistrés d'un compte. Un itinéraire = la liste de lieux
// (avec leurs numéros) et le tableau des tâches qui les regroupent, au même format que l'espace.
export function createTripStorage(db) {
  const summary = (data) => {
    const pois = (data?.store?.pois || []).filter((p) => p.included || p.visitedAt);
    return { poiCount: pois.length, visitedCount: pois.filter((p) => p.visitedAt).length };
  };

  return {
    list(userId) {
      const trips = db.prepare("SELECT id, name, created_at FROM trips WHERE user_id = ? ORDER BY created_at DESC").all(userId);
      const its = db.prepare(`SELECT id, trip_id, name, poi_count, visited_count, updated_at FROM itineraries
        WHERE user_id = ? ORDER BY updated_at DESC`).all(userId);
      return trips.map((t) => ({
        id: t.id,
        name: t.name,
        itineraries: its.filter((i) => i.trip_id === t.id).map((i) => ({
          id: i.id, name: i.name, poiCount: i.poi_count, visitedCount: i.visited_count, updatedAt: i.updated_at,
        })),
      }));
    },

    createTrip(userId, rawName) {
      const name = cleanName(rawName);
      if (!name) return { error: "Donne un nom au séjour (60 caractères au plus).", status: 400 };
      if (db.prepare("SELECT 1 FROM trips WHERE user_id = ? AND name = ?").get(userId, name)) {
        return { error: "Un séjour porte déjà ce nom.", status: 409 };
      }
      const { lastInsertRowid } = db.prepare("INSERT INTO trips (user_id, name, created_at) VALUES (?, ?, ?)").run(userId, name, Date.now());
      return { trip: { id: Number(lastInsertRowid), name, itineraries: [] } };
    },

    // Nouvel itinéraire dans un séjour ; un nom déjà pris dans ce séjour est refusé
    createItinerary(userId, tripId, rawName, data) {
      const trip = db.prepare("SELECT id, name FROM trips WHERE id = ? AND user_id = ?").get(tripId, userId);
      if (!trip) return { error: "Choisis un séjour.", status: 400 };
      const name = cleanName(rawName);
      if (!name) return { error: "Donne un nom à l'itinéraire (60 caractères au plus).", status: 400 };
      if (db.prepare("SELECT 1 FROM itineraries WHERE trip_id = ? AND name = ?").get(trip.id, name)) {
        return { error: `Un itinéraire porte déjà ce nom dans le séjour « ${trip.name} ».`, status: 409 };
      }
      const now = Date.now();
      const { poiCount, visitedCount } = summary(data);
      const { lastInsertRowid } = db.prepare(`INSERT INTO itineraries
        (trip_id, user_id, name, data, poi_count, visited_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(trip.id, userId, name, JSON.stringify(data), poiCount, visitedCount, now, now);
      return { itinerary: { id: Number(lastInsertRowid), name, tripId: trip.id, tripName: trip.name } };
    },

    // Avancement d'un itinéraire ouvert, enregistré à chaque changement
    updateItinerary(userId, id, data) {
      const { poiCount, visitedCount } = summary(data);
      db.prepare("UPDATE itineraries SET data = ?, poi_count = ?, visited_count = ?, updated_at = ? WHERE id = ? AND user_id = ?")
        .run(JSON.stringify(data), poiCount, visitedCount, Date.now(), id, userId);
    },

    getItinerary(userId, id) {
      const row = db.prepare(`SELECT i.id, i.name, i.data, t.id AS trip_id, t.name AS trip_name FROM itineraries i
        JOIN trips t ON t.id = i.trip_id WHERE i.id = ? AND i.user_id = ?`).get(id, userId);
      if (!row) return null;
      try {
        return { id: row.id, name: row.name, tripId: row.trip_id, tripName: row.trip_name, data: JSON.parse(row.data) };
      } catch {
        return null;
      }
    },
  };
}

// Espace enregistré de chaque compte (lieux, tâches, préférences), en JSON
export function createWorkspaceStorage(db) {
  return {
    load(userId) {
      const row = db.prepare("SELECT data FROM workspaces WHERE user_id = ?").get(userId);
      if (!row) return null;
      try {
        return JSON.parse(row.data);
      } catch {
        return null;
      }
    },
    save(userId, data) {
      db.prepare(`INSERT INTO workspaces (user_id, data, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
        .run(userId, JSON.stringify(data), Date.now());
    },
  };
}
