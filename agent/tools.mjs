// Fonctions de l'appli appelées par le modèle de calcul pendant une tâche : lire et modifier la liste
// de lieux, chercher autour d'un repère, informations pratiques, montrer un lieu, préférences.
// Chaque appel est validé ici ; la liste (store) reste la seule source de vérité.

import { LIMITS } from "./store.mjs";
import { MAX_TRAVEL_S, MAX_SHOWN } from "./discovery.mjs";
import { MAX_VIEWPOINTS, AREA_KM } from "./viewpoints.mjs";
import { GOOGLE_TYPE_LIST, familyOf } from "./google-types.mjs";
import { categoryFromTypes } from "./places.mjs";

// Prix compatibles avec « pas cher » (gratuit, €, €€)
// Texte comparable : minuscules, sans accents ni ponctuation (« Pâtisserie-Café » → « patisserie cafe »)
const plain = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const CHEAP_LEVELS = ["PRICE_LEVEL_FREE", "PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"];

// Recherche exhaustive : tous les lieux du rayon, 20 au plus ; sans rayon donné, 15 min à pied
const MAX_RESULTS = 20;
const DEFAULT_RADIUS_M = 1200;
const ANALYSIS_BATCH = 5; // analyse web : 5 lieux à la fois

const RESOLUTION_WAIT_MS = 2500; // update_pois attend au plus ce délai les résultats de Google

function distanceM(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}

export function createTools({ store, resolvePoi, broadcast, uiConnected, appNote, announce, discovery, viewpoints, verifier }) {
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

  // « Découverte de la ville » (bouton de la carte dépliée) : la préparation faite au « Let's Go! »
  // (ou lancée maintenant) est affichée : lieux localisés dans Google et ajoutés au groupe de la tâche
  async function discover(task) {
    const position = store.context.position;
    if (!position || !store.context.positionSource) return "Ta position n'est pas encore connue : choisis d'abord ton point de départ.";
    discovery.setState("displaying");
    try {
      // Sélection préparée au « Let's Go! » (ou depuis la base commune), sinon lancée maintenant
      // Ville ou quartier du départ : si le contexte ne les connaît pas encore, on les demande maintenant
      const place = store.context.place?.city ? store.context.place : await resolvePoi.reverseGeocode(position);
      const entry = await (discovery.get() || discovery.start({ place, position }));
      await discovery.materialize(entry, position);
      // Temps de trajet réels depuis le point de départ : un seul appel pour tous les lieux
      const located = entry.candidates.filter((c) => c.location);
      const targets = located.map((c) => c.location);
      let seconds;
      try {
        const grid = targets.length ? await resolvePoi.walkMatrix([position], targets) : [[]];
        seconds = grid[0].map((cell) => (cell ? cell.seconds : Infinity));
      } catch {
        // Trajets indisponibles : estimation à vol d'oiseau (80 m par minute de marche)
        seconds = targets.map((t) => (distanceM(position, t) / 80) * 60);
      }
      const reachable = (i) => seconds[i] <= MAX_TRAVEL_S;
      const room = Math.max(0, LIMITS.selectionSize - store.pois.size);
      const chosen = located.filter((c, i) => reachable(i)).slice(0, Math.min(MAX_SHOWN, room));
      // Lieux déjà localisés : ajoutés tels quels (sans nouvelle recherche Google)
      const ids = store.rememberCandidates(chosen.map((c) => ({ place: { placeId: c.placeId, name: c.name, address: null, location: c.location, types: [] } })))
        .map((v) => v.candidate_id);
      for (let i = 0; i < chosen.length; i += LIMITS.addPerOperation) {
        await run("update_pois", {
          operation: "add", base_version: store.version, op_id: `discover-${i}`,
          pois: chosen.slice(i, i + LIMITS.addPerOperation).map((c, k) => ({
            name: c.name, query: c.query, category: c.category, reason: c.reason, sources: [], candidate_id: ids[i + k],
          })),
          remove_ids: [], remove_category: null, area: null, requested_count: null,
        }, task);
      }
      // Note, avis, prix et horaires : demandés en arrière-plan (mémoire seulement)
      for (const id of task.addedIds) {
        const poi = store.pois.get(id);
        if (poi?.place?.placeId) resolvePoi.getDetails(poi.place.placeId).then((info) => store.setPlaceInfo(id, info)).catch(() => {});
      }
      discovery.setState("shown");
      const placed = task.addedIds.filter((id) => store.pois.get(id)?.status === "resolved").length;
      const tooFar = located.length - located.filter((c, i) => reachable(i)).length;
      return `Découverte de la ville affichée : ${placed} lieu(x) à 40 min au plus`
        + (tooFar ? ` (${tooFar} lieu(x) écarté(s), à plus de 40 min).` : ".");
    } catch (err) {
      console.warn("[découverte] affichage :", err.message);
      discovery.setState("error");
      return "La découverte de la ville n'a pas pu être préparée (erreur technique).";
    }
  }

  // « Points de vue » (bouton du bonhomme qui marche) : les points de vue préparés au « Let's Go! »
  // (ou cherchés maintenant) sont ajoutés comme des lieux, au groupe de la tâche : 7 au plus, dans
  // la zone de la ville (15 km), sans la règle des 40 min ; un lieu déjà sur la carte (découverte de
  // la ville…) n'est pas ajouté une seconde fois.
  async function showViewpoints(task) {
    const position = store.context.position;
    if (!position || !store.context.positionSource) return "Ta position n'est pas encore connue : choisis d'abord ton point de départ.";
    viewpoints.setState("displaying");
    try {
      const place = store.context.place?.city ? store.context.place : await resolvePoi.reverseGeocode(position);
      const entry = await (viewpoints.get() || viewpoints.start({ place, position }));
      await viewpoints.materialize(entry, position);
      const onMap = [...store.pois.values()].filter((p) => p.place?.location);
      const already = (c) => onMap.some((p) => (c.placeId && p.place.placeId === c.placeId) || distanceM(p.place.location, c.location) <= 50);
      const inZone = entry.candidates.filter((c) => c.location && distanceM(position, c.location) <= AREA_KM * 1000);
      const room = Math.max(0, LIMITS.selectionSize - store.pois.size);
      const chosen = inZone.filter((c) => !already(c)).slice(0, Math.min(MAX_VIEWPOINTS, room));
      const ids = store.rememberCandidates(chosen.map((c) => ({ place: { placeId: c.placeId, name: c.name, address: null, location: c.location, types: [] } })))
        .map((v) => v.candidate_id);
      for (let i = 0; i < chosen.length; i += LIMITS.addPerOperation) {
        await run("update_pois", {
          operation: "add", base_version: store.version, op_id: `viewpoints-${i}`,
          pois: chosen.slice(i, i + LIMITS.addPerOperation).map((c, k) => ({
            name: c.name, query: c.query, category: "viewpoint", reason: c.reason, sources: [], candidate_id: ids[i + k],
          })),
          remove_ids: [], remove_category: null, area: null, requested_count: null,
        }, task);
      }
      // Note, avis, prix et horaires : demandés en arrière-plan (mémoire seulement)
      for (const id of task.addedIds) {
        const poi = store.pois.get(id);
        if (poi?.place?.placeId) resolvePoi.getDetails(poi.place.placeId).then((info) => store.setPlaceInfo(id, info)).catch(() => {});
      }
      viewpoints.setState("shown");
      const placed = task.addedIds.filter((id) => store.pois.get(id)?.status === "resolved").length;
      const skipped = inZone.filter(already).length;
      return `Points de vue affichés : ${placed}` + (skipped ? ` (${skipped} déjà sur la carte).` : ".");
    } catch (err) {
      console.warn("[points de vue] affichage :", err.message);
      viewpoints.setState("error");
      return "Les points de vue n'ont pas pu être préparés (erreur technique).";
    }
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
    // Type Google exact (liste officielle) : recherche directe par type, sinon par mots
    const googleType = GOOGLE_TYPE_LIST.includes(args.google_type) ? args.google_type : null;
    const found = await resolvePoi.searchNear({ textQuery: what, googleType, anchors, radius, position });
    const anchorNames = anchors.map((a) => a.name).join(" et ");
    console.log(`[places] « ${what} »${googleType ? ` [${googleType}]` : ""} près de ${anchorNames} :`, found.map((c) => `${c.place.name} (${c.direction})`).join(" | ") || "rien");
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

  // Localisation directe (tâche locate) : chaque lieu nommé est cherché autour de l'utilisateur par
  // paliers (10, 30 puis 60 min à pied) ; le lieu le plus pertinent pour Google au premier palier où il
  // apparaît est placé. Un nom introuvable à 60 min, ou un lieu décrit par rapport à un repère : null,
  // la tâche passe au modèle (recherche web, repères).
  async function locateDirect(task) {
    const names = task.placeNames || [];
    const position = store.context.position;
    if (!names.length || !position) return null;
    const results = await Promise.all(names.map((name) => resolvePoi.findNamed(name, position).catch(() => null)));
    if (results.some((r) => !r)) {
      task.log(`localisation directe : ${names.filter((n, i) => !results[i]).map((n) => `« ${n} »`).join(", ")} introuvable(s) à moins de 60 min à pied`);
      return null;
    }
    const chosen = results.map((r) => r.found[0]);
    const onMap = new Set([...store.pois.values()].map((p) => p.place?.placeId).filter(Boolean));
    const fresh = chosen.filter((c) => !onMap.has(c.place.placeId));
    const ids = store.rememberCandidates(fresh).map((c) => c.candidate_id);
    const meters = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace(".", ",")} km`);
    if (fresh.length) {
      await run("update_pois", {
        operation: "add", base_version: store.version, op_id: `locate-${task.id}`,
        pois: fresh.map((c, k) => ({
          name: c.place.name, query: [c.place.name, c.place.address].filter(Boolean).join(", "), category: categoryFromTypes(c.place.types),
          reason: c.place.address ? `${c.place.address}.` : "", sources: [], candidate_id: ids[k], verified: null, check_note: "",
        })),
        remove_ids: [], remove_category: null, area: null, requested_count: null,
      }, task);
    }
    const lines = chosen.map((c, i) => `« ${names[i]} » → ${c.place.name}, à ${meters(c.distance_from_user_m)} (recherche à ${Math.round(results[i].radius / 80)} min à pied)${onMap.has(c.place.placeId) ? ", déjà sur la carte" : ""}`);
    task.log(`localisation directe : ${lines.join(" ; ")}`);
    return `Lieu(x) placé(s) d'après Google : ${lines.join(" ; ")}.`;
  }

  // Recherche directe (canaux google et mixed, sans le modèle de calcul). La demande est découpée par
  // le détecteur : la partie Google (type exact, formulations, ouvert, bien noté, pas cher) est
  // cherchée tout de suite et TOUS les lieux du rayon s'affichent (20 au plus, du plus proche au plus
  // loin) ; la partie web (check : critère concret, thème ou réputation) est vérifiée ensuite en
  // arrière-plan sur ces lieux (analyzeInBackground). On garde les lieux du bon type ou sans type
  // précis (Google n'a pas classé la station du Super U de Quiberon), jamais ceux classés dans un autre
  // type (bornes de recharge, gare…) ; ceux où le type n'est que secondaire (un poké bowl classé aussi
  // « thaï ») seulement s'il n'y a presque rien d'autre. null si rien ne convient : la tâche passe au
  // modèle.
  async function googleDirect(task) {
    const g = task.google;
    const position = store.context.position;
    if (!g?.words?.length || !position) return null;
    const limitM = task.maxDistanceM || DEFAULT_RADIUS_M;
    const radius = Math.min(Math.max(limitM, 300), 10000);
    const anchors = [{ name: "l'utilisateur", location: position }];
    // Le type demandé et ses cousins (pâtisserie : pâtisserie, boulangerie, confiserie…)
    const family = familyOf(g.type);
    const previous = task.previousAddedIds.filter((id) => store.pois.has(id));
    // Ajout à un groupe : le nombre demandé ; sinon, recherche exhaustive
    const goal = task.extends ? Math.max(1, (task.requestedCount || 1) - previous.length) : MAX_RESULTS;
    const runs = await Promise.all(g.words.slice(0, 3).map((word, i) =>
      resolvePoi.searchNear({ textQuery: word, googleType: i === 0 ? family : null, anchors, radius, position, limit: 20, want: Math.min(goal, 20) }).catch(() => [])));
    const seen = new Set();
    const found = runs.flat().filter((c) => !seen.has(c.place.placeId) && seen.add(c.place.placeId));
    const GENERIC = new Set(["point_of_interest", "establishment", "service", "store", "food"]);
    // Le nom fait foi : un lieu qui porte le mot cherché (« ma douce patisserie-cafe » pour
    // « pâtisserie ») est gardé quel que soit son type Google
    const named = (c) => g.words.some((w) => plain(c.place.name).includes(plain(w)));
    // 0 : un type de la famille demandée est sa catégorie principale, ou son nom porte le mot cherché
    // (ou pas de type demandé) ; 1 : lieu sans type précis ; 2 : type de la famille seulement
    // secondaire ; 3 : classé dans un autre type, écarté
    const rank = (c) => {
      if (!g.type || family.includes(c.place.primaryType) || named(c)) return 0;
      if (c.place.types.every((type) => GENERIC.has(type))) return 1;
      return c.place.types.some((type) => family.includes(type)) ? 2 : 3;
    };
    const onMap = new Set([...store.pois.values()].map((p) => p.place?.placeId).filter(Boolean));
    const matching = found
      .filter((c) => rank(c) < 3)
      .filter((c) => !onMap.has(c.place.placeId))
      .filter((c) => !g.openNow || c.place.openNow !== false)
      .filter((c) => !g.minRating || (c.place.rating ?? 0) >= g.minRating)
      .filter((c) => !g.cheap || !c.place.priceLevel || CHEAP_LEVELS.includes(c.place.priceLevel))
      .sort((a, b) => a.distance_from_user_m - b.distance_from_user_m);
    const main = matching.filter((c) => rank(c) < 2);
    const pool = main.length >= 3 ? main : matching;
    // Dans le rayon ; sans rayon donné et rien dans les 15 min, les 3 plus proches que Google connaît
    let kept = pool.filter((c) => c.distance_from_user_m <= limitM);
    if (!kept.length && !task.maxDistanceM) kept = pool.slice(0, 3);
    task.log(`recherche Google directe : ${g.words.map((w) => `« ${w} »`).join(", ")}${g.type ? ` [${g.type}]` : ""} → ${found.length} lieu(x), ${kept.length} retenu(s)`);
    const chosen = kept.slice(0, goal);
    if (!chosen.length) return null;
    // Version précédente de la tâche (précision) : ses lieux sont remplacés ; ajout à un groupe : gardés
    if (!task.extends && previous.length) {
      await run("update_pois", {
        operation: "remove", base_version: store.version, op_id: `direct-replace-${task.id}`,
        pois: [], remove_ids: previous, remove_category: null, area: null, requested_count: null,
      }, task);
    }
    const ids = store.rememberCandidates(chosen).map((c) => c.candidate_id);
    // Description de la fiche : l'ouverture et l'adresse (le temps de marche et la note s'affichent à part)
    const describe = (c) => [
      c.place.openNow === true ? "Ouvert en ce moment" : c.place.openNow === false ? "Fermé en ce moment" : null,
      c.place.address,
    ].filter(Boolean).join(" · ") + ".";
    // Partie web : chaque lieu est « en cours d'analyse » (arcs autour du marqueur) jusqu'à sa réponse
    const pending = g.check ? { status: "pending", label: g.check.label, note: "" } : null;
    await run("update_pois", {
      operation: "add", base_version: store.version, op_id: `direct-${task.id}`,
      pois: chosen.map((c, k) => ({
        name: c.place.name, query: [c.place.name, c.place.address].filter(Boolean).join(", "), category: g.category,
        reason: describe(c), sources: [], candidate_id: ids[k], verified: null, check_note: "", check: pending,
      })),
      remove_ids: [], remove_category: null, area: null, requested_count: null,
    }, task);
    const placed = chosen.map((c) => ({ c, id: [...store.pois.values()].find((p) => p.place?.placeId === c.place.placeId)?.id })).filter((x) => x.id);
    const what = task.groupName || task.title;
    if (g.check && verifier) analyzeInBackground(task, g, placed, what);
    return `${placed.length} lieu(x) trouvé(s) d'après Google, tous affichés : ${placed.map(({ c }) => c.place.name).join(", ")}.`
      + (g.check ? ` Analyse web en cours pour « ${g.check.label} » (${g.check.kind === "reputation" ? "lesquels sont recommandés" : g.check.question}) : le résultat arrivera ensuite.` : "")
      + (g.ignored?.length ? ` Non pris en compte (trop vague) : ${g.ignored.join(", ")}.` : "")
      + (!task.maxDistanceM && kept.every((c) => c.distance_from_user_m > limitM) ? " Aucun à moins de 15 minutes : les plus proches connus de Google." : "");
  }

  // Partie web de la recherche, en arrière-plan : 5 lieux à la fois, du plus proche au plus loin.
  // Chaque réponse met à jour le lieu : confirmé ou recommandé (bague verte), à vérifier (bague
  // orange), écarté (grisé ; seulement pour un critère concret). À la fin, le guide le dit.
  async function analyzeInBackground(task, g, placed, what) {
    const counts = { confirmed: 0, maybe: 0, rejected: 0 };
    for (let i = 0; i < placed.length; i += ANALYSIS_BATCH) {
      const batch = placed.slice(i, i + ANALYSIS_BATCH).filter(({ id }) => store.pois.has(id));
      const answers = await verifier.verify(batch.map(({ c }) => c.place), g.check);
      batch.forEach(({ id }, k) => {
        const { answer, note } = answers[k];
        const status = answer === "confirmed" || answer === "recommended" ? "confirmed"
          : answer === "no" && g.check.kind === "criterion" ? "rejected" : "maybe";
        counts[status]++;
        store.setPoiCheck(id, { status, label: g.check.label, note: status === "maybe" && g.check.kind === "reputation" ? "" : note });
      });
    }
    const summary = g.check.kind === "reputation"
      ? `${counts.confirmed} recommandé(s), ${counts.maybe} sans recommandation trouvée`
      : `${counts.confirmed} confirmé(s) (« ${g.check.label} »), ${counts.maybe} à vérifier sur place, ${counts.rejected} écarté(s)`;
    task.log(`analyse web terminée : ${summary}`);
    announce?.(`Analyse web terminée pour « ${what} » : ${summary}. Dis-le en une phrase courte, sans citer les lieux (les bagues vertes et orange sont sur la carte).`);
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

  // Temps de marche depuis l'endroit de la recherche vers les lieux qu'elle a ajoutés (un seul appel
  // Google pour tous) : affiché dans la fiche tant que l'utilisateur reste à 100 m au plus de cet endroit
  async function attachWalks(ids) {
    const position = store.context.position;
    const pois = [...new Set(ids)].map((id) => store.pois.get(id)).filter((p) => p?.status === "resolved" && p.place?.location && !p.special);
    if (!position || !pois.length) return;
    const from = { lat: position.lat, lng: position.lng };
    let seconds;
    try {
      seconds = (await resolvePoi.walkMatrix([from], pois.map((p) => p.place.location)))[0].map((cell) => cell?.seconds ?? null);
    } catch {
      // Trajets indisponibles : estimation à vol d'oiseau (80 m par minute de marche)
      seconds = pois.map((p) => (distanceM(from, p.place.location) / 80) * 60);
    }
    store.setWalks(pois.map((p, i) => [p.id, Number.isFinite(seconds[i]) ? { seconds: Math.round(seconds[i]), from } : null]).filter(([, w]) => w));
  }

  return { run, enforceDistance, relocate, placeBackPoint, discover, showViewpoints, googleDirect, locateDirect, attachWalks };
}
