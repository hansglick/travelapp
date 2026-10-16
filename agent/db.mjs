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
  `);
  return db;
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
