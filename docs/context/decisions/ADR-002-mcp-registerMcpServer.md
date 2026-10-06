# ADR-002 — MCP via registerMcpServer (support builtin), pas pi-mcp-adapter

- Statut : accepté
- Date : 2026-10-06

## Contexte

Les presets d'agents portent une liste de serveurs MCP. Deux mécanismes possibles chez l'utilisateur cible : le support MCP **builtin** de pi (`mcp.json` + API `pi.registerMcpServer()`), ou l'extension `pi-mcp-adapter` (qui *remplace* le builtin et fournit `--mcp-config`). L'utilisateur cible a pi-mcp-adapter installé.

## Décision

Cogitator utilise l'**API builtin** `pi.registerMcpServer(name, config)` au `session_start` de chaque session qu'il spawne, avec les entrées du preset (shape `mcpServers`). Le serveur MCP user-level (`~/.pi/agent/mcp.json`) reste géré par un écran de config dédié.

## Conséquences

+ Pas de dépendance à l'installation de pi-mcp-adapter ; shape officielle et stable
+ MCP par-agent exact, pas de fuite entre presets
− Si l'utilisateur garde pi-mcp-adapter, celui-ci remplace le builtin : la combinaison devra être détectée au démarrage et signalée dans l'UI (health check)

## Alternatives rejetées

- `--mcp-config <fichier généré>` (flag de pi-mcp-adapter) → couple cogitator à une extension tierce non requise
