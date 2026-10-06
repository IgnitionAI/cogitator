# Stack Decision Record — Cogitator

| Couche | Choix | Justification | Alternatives rejetées |
|---|---|---|---|
| Langage | TypeScript | RpcClient pi officiel en TS, team de 1 | Python (glue), Go (itération plus lente) |
| Serveur | Node ≥22, HTTP natif | Runtime = celui de l'extension pi | Hono/Express (pas nécessaires), FastAPI |
| UI | React + Vite, build statique | Écosystème, vitesse | HTMX (moins riche pour l'éditeur d'agents) |
| Temps réel | SSE | Flux serveur→client, éprouvé | WebSocket (surdimensionné) |
| Persistance | SQLite (`better-sqlite3`) `~/.cogitator/cogitator.db` | Requêtes historique, un seul fichier | JSON multi-fichiers |
| Process pi | `RpcClient` officiel, pool 1/session, idle-recycle 10 min, max 8 | Modèle éprouvé | Shell `pi -p` (pas de streaming ni contrôle fin) |
| Config pi | Read model depuis `models-store.json`/`auth.json`/`mcp.json` + écritures atomiques avec backup | Une seule source de vérité | Dupliquer la config dans le store |
| Subagents | Génération `.md` herdr (`~/.pi/agents/noo-*.md`) | Moteur existant, cohérence CLI/UI | Moteur maison |
| Cron | In-process, busy-guard | Historique natif, notifications UI | launchd (sorties hors UI) |
| Packaging | pi package `@ignitionai/cogitator` + bin standalone | Cible = écosystème pi | Electron (lourd, inutile) |
