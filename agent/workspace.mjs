// Espace d'un compte : sa liste de lieux, son tableau des tâches, ses préférences, sa conversation
// vocale et ses écrans connectés. Chargé depuis la base à la première requête du compte, puis
// enregistré à chaque changement (regroupé sur 1 s). Les services partagés (Google, météo) sont
// communs à tous les comptes.

import { PoiStore } from "./store.mjs";
import { createLiveManager } from "./live.mjs";
import { createMetrics } from "./metrics.mjs";
import { createTools } from "./tools.mjs";
import { createTaskBoard } from "./tasks.mjs";
import { createVerifier } from "./verify.mjs";

const SAVE_DELAY_MS = 1000;

export function createWorkspaces({ apiKey, resolvePoi, storage, trips, discovery, viewpoints }) {
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
    const live = createLiveManager({ apiKey, store, metrics, broadcast, board: () => board });
    // « Découverte de la ville » préparée en arrière-plan au « Let's Go! » (affichée sur demande)
    // État pour le bouton de la carte : preparing (arcs qui tournent), ready, displaying, shown, error
    let discoveryPending = null;
    const discoveryApi = {
      get: () => discoveryPending,
      start: (args) => {
        discoveryApi.setState("preparing");
        discoveryPending = discovery ? discovery.prepare(args) : Promise.reject(new Error("découverte indisponible"));
        discoveryPending.then(() => discoveryApi.setState("ready"), (err) => {
          console.warn("[découverte] préparation :", err.message);
          discoveryApi.setState("error");
        });
        return discoveryPending;
      },
      materialize: (entry, position) => discovery.materialize(entry, position),
      setState: (state) => store.setPractical({ discovery: { state, at: Date.now() } }),
    };
    // « Points de vue » préparés aussi au « Let's Go! » (bouton du bonhomme qui marche)
    // État pour le bouton : preparing, ready, displaying, shown, error
    let viewpointsPending = null;
    const viewpointsApi = {
      get: () => viewpointsPending,
      start: ({ place, position }) => {
        viewpointsApi.setState("preparing");
        viewpointsPending = viewpoints ? viewpoints.prepare({ place }) : Promise.reject(new Error("points de vue indisponibles"));
        viewpointsPending.then(() => viewpointsApi.setState("ready"), (err) => {
          console.warn("[points de vue] préparation :", err.message);
          viewpointsApi.setState("error");
        });
        return viewpointsPending;
      },
      materialize: (entry, position) => viewpoints.materialize(entry, position),
      setState: (state) => store.setPractical({ viewpoints: { state, at: Date.now() } }),
    };
    // Canal mixte : vérification sur le web des candidats Google (critère concret ou réputation)
    const verifier = apiKey ? createVerifier({ apiKey, metrics }) : null;
    const tools = createTools({ store, resolvePoi, broadcast, uiConnected: () => clients.size > 0, appNote: (text) => live.appNote(text), announce: (text) => live.announce(text), discovery: discoveryApi, viewpoints: viewpointsApi, verifier });
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
    // Itinéraire ouvert ou enregistré : son avancement y est enregistré à chaque changement
    let linked = saved?.linked || null; // { id, name, tripName }
    if (stale.length) console.log(`[compte ${user.pseudo}] ${stale.length} lieu(x) à relocaliser`);
    stale.forEach((id) => tools.relocate(id));
    refreshPlaceInfo();

    // Lieux rechargés (compte ou itinéraire) : note, avis, prix et horaires ne sont pas enregistrés
    // (règles de Google) ; ils sont redemandés en arrière-plan
    function refreshPlaceInfo() {
      for (const poi of store.pois.values()) {
        if (poi.status !== "resolved" || !poi.place?.placeId || poi.place.rating !== undefined) continue;
        resolvePoi.getDetails(poi.place.placeId).then((info) => store.setPlaceInfo(poi.id, info)).catch(() => {});
      }
    }

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

    const content = () => ({ store: store.toJSON(), board: board.toJSON() });

    function save() {
      clearTimeout(saveTimer);
      try {
        const data = content();
        storage.save(user.id, { ...data, linked });
        if (linked) trips.updateItinerary(user.id, linked.id, data);
      } catch (err) {
        console.error(`[compte ${user.pseudo}] enregistrement impossible :`, err.message);
      }
    }

    // ---- Itinéraires ----

    // Enregistre la carte actuelle comme nouvel itinéraire, qui devient l'itinéraire ouvert
    function saveAsItinerary(tripId, name) {
      const result = trips.createItinerary(user.id, tripId, name, content());
      if (result.error) return result;
      linked = { id: result.itinerary.id, name: result.itinerary.name, tripName: result.itinerary.tripName };
      save();
      broadcast({ type: "itinerary", current: linked });
      return result;
    }

    // Ouvre un itinéraire : la carte et les tâches actuelles sont remplacées par les siennes
    function openItinerary(id) {
      const it = trips.getItinerary(user.id, id);
      if (!it) return { error: "Itinéraire introuvable.", status: 404 };
      board.clearAll();
      const { context, version, preferences } = store;
      store.reset();
      store.context = context;
      const staleIds = store.load(it.data.store);
      store.preferences = preferences; // les préférences sont celles du compte, pas de l'itinéraire
      store.version = Math.max(store.version, version) + 1; // l'écran doit accepter ce nouvel état
      board.load(it.data.board);
      live.clearConversation();
      linked = { id: it.id, name: it.name, tripName: it.tripName };
      staleIds.forEach((pid) => tools.relocate(pid));
      refreshPlaceInfo();
      discoveryPending = null; // sélections à refaire pour ce lieu (base commune : souvent immédiate)
      viewpointsPending = null;
      store.emit("change", {});
      broadcast({ type: "tasks", tasks: board.snapshot() });
      broadcast({ type: "itinerary", current: linked });
      live.appNote(`L'utilisateur a ouvert son itinéraire « ${it.name} » (séjour « ${it.tripName} ») : la carte et les tâches ont été remplacées par les siennes. Oublie les lieux et demandes précédents.`);
      save();
      return { itinerary: linked };
    }

    // « Effacer » : la carte n'est plus liée à l'itinéraire, qui reste enregistré tel quel
    function unlink() {
      linked = null;
      broadcast({ type: "itinerary", current: null });
      save();
    }

    // Plus aucun écran connecté : la conversation est fermée au bout de 30 s (coût)
    let orphanTimer = null;
    function watchClients() {
      clearTimeout(orphanTimer);
      if (!clients.size && live.active()) orphanTimer = setTimeout(() => live.close("client_gone"), 30000);
    }

    return {
      user, store, board, live, tools, metrics, clients, sentAt,
      startDiscovery: discoveryApi.start,
      startViewpoints: viewpointsApi.start,
      lastGeocoded: null,
      broadcast,
      voiceState: () => voiceState,
      linked: () => linked,
      watchClients,
      save,
      saveAsItinerary,
      openItinerary,
      unlink,
    };
  }

  // Arrêt du serveur (déploiement) : tout est enregistré immédiatement
  function saveAll() {
    for (const ws of spaces.values()) ws.save();
  }

  return { open, saveAll };
}
