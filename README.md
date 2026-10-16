# Que fait-on ?

Prototype d'application touristique mobile (Réthymnon, Crète) : carte Google des lieux à visiter, liste des étapes, itinéraire à pied optimisé, bouton « Next » pour partir dans la bonne direction, et guide vocal qui propose des lieux au fil de la conversation.

## Lancer

```
npm install
cp .env.example .env   # puis renseigner les clés
npm start              # http://localhost:8000
```

Node.js 22.6 ou plus récent. Le micro demande une page servie en `localhost` ou en HTTPS.

## Organisation

- `index.html` : la page (carte, liste, itinéraire, conversation vocale en WebRTC).
- `server.mjs` : serveur HTTP ; garde les clés, crée les sessions vocales, pousse la liste des lieux à la page (flux SSE).
- `agent/live.mjs` : session GPT-Live, suivi « sideband », exécution des fonctions du guide.
- `agent/prompts.mjs` : consignes et outils du guide vocal (GPT-Live) et du modèle de calcul (Responses, `gpt-6-luna`).
- `agent/store.mjs` : liste des lieux, préférences et contexte (en mémoire), validation des modifications.
- `agent/places.mjs` : localisation des lieux dans Google Places (Text Search).
- `agent/metrics.mjs` : délais et coût estimé de chaque session.
- `dev/` : tests sans micro (`QFO_DEV=1 npm start`, puis `node dev/scenario.mjs <journal du serveur> '["demande 1", "demande 2"]' reset`).

## Clés

Les clés restent dans `.env` (non publié). La clé Google est transmise à la page au chargement, car l'affichage de la carte en a besoin : la restreindre au domaine de l'application et aux API utilisées dans la console Google Cloud.
