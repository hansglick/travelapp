// Espace d'un compte : sa liste de lieux, son tableau des tâches, ses préférences, sa conversation
// vocale et ses écrans connectés. Chargé depuis la base à la première requête du compte, puis
// enregistré à chaque changement (regroupé sur 1 s). Les services partagés (Google, météo) sont
// communs à tous les comptes.

import { PoiStore } from "./store.mjs";
import { createLiveManager } from "./live.mjs";
import { createMetrics } from "./metrics.mjs";
import { createTools } from "./tools.mjs";
import { createTaskBoard } from "./tasks.mjs";

const SAVE_DELAY_MS = 1000;

export function createWorkspaces({ apiKey, resolvePoi, briefing, storage }) {
  const spaces = new Map(); // id du compte → espace

  function open(user) {
    if (spaces.has(user.id)) return spaces.get(user.id);
    const ws = build(user);
    spaces.set(user.id, ws);
    return ws;
  }

  function build(user) {
    const store = new PoiStore();
    const metrics = createMetrics();
    const clients = new Set(); // flux d'événements des écrans connectés à ce compte
    let voiceState = { type: "voice", state: "closed" };

    function broadcast(message) {
      if (message.type === "voice") voiceState = message;
      const data = `data: ${JSON.stringify(message)}\n\n`;
      for (const res of clients) res.write(data);
    }

    let board = null;
    const live = createLiveManager({ apiKey, store, metrics, broadcast, briefing, board: () => board });
    const tools = createTools({ store, resolvePoi, broadcast, uiConnected: () => clients.size > 0, appNote: (text) => live.appNote(text) });
    let tasksTimer = null;
    board = createTaskBoard({
      apiKey, store, tools, metrics,
      onChange: () => {
        clearTimeout(tasksTimer);
        tasksTimer = setTimeout(() => broadcast({ type: "tasks", tasks: board.snapshot() }), 100);
        scheduleSave();
      },
      notify: (event) => live.onTaskEvent(event),
    });

    // Restauration de l'espace enregistré ; les lieux trop anciens sont relocalisés
    const saved = storage.load(user.id);
    const stale = store.load(saved?.store);
    board.load(saved?.board);
    if (stale.length) console.log(`[compte ${user.pseudo}] ${stale.length} lieu(x) à relocaliser`);
    stale.forEach((id) => tools.relocate(id));

    // Chaque changement est poussé aux écrans du compte et enregistré
    const sentAt = new Map();
    let stateTimer = null;
    store.on("change", () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => {
        sentAt.set(store.version, Date.now());
        if (sentAt.size > 100) sentAt.delete(sentAt.keys().next().value);
        broadcast({ type: "state", ...store.snapshot() });
      }, 30);
      scheduleSave();
    });

    let saveTimer = null;
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, SAVE_DELAY_MS);
    }

    function save() {
      clearTimeout(saveTimer);
      try {
        storage.save(user.id, { store: store.toJSON(), board: board.toJSON() });
      } catch (err) {
        console.error(`[compte ${user.pseudo}] enregistrement impossible :`, err.message);
      }
    }

    // Plus aucun écran connecté : la conversation est fermée au bout de 30 s (coût)
    let orphanTimer = null;
    function watchClients() {
      clearTimeout(orphanTimer);
      if (!clients.size && live.active()) orphanTimer = setTimeout(() => live.close("client_gone"), 30000);
    }

    return {
      user, store, board, live, tools, metrics, clients, sentAt,
      lastGeocoded: null,
      broadcast,
      voiceState: () => voiceState,
      watchClients,
      save,
    };
  }

  // Arrêt du serveur (déploiement) : tout est enregistré immédiatement
  function saveAll() {
    for (const ws of spaces.values()) ws.save();
  }

  return { open, saveAll };
}
