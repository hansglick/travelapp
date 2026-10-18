// Fonctions de l'appli appelées par le modèle de calcul pendant une tâche : lire et modifier la liste
// de lieux, chercher autour d'un repère, informations pratiques, montrer un lieu, préférences.
// Chaque appel est validé ici ; la liste (store) reste la seule source de vérité.

import { LIMITS } from "./store.mjs";

const RESOLUTION_WAIT_MS = 2500; // update_pois attend au plus ce délai les résultats de Google

function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

export function createTools({ store, resolvePoi, broadcast, uiConnected, appNote, discovery }) {
  // task : { addedIds, candidates, requestedCount, log(text) } — la tâche qui appelle
  async function run(name, args, task) {
    switch (name) {
      case "get_selection":
        return { status: "ok", ...store.selectionForModel() };

      case "update_preferences":
        return store.updatePreferences(args);

      case "pin_steps":
        return store.pinSteps(args);

      case "restore_pois":
        return store.restore(args.ids);

      case "find_places_near":
        return findPlacesNear(args, task);

      case "measure_walk":
        return measureWalk(args, task);

      case "get_place_details": {
        const poi = store.pois.get(args.poi_id);
        if (!poi) return { status: "error", message: "Identifiant inconnu : relis la sélection." };
        task.relatedIds?.add(poi.id);
        if (!poi.place?.placeId) return { status: "error", message: "Ce lieu n'est pas encore localisé dans Google : pas d'informations pratiques." };
        try {
          const info = await resolvePoi.getDetails(poi.place.placeId);
          return { status: "ok", id: poi.id, name: poi.place.name || poi.name, ...info, note: "Données Google : horaires et ouverture à jour selon Google, sans garantie." };
        } catch {
          return { status: "error", message: "Informations Google indisponibles pour le moment." };
        }
      }

      case "show_place": {
        if (!uiConnected()) return { status: "error", message: "L'écran de l'application n'est pas ouvert." };
        if (args.poi_id === null) {
          broadcast({ type: "ui", action: "close_bubble" });
          return { status: "ok", message: "Bulle fermée." };
        }
        const poi = store.pois.get(args.poi_id);
        if (!poi) return { status: "error", message: "Identifiant inconnu : relis la sélection." };
        if (poi.status !== "resolved") return { status: "error", message: "Ce lieu n'est pas encore placé sur la carte : pas de bulle ni de photos." };
        task.relatedIds?.add(poi.id);
        broadcast({ type: "ui", action: "open_bubble", id: poi.id });
        return { status: "ok", message: `Bulle de « ${poi.place?.name || poi.name} » ouverte sur la carte (photos et description).` };
      }

      case "update_pois": {
        // Les lieux ajoutés prennent la couleur de la tâche (attribuée à son premier ajout)
        const adding = args.operation === "add" || args.operation === "replace";
        const origin = adding ? { taskId: task.id, colorIndex: task.ensureColor?.() ?? null } : null;
        // op_id propre à chaque tâche : deux tâches en parallèle peuvent inventer le même (« add-1 »)
        const result = store.updatePois({ ...args, op_id: `${task.id}:${args.op_id || Date.now()}` }, origin);
        // Le nombre noté par le détecteur fait foi ; celui du modèle ne sert que s'il n'y en a pas
        if (!task.requestedCount && Number.isInteger(args.requested_count) && args.requested_count > 0) task.requestedCount = Math.min(15, args.requested_count);
        if (result.status === "applied" && result.added?.length) {
          task.addedIds.push(...result.added.map((p) => p.id));
          // Localisation sur la carte : on attend un court instant pour renvoyer au modèle le statut
          // de chaque lieu (il peut corriger une requête introuvable dans la foulée). Les lieux choisis
          // parmi les candidats de find_places_near sont déjà localisés.
          const pending = result.added.filter((p) => p.status === "pending").map((p) => resolveAndStore(p.id, task));
          await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, RESOLUTION_WAIT_MS))]);
          // Distance maximale de la tâche : contrôlée sur les coordonnées réelles
          // (un lieu localisé pendant l'attente a déjà pu être contrôlé et retiré : task.tooFar)
          result.added.forEach((p) => enforceDistance(task, p.id));
          const tooFar = new Map(result.added.filter((p) => task.tooFar?.has(p.id)).map((p) => [p.id, task.tooFar.get(p.id)]));
          const byId = new Map(store.selectionForModel().pois.map((p) => [p.id, p]));
          result.added = result.added.map((p) => {
            if (tooFar.has(p.id)) return { ...p, status: "removed_too_far", distance_m: tooFar.get(p.id), max_distance_m: task.maxDistanceM };
            const meters = distanceFromUser(store.pois.get(p.id));
            return { ...p, status: byId.get(p.id)?.status || "removed_duplicate", ...(meters != null ? { distance_m: meters } : {}) };
          });
          if (tooFar.size) result.note_distance = `Lieux retirés car trop loin de l'utilisateur (plus de ${task.maxDistanceM} m à vol d'oiseau) : cherche plus près.`;
          result.selection = store.selectionForModel();
          result.version = store.version;
          delete result.note;
          if (result.added.some((p) => p.status === "pending")) result.note = "Certains lieux sont encore en cours de localisation.";
        }
        return result;
      }

      default:
        return { status: "error", message: `Fonction inconnue : ${name}` };
    }
  }

  // « Découverte de la ville » : la préparation faite au « Let's Go! » (ou lancée maintenant) est
  // affichée : lieux localisés dans Google et ajoutés au groupe de la tâche, rues colorées
  async function discover(task) {
    let pending = discovery?.get();
    if (!pending) {
      const position = store.context.position;
      if (!position || !store.context.positionSource) return "Ta position n'est pas encore connue : choisis d'abord ton point de départ.";
      pending = discovery.start({ position, city: store.context.place?.city, country: store.context.place?.country });
    }
    let prepared;
    try {
      prepared = await pending;
    } catch (err) {
      console.warn("[découverte] préparation :", err.message);
      return "La découverte de la ville n'a pas pu être préparée (erreur technique).";
    }
    const room = Math.max(0, LIMITS.selectionSize - store.pois.size);
    const places = prepared.places.slice(0, room);
    for (let i = 0; i < places.length; i += LIMITS.addPerOperation) {
      await run("update_pois", {
        operation: "add", base_version: store.version, op_id: `discover-${i}`,
        pois: places.slice(i, i + LIMITS.addPerOperation).map((p) => ({ ...p, sources: [], candidate_id: null })),
        remove_ids: [], remove_category: null, area: null, requested_count: null,
      }, task);
    }
    // Rues : tracées par Google maintenant (3 à la fois), puis coloriées à la couleur du groupe
    const near = store.context.position;
    const traced = [];
    for (let i = 0; i < prepared.streets.length; i += 3) {
      const batch = prepared.streets.slice(i, i + 3);
      const shapes = await Promise.all(batch.map((s) => resolvePoi.traceStreet({ name: s.name, city: prepared.city, country: prepared.country, near }).catch(() => null)));
      batch.forEach((s, k) => { if (shapes[k]) traced.push({ name: shapes[k].name, why: s.why, paths: [shapes[k].path] }); });
    }
    const missing = prepared.streets.length - traced.length;
    if (missing) task.log?.(`${missing} rue(s) non tracée(s) (introuvable(s) dans Google)`);
    store.setStreets({ taskId: task.id, colorIndex: task.ensureColor(), items: traced });
    const placed = task.addedIds.filter((id) => store.pois.get(id)?.status === "resolved").length;
    const left = prepared.places.length - places.length;
    return `Découverte de la ville affichée : ${placed} lieu(x) et ${traced.length} rue(s) colorée(s).`
      + (left ? ` ${left} lieu(x) non ajouté(s) : la carte est limitée à ${LIMITS.selectionSize} lieux.` : "");
  }

  // Auto-localisation : le point de retour « B » à la position actuelle de l'utilisateur (sans modèle)
  async function placeBackPoint() {
    const position = store.context.position;
    if (!position || !store.context.positionSource) {
      return "Ta position n'est pas encore connue : choisis d'abord ton point de départ (touche la carte ou « Ma position »).";
    }
    const address = await resolvePoi.reverseAddress?.(position).catch(() => null);
    const { moved } = store.placeBack({ position, address });
    return `${moved ? "Point de retour déplacé" : "Point de retour placé"} à ta position actuelle${address ? ` (près de ${address})` : ""} : c'est la dernière étape de l'itinéraire.`;
  }

  // Lieux autour d'un repère : un lieu de la liste, la position de l'utilisateur, ou un endroit nommé
  async function findPlacesNear(args, task) {
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
    const candidates = store.rememberCandidates(found);
    task.candidates.push(...candidates.map((c) => `${c.candidate_id} ${c.name} (${c.position})`));
    return {
      status: "ok",
      anchors: anchorNames,
      candidates,
      note: "Choisis le candidat qui correspond à la tâche et ajoute-le avec update_pois (candidate_id). Si plusieurs correspondent à une description précise, propose-les (nom, position, candidate_id) et demande lequel.",
    };
  }

  // Distance et temps de marche entre des lieux de la liste ou l'utilisateur (« user ») : trajet à
  // pied réel de Google ; à défaut, distance à vol d'oiseau, signalée comme telle
  async function measureWalk(args, task) {
    const pairs = (Array.isArray(args.pairs) ? args.pairs : []).slice(0, 10);
    if (!pairs.length) return { status: "error", message: "pairs vide." };
    const point = (id) => {
      if (id === "user") {
        const position = store.context.position;
        return position ? { key: "user", name: "l'utilisateur", location: position } : { error: "Position de l'utilisateur inconnue." };
      }
      const poi = store.pois.get(id);
      if (!poi) return { error: `Identifiant inconnu : ${id}. Relis la sélection.` };
      if (!poi.place?.location) return { error: `« ${poi.name} » n'est pas encore placé sur la carte.` };
      task.relatedIds?.add(poi.id);
      return { key: poi.id, name: poi.place.name || poi.name, location: poi.place.location };
    };
    const resolved = pairs.map((p) => ({ from: point(p.from_id), to: point(p.to_id) }));
    const ok = resolved.filter((r) => !r.from.error && !r.to.error);
    // Une seule matrice Google pour toutes les paires : origines et destinations dédoublonnées
    const origins = [...new Map(ok.map((r) => [r.from.key, r.from])).values()];
    const destinations = [...new Map(ok.map((r) => [r.to.key, r.to])).values()];
    let grid = null;
    if (ok.length) {
      try {
        grid = await resolvePoi.walkMatrix(origins.map((o) => o.location), destinations.map((d) => d.location));
      } catch (err) {
        console.warn("[routes] matrice à pied indisponible :", err.message);
      }
    }
    const results = resolved.map(({ from, to }) => {
      if (from.error || to.error) return { status: "error", message: from.error || to.error };
      const walk = grid?.[origins.findIndex((o) => o.key === from.key)]?.[destinations.findIndex((d) => d.key === to.key)];
      const straight = Math.round(distanceM(from.location, to.location));
      return walk
        ? { status: "ok", from: from.name, to: to.name, walk_m: walk.meters, walk_minutes: Math.max(1, Math.round(walk.seconds / 60)), straight_line_m: straight }
        : { status: "estimate", from: from.name, to: to.name, straight_line_m: straight, note: "Trajet à pied indisponible : distance à vol d'oiseau seulement, le chemin réel est plus long." };
    });
    return { status: "ok", results, source: "Itinéraires à pied Google" };
  }

  function distanceFromUser(poi) {
    const position = store.context.position;
    const location = poi?.place?.location;
    return position && location ? Math.round(distanceM(position, location)) : null;
  }

  // Lieu localisé plus loin que la distance maximale de la tâche : retiré de la liste
  function enforceDistance(task, id) {
    if (!task?.maxDistanceM) return null;
    const meters = distanceFromUser(store.pois.get(id));
    if (meters == null || meters <= task.maxDistanceM) return null;
    const poi = store.pois.get(id);
    store.updatePois({
      operation: "remove", base_version: store.version, op_id: `too-far-${id}`,
      pois: [], remove_ids: [id], remove_category: null, area: null, requested_count: null,
    });
    task.log?.(`retiré, trop loin : ${poi.place?.name || poi.name} (${meters} m > ${task.maxDistanceM} m)`);
    (task.tooFar ||= new Map()).set(id, meters);
    return { tooFar: true, meters };
  }

  // Résolution Google d'un lieu ajouté, puis mise à jour de l'état (ignorée si le lieu a été retiré)
  async function resolveAndStore(id, task = null) {
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
    if (resolution.status === "resolved") enforceDistance(task, id); // localisé après coup : contrôlé aussi
    if (resolution.status !== "resolved") {
      console.log(`[places] ${resolution.status} : ${poi.query} → ${(resolution.candidates || []).map((c) => c.name).join(" / ") || "aucun résultat"}`);
    }
  }

  // Lieu à relocaliser (coordonnées de plus de 30 jours après rechargement d'un compte)
  const relocate = (id) => resolveAndStore(id, null);

  return { run, enforceDistance, relocate, placeBackPoint, discover };
}
