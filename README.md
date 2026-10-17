# Que fait-on ?

Prototype d'application touristique mobile (Réthymnon, Crète) : carte Google des lieux à visiter, liste des étapes, itinéraire à pied optimisé, bouton « Next » pour partir dans la bonne direction, et guide vocal qui propose des lieux au fil de la conversation.

## Lancer

```
npm install
cp .env.example .env   # puis renseigner les clés
npm start              # http://localhost:8000
```

Node.js 24 (base SQLite intégrée). Le micro demande une page servie en `localhost` ou en HTTPS.

## Organisation

- `index.html` : la page (carte, liste, itinéraire, conversation vocale en WebRTC).
- `server.mjs` : serveur HTTP ; garde les clés, gère les comptes, crée les sessions vocales, pousse à chaque compte sa liste de lieux et ses tâches (flux SSE).
- `agent/db.mjs` : comptes (pseudo + code PIN de 4 chiffres, inscription avec un code d'invitation à usage unique) et espaces enregistrés, dans SQLite.
- `agent/workspace.mjs` : espace de chaque compte (lieux, tâches, préférences, conversation), restauré depuis la base et enregistré à chaque changement.
- `agent/live.mjs` : session GPT-Live (délégation « par l'application »), suivi « sideband », fin des prises de parole, informations transmises au guide.
- `agent/tasks.mjs` : tableau des tâches — détection à chaque prise de parole, exécution par le modèle de calcul (3 en parallèle), arrêt et relance d'une tâche précisée.
- `agent/tools.mjs` : fonctions de l'appli appelées pendant une tâche (liste de lieux, repères, informations pratiques, distances à pied, bulle, préférences).
- `agent/briefing.mjs` : météo et événements de la semaine, pour les moments d'attente.
- `agent/prompts.mjs` : consignes et outils du guide vocal (GPT-Live), du détecteur de tâches et du modèle de calcul (Responses, `gpt-6-luna`).
- `agent/store.mjs` : liste des lieux, préférences et contexte d'un compte, validation des modifications. Seuls l'identifiant Google et des coordonnées datées (30 jours au plus) sont enregistrés, conformément aux règles de Google.
- `agent/places.mjs` : localisation des lieux dans Google Places (Text Search).
- `agent/metrics.mjs` : délais et coût estimé de chaque session.
- `dev/` : tests sans micro, avec `QFO_DEV=1 npm start` (le mode test accepte l'invitation « DEV » ; le script utilise le compte « testeur », PIN 0000) :
  `node dev/tasks-test.mjs '[[0,"phrase 1"],[5,"phrase 2"]]' 200 reset` envoie des prises de parole tapées à des instants donnés et affiche l'évolution des tâches et de la carte.
  `node --env-file=.env dev/practical-test.mjs "Colombie-Britannique/Canada,Crète/Grèce"` affiche la météo d'un point et les guides de conversation de ces régions (écran « Infos pratiques »).

## Clés et variables d'environnement

En local, dans `.env` (non publié, voir `.env.example`) ; sur Render, dans Environment.

| Variable | Obligatoire | Rôle |
|---|---|---|
| `OPENAI_API_KEY` | oui | Guide vocal (GPT-Live) et modèle de calcul |
| `GOOGLE_MAPS_API_KEY` | oui | Carte, photos, itinéraires, localisation des lieux |
| `INVITE_CODES` | oui | Codes d'invitation à usage unique, séparés par des virgules |
| `DB_PATH` | sur Render | Base des comptes : `/var/data/qfo.sqlite` sur le disque persistant (local : `data/qfo.sqlite`) |
| `GOOGLE_MAPS_BROWSER_KEY` | non | Clé distincte pour la page (sinon `GOOGLE_MAPS_API_KEY`) |
| `MAPBOX_TOKEN` | non | Jeton public Mapbox (`pk.…`, restreint aux adresses de l'appli) pour le globe de l'écran de départ |
| `MAX_SESSIONS_PER_HOUR` | non | Conversations vocales par heure (30 par défaut) |

Fournies par Render, à ne pas saisir : `PORT`, `RENDER`, `RENDER_EXTERNAL_URL`.

La clé Google est transmise à la page au chargement, car l'affichage de la carte en a besoin : la restreindre aux API utilisées dans la console Google Cloud.

## Déploiement sur Render

Web Service relié à ce dépôt : build `npm ci`, start `npm start`, health check `/healthz`. La version de Node est fixée par `.node-version`.

Un disque persistant (Disks → mount path `/var/data`, 1 Go) garde la base des comptes entre les déploiements, avec `DB_PATH=/var/data/qfo.sqlite`.
