// État applicatif de la conversation : liste des POI, préférences et contexte de l'utilisateur.
// C'est la seule source de vérité : le modèle demande des modifications (update_pois,
// update_preferences), ce module les valide et les applique, puis prévient les abonnés
// (navigateur, agent) par l'événement « change ». Tout reste en mémoire (rien n'est enregistré).

import { EventEmitter } from "node:events";

// Catégories normalisées, partagées avec le navigateur (icônes) et le modèle (schéma de l'outil)
export const CATEGORIES = ["restaurant", "museum", "monument", "garden", "viewpoint", "activity", "parking", "other"];

// Place d'une étape figée (cadenas) : { position: "first" } et { position: "last" } restent relatives
// (toujours la première / la dernière, même si des lieux sont ajoutés) ; { position: "index", index }
// fige un numéro précis. Numéro d'étape correspondant (1 à n), n = nombre d'étapes à visiter.
export function pinSlot(pin, n) {
  if (!pin) return null;
  if (pin.position === "first") return 1;
  if (pin.position === "last") return n;
  return pin.index;
}

const describePin = (pin) => (pin.position === "first" ? "première étape" : pin.position === "last" ? "dernière étape" : `étape n° ${pin.index}`);

export const LIMITS = {
  addPerOperation: 10,
  selectionSize: 25,
  name: 120,
  query: 200,
  reason: 300,
  sources: 3,
  area: 120,
};

// Comparaison de noms insensible à la casse, aux accents et à la ponctuation
export function normalize(text = "") {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const cleanText = (value, max) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((url) => typeof url === "string" && /^https:\/\/[^\s]+$/.test(url) && url.length <= 500)
    .slice(0, LIMITS.sources);
}

export class PoiStore extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.version = 0;
    this.pois = new Map();      // id → POI, dans l'ordre d'ajout
    this.nextId = 1;
    this.doneOps = new Map();   // op_id → résultat déjà renvoyé (idempotence)
    this.candidates = new Map(); // cand_… → lieu Google proposé par find_places_near
    this.nextCandidate = 1;
    this.history = [];          // { version, removedNames: Set, removedCategories: Set, replaced: bool }
    this.preferences = {
      excluded_categories: [],
      budget: null,
      cuisine: null,
      max_walk_minutes: null,
      quietness: null,
      transport: "à pied",
      time_constraints: null,
      notes: [],
    };
    this.context = { position: null, positionSource: null, place: null, timezone: null, updatedAt: null };
  }

  // ---- Lecture ----

  poiView(poi) {
    return {
      id: poi.id,
      name: poi.name,
      category: poi.category,
      query: poi.query,
      reason: poi.reason,
      sources: poi.sources,
      status: poi.status,
      included: poi.included,
      visited: Boolean(poi.visitedAt),
      map_number: poi.mapNumber || null,
      pin: poi.pin || null,
      place: poi.place,
      candidates: poi.candidates,
    };
  }

  // État complet envoyé au navigateur
  snapshot() {
    return {
      version: this.version,
      pois: [...this.pois.values()].map((p) => this.poiView(p)),
      preferences: this.preferences,
    };
  }

  // État résumé pour le modèle : ce dont il a besoin pour raisonner, sans détail inutile
  selectionForModel() {
    return {
      version: this.version,
      pois: [...this.pois.values()].map((p) => ({
        id: p.id,
        name: p.place?.name || p.name,
        category: p.category,
        status: p.status,
        ...(p.mapNumber ? { map_number: p.mapNumber } : {}),
        ...(p.pin ? { pinned: p.pin.position === "index" ? p.pin.index : p.pin.position } : {}),
        ...(p.place?.address ? { address: p.place.address } : {}),
        ...(p.candidates?.length ? { google_candidates: p.candidates.map((c) => `${c.name} (${c.address || "adresse inconnue"})`) } : {}),
        ...(p.included ? {} : { excluded_by_user: true }),
        ...(p.visitedAt ? { visited: true } : {}),
      })),
      preferences: this.preferences,
      context: this.contextForModel(),
    };
  }

  contextForModel() {
    const { position, positionSource, place, timezone } = this.context;
    const now = new Date();
    const localTime = timezone
      ? now.toLocaleString("fr-FR", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
      : null;
    return {
      position: position ? { lat: +position.lat.toFixed(5), lng: +position.lng.toFixed(5) } : null,
      position_source: positionSource,
      place,
      local_time: localTime,
      timezone,
    };
  }

  // Lieux Google proposés au modèle : il pourra en ajouter un tel quel (candidate_id dans update_pois),
  // sans nouvelle recherche, donc sans risque de confusion
  rememberCandidates(list) {
    return list.map((c) => {
      const id = `cand_${this.nextCandidate++}`;
      this.candidates.set(id, c.place);
      return { candidate_id: id, name: c.place.name, address: c.place.address, position: c.direction, ...(c.distance_from_user_m != null ? { distance_from_user_m: c.distance_from_user_m } : {}) };
    });
  }

  // ---- Contexte ----

  setContext(patch) {
    Object.assign(this.context, patch, { updatedAt: Date.now() });
  }

  // ---- Modifications demandées par le modèle ----

  // update_pois : add | remove | replace. Renvoie toujours un résultat structuré pour le modèle.
  updatePois(args) {
    const opId = cleanText(args.op_id, 80);
    if (opId && this.doneOps.has(opId)) {
      return { ...this.doneOps.get(opId), note: "Opération déjà appliquée (même op_id) : rien n'a été refait." };
    }
    const result = this.#applyUpdate(args);
    if (opId && result.status !== "rejected") this.doneOps.set(opId, result);
    return result;
  }

  #applyUpdate(args) {
    const { operation } = args;
    const base = Number.isInteger(args.base_version) ? args.base_version : -1;
    const stale = base !== this.version;

    if (operation === "replace") {
      // Remplacer toute la sélection à partir d'un état périmé effacerait des changements récents
      if (stale) return this.#reject("conflict", `La liste a changé depuis la version ${base} (actuelle : ${this.version}). Relis la sélection avant de la remplacer.`);
      const { accepted, skipped } = this.#validateNewPois(args.pois, { replacing: true });
      if (!accepted.length) return this.#reject("invalid", "Aucun lieu valide à mettre dans la nouvelle sélection.", skipped);
      const removed = [...this.pois.values()];
      this.pois.clear();
      const added = accepted.map((p) => this.#insert(p, args.area));
      return this.#commit({ removed, added, skipped, replaced: true });
    }

    if (operation === "add") {
      const { accepted, skipped } = this.#validateNewPois(args.pois, { sinceVersion: stale ? base : null });
      if (!accepted.length) return this.#reject("nothing_added", "Aucun lieu ajouté.", skipped);
      const added = accepted.map((p) => this.#insert(p, args.area));
      return this.#commit({ added, skipped });
    }

    if (operation === "remove") {
      const ids = Array.isArray(args.remove_ids) ? args.remove_ids.filter((id) => typeof id === "string") : [];
      const category = CATEGORIES.includes(args.remove_category) ? args.remove_category : null;
      if (!ids.length && !category) return this.#reject("invalid", "Indique remove_ids ou remove_category.");
      const removed = [];
      const unknown = [];
      for (const id of ids) {
        const poi = this.pois.get(id);
        if (poi) removed.push(poi);
        else unknown.push(id);
      }
      if (category) for (const poi of this.pois.values()) if (poi.category === category && !removed.includes(poi)) removed.push(poi);
      for (const poi of removed) this.pois.delete(poi.id);
      if (!removed.length) {
        // Idempotent : supprimer un lieu déjà absent n'est pas une erreur
        return { status: "unchanged", version: this.version, message: "Ces lieux n'étaient déjà plus dans la liste.", unknown_ids: unknown, selection: this.selectionForModel() };
      }
      return this.#commit({ removed, unknownIds: unknown, removedCategory: category });
    }

    return this.#reject("invalid", "operation doit valoir add, remove ou replace.");
  }

  // Vérifie les nouveaux lieux : champs, catégories exclues, doublons, lieux retirés entre-temps
  #validateNewPois(list, { replacing = false, sinceVersion = null } = {}) {
    const accepted = [];
    const skipped = [];
    if (!Array.isArray(list)) return { accepted, skipped };
    const existing = replacing ? [] : [...this.pois.values()];
    const removedSince = new Set();
    if (sinceVersion !== null) for (const h of this.history) if (h.version > sinceVersion) h.removedNames.forEach((n) => removedSince.add(n));

    const room = LIMITS.selectionSize - existing.length;
    for (const raw of list.slice(0, LIMITS.addPerOperation)) {
      const name = cleanText(raw?.name, LIMITS.name);
      const query = cleanText(raw?.query, LIMITS.query);
      const category = CATEGORIES.includes(raw?.category) ? raw.category : null;
      if (!name || !query || !category) {
        skipped.push({ name: name || "(sans nom)", reason: "champ name, query ou category manquant ou invalide" });
        continue;
      }
      if (this.preferences.excluded_categories.includes(category)) {
        skipped.push({ name, reason: `catégorie « ${category} » exclue par l'utilisateur (update_preferences pour lever l'exclusion s'il a changé d'avis)` });
        continue;
      }
      // Lieu choisi parmi les candidats de find_places_near : déjà localisé
      let place = null;
      if (typeof raw.candidate_id === "string" && raw.candidate_id) {
        place = this.candidates.get(raw.candidate_id) || null;
        if (!place) {
          skipped.push({ name, reason: `candidate_id inconnu (${raw.candidate_id}) : relance find_places_near` });
          continue;
        }
      }
      const key = normalize(name);
      const dup = [...existing, ...accepted].find((p) =>
        normalize(p.name) === key || normalize(p.query) === normalize(query) || (p.place && normalize(p.place.name) === key) ||
        (place && p.place?.placeId === place.placeId));
      if (dup) {
        skipped.push({ name, reason: `déjà dans la liste (id ${dup.id || "nouveau"})` });
        continue;
      }
      if (removedSince.has(key)) {
        skipped.push({ name, reason: "retiré de la liste depuis la version sur laquelle s'appuie cette demande" });
        continue;
      }
      if (accepted.length >= room) {
        skipped.push({ name, reason: `liste pleine (${LIMITS.selectionSize} lieux au maximum)` });
        continue;
      }
      accepted.push({ name, query, category, reason: cleanText(raw.reason, LIMITS.reason), sources: cleanSources(raw.sources), place });
    }
    return { accepted, skipped };
  }

  #insert(p, area) {
    const poi = {
      id: `poi_${this.nextId++}`,
      ...p,
      area: cleanText(area, LIMITS.area) || null,
      status: p.place ? "resolved" : "pending",
      included: true,
      visitedAt: null,
      pin: null,
      place: p.place || null,
      candidates: null,
      createdAt: Date.now(),
    };
    this.pois.set(poi.id, poi);
    return poi;
  }

  #commit({ added = [], removed = [], skipped = [], unknownIds = [], replaced = false, removedCategory = null }) {
    this.version++;
    this.history.push({ version: this.version, removedNames: new Set(removed.map((p) => normalize(p.name))), replaced });
    if (this.history.length > 50) this.history.shift();
    const result = {
      status: "applied",
      version: this.version,
      ...(added.length ? { added: added.map((p) => ({ id: p.id, name: p.name, status: p.status })) } : {}),
      ...(removed.length ? { removed: removed.map((p) => ({ id: p.id, name: p.name })) } : {}),
      ...(removedCategory ? { removed_category: removedCategory } : {}),
      ...(skipped.length ? { skipped } : {}),
      ...(unknownIds.length ? { unknown_ids: unknownIds } : {}),
      ...(added.length ? { note: "Les lieux ajoutés sont en cours de localisation sur la carte (status pending)." } : {}),
      selection: this.selectionForModel(),
    };
    this.emit("change", { added, removed });
    return result;
  }

  #reject(code, message, skipped = []) {
    return { status: "rejected", code, message, ...(skipped.length ? { skipped } : {}), version: this.version, selection: this.selectionForModel() };
  }

  // update_preferences : préférences persistantes, révisables si l'utilisateur change d'avis.
  // Un champ à null reste inchangé ; clear_fields efface les préférences abandonnées.
  updatePreferences(args) {
    const prefs = this.preferences;
    const changed = [];
    const exclude = (args.exclude_categories || []).filter((c) => CATEGORIES.includes(c));
    const allow = (args.allow_categories || []).filter((c) => CATEGORIES.includes(c));
    for (const c of exclude) if (!prefs.excluded_categories.includes(c)) { prefs.excluded_categories.push(c); changed.push(`exclut ${c}`); }
    for (const c of allow) if (prefs.excluded_categories.includes(c)) { prefs.excluded_categories = prefs.excluded_categories.filter((x) => x !== c); changed.push(`réautorise ${c}`); }
    for (const field of ["budget", "cuisine", "quietness", "transport", "time_constraints"]) {
      const value = cleanText(args[field], 120);
      if (value) {
        prefs[field] = value;
        changed.push(field);
      }
    }
    if (Number.isFinite(args.max_walk_minutes) && args.max_walk_minutes > 0 && args.max_walk_minutes <= 180) {
      prefs.max_walk_minutes = Math.round(args.max_walk_minutes);
      changed.push("max_walk_minutes");
    }
    for (const field of args.clear_fields || []) {
      if (field === "notes") prefs.notes = [];
      else if (["budget", "cuisine", "quietness", "time_constraints", "max_walk_minutes"].includes(field)) prefs[field] = null;
      else continue;
      changed.push(`efface ${field}`);
    }
    if (typeof args.add_note === "string" && args.add_note.trim()) {
      prefs.notes = [...prefs.notes, cleanText(args.add_note, 160)].slice(-8);
      changed.push("note");
    }
    if (changed.length) {
      this.version++;
      this.emit("change", { added: [], removed: [] });
    }
    return { status: changed.length ? "applied" : "unchanged", changed, version: this.version, preferences: prefs };
  }

  // ---- Modifications venues de l'interface ou de la résolution Google ----

  // Numéros d'étape affichés sur la carte et dans la liste (calculés par la page selon l'ordre de
  // l'itinéraire) : ils permettent au modèle de comprendre « supprime le point n° 6 ». Information
  // d'affichage : la version de la liste ne change pas.
  setMapNumbers(numbers) {
    for (const poi of this.pois.values()) {
      const n = numbers[poi.id];
      poi.mapNumber = Number.isInteger(n) && n > 0 && n < 1000 ? n : null;
    }
  }

  setIncluded(id, included) {
    const poi = this.pois.get(id);
    if (!poi || poi.included === included) return null;
    poi.included = included;
    if (!included) poi.pin = null; // exclu : il n'a plus de place dans l'itinéraire
    this.version++;
    this.emit("change", { added: [], removed: [] });
    return poi;
  }

  // ---- Étapes figées (cadenas), demandées par le modèle (pin_steps) ou posées à la main ----

  // Nombre d'étapes à visiter (lieux placés sur la carte, cochés, pas encore visités)
  stepCount() {
    return [...this.pois.values()].filter((p) => p.status === "resolved" && p.included && !p.visitedAt).length;
  }

  pinSteps(args) {
    const applied = [], rejected = [], reincluded = [], replaced = [];
    for (const id of Array.isArray(args.unpin_ids) ? args.unpin_ids : []) {
      const poi = this.pois.get(id);
      if (!poi?.pin) continue;
      poi.pin = null;
      applied.push({ id, name: poi.place?.name || poi.name, position: "cadenas retiré" });
    }
    for (const raw of (Array.isArray(args.pins) ? args.pins : []).slice(0, 10)) {
      const poi = this.pois.get(raw?.id);
      const name = poi?.place?.name || poi?.name;
      if (!poi) { rejected.push({ id: raw?.id, reason: "identifiant inconnu" }); continue; }
      if (poi.visitedAt) { rejected.push({ id: poi.id, name, reason: "lieu déjà visité" }); continue; }
      if (poi.status !== "resolved") { rejected.push({ id: poi.id, name, reason: "lieu pas encore placé sur la carte" }); continue; }
      let pin;
      if (raw.position === "first" || raw.position === "last") pin = { position: raw.position };
      else if (raw.position === "index" && Number.isInteger(raw.index) && raw.index >= 1) pin = { position: "index", index: raw.index };
      else { rejected.push({ id: poi.id, name, reason: "position invalide" }); continue; }
      // Lieu exclu (décoché) : il revient dans l'itinéraire
      const n = this.stepCount() + (poi.included ? 0 : 1);
      if (pin.position === "index" && pin.index > n) {
        rejected.push({ id: poi.id, name, reason: `il n'y a que ${n} étape(s)` });
        continue;
      }
      if (!poi.included) {
        poi.included = true;
        reincluded.push({ id: poi.id, name });
      }
      // La dernière demande l'emporte : un autre lieu figé à la même place perd son cadenas
      for (const other of this.pois.values()) {
        if (other === poi || !other.pin || other.visitedAt || !other.included) continue;
        if (pinSlot(other.pin, n) === pinSlot(pin, n)) {
          other.pin = null;
          replaced.push({ id: other.id, name: other.place?.name || other.name });
        }
      }
      poi.pin = pin;
      applied.push({ id: poi.id, name, position: describePin(pin) });
    }
    if (!applied.length) {
      return { status: "rejected", rejected, version: this.version, selection: this.selectionForModel() };
    }
    this.version++;
    this.emit("change", { added: [], removed: [] });
    return {
      status: "applied",
      version: this.version,
      applied,
      ...(reincluded.length ? { reincluded, note_reincluded: "Ces lieux étaient exclus : ils ont été remis dans l'itinéraire." } : {}),
      ...(replaced.length ? { unpinned_because_same_place: replaced } : {}),
      ...(rejected.length ? { rejected } : {}),
      note: "L'itinéraire est réorganisé autour des étapes figées ; les numéros affichés (map_number) vont changer.",
      selection: this.selectionForModel(),
    };
  }

  setVisited(id) {
    const poi = this.pois.get(id);
    if (!poi || poi.visitedAt) return null;
    poi.visitedAt = Date.now();
    poi.pin = null; // une étape visitée perd son cadenas
    this.version++;
    this.emit("change", { added: [], removed: [] });
    return poi;
  }

  // Résultat de la résolution Google Places (ignoré si le lieu a été retiré entre-temps)
  setResolution(id, resolution) {
    const poi = this.pois.get(id);
    if (!poi) return null;
    Object.assign(poi, resolution);
    this.version++;
    this.emit("change", { added: [], removed: [], resolved: poi });
    return poi;
  }

  // Lieu résolu sur le même établissement qu'un lieu déjà présent : on retire le doublon
  removeDuplicate(id) {
    const poi = this.pois.get(id);
    if (!poi) return null;
    this.pois.delete(id);
    this.version++;
    this.history.push({ version: this.version, removedNames: new Set(), replaced: false });
    this.emit("change", { added: [], removed: [poi] });
    return poi;
  }
}
