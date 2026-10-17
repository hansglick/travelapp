// Résolution des POI dans Google Places : la chaîne query proposée par le modèle est cherchée avec
// Text Search, puis on choisit le résultat le plus vraisemblable (nom, catégorie, distance) au lieu
// de prendre le premier. Indépendant de la conversation et de la recherche OpenAI.
//
// Champs demandés : uniquement ceux du palier « Pro » nécessaires à l'affichage (pas de notes ni
// d'avis, plus chers). Le place_id peut être conservé ; le reste n'est gardé qu'en mémoire.

import { normalize } from "./store.mjs";

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.businessStatus",
].join(",");

const TIMEOUT_MS = 6000;
const MAX_PARALLEL = 4;
const BIAS_RADIUS_M = 10000;     // recherche orientée autour de l'utilisateur
const MAX_DISTANCE_KM = 50;      // au-delà, sans zone indiquée, ce n'est pas le bon lieu

// Types Google attendus pour chaque catégorie (un type qui se termine par « _restaurant » compte aussi)
const CATEGORY_TYPES = {
  restaurant: ["restaurant", "food", "cafe", "bar", "bakery", "meal_takeaway", "coffee_shop", "ice_cream_shop", "wine_bar", "pub"],
  museum: ["museum", "art_gallery", "art_museum", "history_museum"],
  monument: ["historical_landmark", "historical_place", "monument", "church", "place_of_worship", "mosque", "synagogue", "castle", "cultural_landmark", "tourist_attraction", "sculpture"],
  garden: ["park", "garden", "botanical_garden", "city_park", "national_park"],
  viewpoint: ["observation_deck", "scenic_spot", "tourist_attraction", "park", "beach", "natural_feature", "hiking_area", "historical_landmark"],
  parking: ["parking", "parking_lot", "parking_garage"],
  activity: null, // tout type convient
  other: null,
};

const STOPWORDS = new Set(["le", "la", "les", "l", "de", "du", "des", "d", "et", "the", "of", "a", "au", "aux", "en", "and"]);
// Mots génériques : ils ne suffisent pas à reconnaître un lieu (« Restaurant X » ≠ « Restaurant Y »)
const GENERIC = new Set([
  "restaurant", "restaurants", "taverna", "taverne", "tavern", "cafe", "bar", "bistro", "brasserie", "pizzeria",
  "musee", "museum", "galerie", "gallery", "eglise", "church", "chapelle", "cathedrale", "mosquee", "mosque",
  "jardin", "jardins", "garden", "gardens", "parc", "park", "plage", "beach", "place", "square", "point", "vue",
  "monument", "porte", "gate", "fontaine", "fountain", "tour", "tower", "chateau", "castle", "fort", "forteresse",
  "parking", "car", "park", "lot", "garage",
  "old", "town", "vieille", "ville", "city", "centre", "center", "public", "municipal", "national", "historique", "historical",
]);

const words = (text) => normalize(text).split(" ").filter((w) => w && !STOPWORDS.has(w));
const distinctive = (list) => list.filter((w) => !GENERIC.has(w));
// Même mot, ou variante d'orthographe (Rethymno / Rethymnon) : préfixe commun d'au moins 5 lettres
const same = (x, y) => x === y || (x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x)));

// Nom descriptif (« Municipal Garden of Rethymno ») : en dehors des mots génériques, il ne contient
// que des noms de lieux déjà présents dans la suite de la requête (ville, pays)
function isDescriptive(poi) {
  const tail = words(poi.query.split(",").slice(1).join(" "));
  return distinctive(words(poi.name)).every((w) => tail.some((v) => same(w, v)));
}

// Ressemblance de deux noms (0 à 1) : part des mots distinctifs d'un nom retrouvés dans l'autre
// (le meilleur des deux sens). Sans aucun mot distinctif commun, les noms ne correspondent pas.
function nameSimilarity(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const coverage = (from, to) => {
    const keys = distinctive(from).length ? distinctive(from) : from; // nom fait seulement de mots génériques
    return keys.filter((w) => to.some((v) => same(w, v))).length / keys.length;
  };
  const wa = words(a), wb = words(b);
  if (!wa.length || !wb.length) return 0;
  const sharedDistinctive = distinctive(wa).some((w) => wb.some((v) => same(w, v)));
  if (!sharedDistinctive && distinctive(wa).length && distinctive(wb).length) return 0;
  return Math.max(coverage(wa, wb), coverage(wb, wa));
}

function categoryMatch(category, types = []) {
  const expected = CATEGORY_TYPES[category];
  if (!expected) return 1;
  return types.some((t) => expected.includes(t) || (category === "restaurant" && t.endsWith("_restaurant")) || (category === "museum" && t.endsWith("_museum"))) ? 1 : 0;
}

function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

// Limite le nombre de requêtes Google simultanées
let running = 0;
const waiting = [];
async function withSlot(task) {
  if (running >= MAX_PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  running++;
  try {
    return await task();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function createResolver({ apiKey, metrics }) {
  // Un même lieu n'est cherché qu'une fois par session (clé : requête + zone + position arrondie)
  const cache = new Map();

  async function textSearch(poi, position, languageCode, textQuery = poi.query) {
    const body = { textQuery, languageCode, maxResultCount: 5 };
    if (position && !poi.area) {
      body.locationBias = { circle: { center: { latitude: position.lat, longitude: position.lng }, radius: BIAS_RADIUS_M } };
    }
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    metrics.count("google_text_search");
    if (!response.ok) throw new Error(`Places Text Search ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return (await response.json()).places || [];
  }

  function choose(poi, places, position) {
    // « Fermé définitivement » n'écarte que les établissements : un monument (ancienne mosquée devenue
    // conservatoire…) se visite toujours, même si Google le marque fermé
    const business = ["restaurant", "museum", "activity", "parking"].includes(poi.category);
    const scored = places
      .filter((p) => p.location && !(business && p.businessStatus === "CLOSED_PERMANENTLY"))
      .map((p) => {
        const location = { lat: p.location.latitude, lng: p.location.longitude };
        const name = p.displayName?.text || "";
        const queryHead = poi.query.split(",")[0];
        const similarity = Math.max(nameSimilarity(poi.name, name), nameSimilarity(queryHead, name));
        const km = position ? distanceKm(position, location) : 0;
        const proximity = poi.area || !position ? 1 : Math.max(0, Math.min(1, 1 - (km - 1.5) / 13.5));
        const score = 0.65 * similarity + 0.2 * categoryMatch(poi.category, p.types) + 0.15 * proximity;
        return { place: p, location, name, similarity, km, score };
      })
      .filter((c) => poi.area || !position || c.km <= MAX_DISTANCE_KM)
      .sort((a, b) => b.score - a.score);

    const toPlace = (c) => ({
      placeId: c.place.id,
      name: c.name,
      address: c.place.formattedAddress || null,
      location: c.location,
      types: (c.place.types || []).slice(0, 5),
    });
    const [best, second] = scored;
    // Nom descriptif et Google ne renvoie qu'un seul lieu, de la bonne catégorie et proche : il est sûr
    // de lui, même si les noms diffèrent (« Municipal Garden » en anglais, « Jardin Public » en français).
    // Jamais pour un nom propre : un lieu inexistant serait remplacé par un autre.
    if (best && places.length === 1 && isDescriptive(poi) && categoryMatch(poi.category, best.place.types) && (poi.area || !position || best.km <= 5)) {
      return { status: "resolved", place: toPlace(best), candidates: null };
    }
    if (!best || best.similarity < 0.5 || best.score < 0.6) {
      return { status: "not_found", place: null, candidates: scored.slice(0, 3).map(toPlace) };
    }
    const close = second && second.similarity >= 0.5 && second.score >= best.score - 0.1 && second.place.id !== best.place.id;
    if (close) {
      // Même enseigne à plusieurs adresses : la rue citée dans la requête départage
      const queryWords = distinctive(words(poi.query.split(",").slice(1).join(" "))).filter((w) => !/^\d+$/.test(w));
      const addressScore = (c) => distinctive(words(c.place.formattedAddress || "")).filter((w) => queryWords.some((q) => same(w, q))).length;
      const [a, b] = [addressScore(best), addressScore(second)];
      if (a !== b) return { status: "resolved", place: toPlace(a > b ? best : second), candidates: null };
      return { status: "ambiguous", place: null, candidates: scored.slice(0, 3).map(toPlace) };
    }
    return { status: "resolved", place: toPlace(best), candidates: null };
  }

  // Lieux correspondant à une recherche (« parking ») autour d'un ou deux repères, avec leur position
  // relative à chacun (« 460 m au sud de la forteresse, 130 m au nord-est du stade ») : le modèle
  // choisit, ou fait choisir l'utilisateur. La recherche est centrée sur le premier repère.
  async function searchNear({ textQuery, anchors, radius, position }) {
    const anchor = anchors[0].location;
    const body = {
      textQuery, languageCode: "fr", maxResultCount: 10,
      locationBias: { circle: { center: { latitude: anchor.lat, longitude: anchor.lng }, radius } },
    };
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    metrics.count("google_text_search");
    if (!response.ok) throw new Error(`Places Text Search ${response.status}`);
    return ((await response.json()).places || [])
      .filter((p) => p.location && p.businessStatus !== "CLOSED_PERMANENTLY")
      .map((p) => {
        const location = { lat: p.location.latitude, lng: p.location.longitude };
        const meters = Math.round(distanceKm(anchor, location) * 1000);
        return {
          place: {
            placeId: p.id,
            name: p.displayName?.text || "",
            address: p.formattedAddress || null,
            location,
            types: (p.types || []).slice(0, 5),
          },
          distance_m: meters,
          direction: anchors
            .map((a) => `${Math.round(distanceKm(a.location, location) * 1000)} m ${direction(a.location, location)} de ${a.name}`)
            .join(", "),
          ...(position ? { distance_from_user_m: Math.round(distanceKm(position, location) * 1000) } : {}),
        };
      })
      .filter((c) => c.distance_m <= Math.max(radius * 1.5, 300))
      .sort((a, b) => a.distance_m - b.distance_m)
      .slice(0, 6);
  }

  // Coordonnées d'un lieu décrit par son nom (repère qui n'est pas dans la liste) : premier résultat
  async function locate(textQuery, position) {
    const places = await textSearch({ query: textQuery }, position, "fr");
    const p = places.find((x) => x.location);
    return p ? { name: p.displayName?.text || textQuery, location: { lat: p.location.latitude, lng: p.location.longitude } } : null;
  }

  async function resolve(poi, position) {
    const key = [normalize(poi.query), poi.area || "", position ? `${position.lat.toFixed(2)},${position.lng.toFixed(2)}` : ""].join("|");
    if (cache.has(key)) {
      metrics.count("google_cache_hit");
      return cache.get(key);
    }
    const started = Date.now();
    const result = withSlot(async () => {
      try {
        let french = await textSearch(poi, position, "fr");
        // Aucun résultat : l'adresse donnée par le modèle est peut-être fausse (numéro, code postal).
        // Nouvel essai avec seulement le nom, la ville et le pays, sans aucun numéro.
        const parts = poi.query.split(",").map((x) => x.trim()).filter(Boolean);
        if (!french.length && parts.length > 2) {
          const tail = parts.slice(-2).map((x) => x.replace(/\d+/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
          french = await textSearch(poi, position, "fr", [parts[0], ...tail].join(", "));
        }
        const result = choose(poi, french, position);
        if (result.status === "resolved" || !french.length) return result;
        // Le modèle écrit parfois le nom en anglais (d'après ses sources) alors que Google répond en
        // français : nouvel essai en anglais, en gardant le nom français pour l'affichage
        const english = choose(poi, await textSearch(poi, position, "en"), position);
        if (english.status !== "resolved") return result;
        const frenchName = french.find((p) => p.id === english.place.placeId)?.displayName?.text;
        return { ...english, place: { ...english.place, name: frenchName || english.place.name } };
      } catch (err) {
        console.warn("[places]", poi.query, err.message);
        return { status: "error", place: null, candidates: null, error: "Recherche Google indisponible" };
      } finally {
        metrics.time("google_resolution_ms", Date.now() - started);
      }
    });
    cache.set(key, result);
    const settled = await result;
    if (settled.status === "error") cache.delete(key); // une panne passagère pourra être réessayée
    return settled;
  }

  // Informations pratiques d'un lieu (pour répondre aux questions de l'utilisateur), demandées
  // seulement quand le modèle en a besoin et gardées 1 h en mémoire
  const details = new Map(); // placeId → { at, value: Promise }
  const PRICE_LEVELS = {
    PRICE_LEVEL_FREE: "gratuit", PRICE_LEVEL_INEXPENSIVE: "bon marché (€)", PRICE_LEVEL_MODERATE: "prix moyens (€€)",
    PRICE_LEVEL_EXPENSIVE: "cher (€€€)", PRICE_LEVEL_VERY_EXPENSIVE: "très cher (€€€€)",
  };

  async function fetchDetails(placeId) {
    const fields = [
      "rating", "userRatingCount", "priceLevel", "currentOpeningHours.openNow", "regularOpeningHours.weekdayDescriptions",
      "nationalPhoneNumber", "internationalPhoneNumber", "websiteUri", "editorialSummary", "formattedAddress", "businessStatus",
    ].join(",");
    const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=fr`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fields },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    metrics.count("google_place_details");
    if (!response.ok) throw new Error(`Place Details ${response.status}`);
    const p = await response.json();
    return {
      rating: p.rating ?? null,
      rating_count: p.userRatingCount ?? null,
      price: PRICE_LEVELS[p.priceLevel] || null,
      open_now: p.currentOpeningHours?.openNow ?? null,
      opening_hours: p.regularOpeningHours?.weekdayDescriptions || null,
      phone: p.internationalPhoneNumber || p.nationalPhoneNumber || null,
      website: p.websiteUri || null,
      google_summary: p.editorialSummary?.text || null,
      address: p.formattedAddress || null,
      ...(p.businessStatus && p.businessStatus !== "OPERATIONAL" ? { business_status: p.businessStatus } : {}),
    };
  }

  function getDetails(placeId) {
    const hit = details.get(placeId);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.value;
    const value = fetchDetails(placeId).catch((err) => {
      details.delete(placeId);
      throw err;
    });
    details.set(placeId, { at: Date.now(), value });
    return value;
  }

  // Distances et temps de marche réels (Routes API, matrice à pied) entre des points { lat, lng } :
  // un élément par paire (origine, destination), ou null si Google ne trouve pas de chemin
  async function walkMatrix(origins, destinations) {
    const waypoint = (p) => ({ waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } });
    const response = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,distanceMeters,duration,condition",
      },
      body: JSON.stringify({ origins: origins.map(waypoint), destinations: destinations.map(waypoint), travelMode: "WALK" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    metrics.count("google_route_matrix");
    if (!response.ok) throw new Error(`Route Matrix ${response.status}`);
    const elements = await response.json();
    const grid = origins.map(() => destinations.map(() => null));
    for (const e of Array.isArray(elements) ? elements : []) {
      if (e.condition !== "ROUTE_EXISTS" || !Number.isInteger(e.originIndex ?? 0)) continue;
      grid[e.originIndex ?? 0][e.destinationIndex ?? 0] = { meters: e.distanceMeters ?? 0, seconds: parseInt(e.duration, 10) || 0 };
    }
    return grid;
  }

  resolve.searchNear = searchNear;
  resolve.locate = locate;
  resolve.getDetails = getDetails;
  resolve.walkMatrix = walkMatrix;
  resolve.reverseAddress = (position) => reverseAddress(apiKey, position);
  return resolve;
}

// Direction d'un point vu depuis un autre, en toutes lettres (« au sud »)
const DIRECTIONS = ["au nord", "au nord-est", "à l'est", "au sud-est", "au sud", "au sud-ouest", "à l'ouest", "au nord-ouest"];
function direction(from, to) {
  const rad = (d) => (d * Math.PI) / 180;
  const y = Math.sin(rad(to.lng - from.lng)) * Math.cos(rad(to.lat));
  const x = Math.cos(rad(from.lat)) * Math.sin(rad(to.lat)) - Math.sin(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.cos(rad(to.lng - from.lng));
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return DIRECTIONS[Math.round(bearing / 45) % 8];
}

// Adresse approximative d'une position (« 12 Kedem St, Tel Aviv »), pour le point de retour
async function reverseAddress(apiKey, position) {
  const params = new URLSearchParams({
    latlng: `${position.lat},${position.lng}`, language: "fr", result_type: "street_address|premise|route", key: apiKey,
  });
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await response.json();
    const address = data.results?.[0]?.formatted_address || null;
    return address ? address.split(",").slice(0, 2).join(",").trim() : null; // rue et ville, sans le pays
  } catch {
    return null;
  }
}

// Ville / quartier de l'utilisateur à partir de sa position (Geocoding inverse), pour le contexte
export async function reverseGeocode(apiKey, position) {
  const params = new URLSearchParams({
    latlng: `${position.lat},${position.lng}`,
    language: "fr",
    result_type: "neighborhood|sublocality|locality",
    key: apiKey,
  });
  try {
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const data = await response.json();
    const components = data.results?.flatMap((r) => r.address_components) || [];
    const pick = (type) => components.find((c) => c.types.includes(type))?.long_name || null;
    return {
      neighborhood: pick("neighborhood") || pick("sublocality"),
      city: pick("locality"),
      country: pick("country"),
      countryCode: components.find((c) => c.types.includes("country"))?.short_name || null, // « GR » (drapeau)
    };
  } catch {
    return null;
  }
}
