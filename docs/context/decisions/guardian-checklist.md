# Guardian Checklist — validation d'une implémentation Cogitator

1. ☐ Le serveur démarre et répond `GET /api/health` avec `pi_version` détectée
2. ☐ Spawn d'une conversation avec un preset : flags matérialisés conformes (snapshot figé, `--no-skills` + `--skill`, `--append-system-prompt`)
3. ☐ Les serveurs MCP du preset sont connectés via `registerMcpServer` (visibles dans `/mcp` de la session)
4. ☐ Aucun fichier écrit dans un workspace par cogitator (I2)
5. ☐ Apply d'un preset : `.md` herdr générés sous `noo-*` ; retrait d'un subagent → `.md` supprimé ; fichiers non-`noo-*` intacts (O1, O2)
6. ☐ Écriture provider : `models.json`/`auth.json` valides après écriture, `.bak` présent (I1)
7. ☐ Cron : fire manuel → run créé, busy-guard effectif, résultat append dans la session dédiée, `CronRun` tracé (O3)
8. ☐ Idle-recycle : 10 min sans activité → process pi stoppé, re-spawn transparent au message suivant
9. ☐ Conversation libre (sans workspace) fonctionnelle avec provider/modèle ad hoc
10. ☐ Binding `127.0.0.1` uniquement (O4)
