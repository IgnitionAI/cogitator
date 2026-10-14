# Guardian Checklist — validating a Cogitator implementation

1. ☐ The server starts and responds to `GET /api/health` with the detected `pi_version`
2. ☐ Spawn a conversation with a preset: materialized flags conform to the contract (frozen snapshot, `--no-skills` + `--skill`, `--append-system-prompt`)
3. ☐ The preset's MCP servers are connected via `registerMcpServer` (visible in the session's `/mcp`)
4. ☐ No file written to a workspace by cogitator (I2)
5. ☐ Apply a preset: herdr `.md` files generated under `noo-*`; removing a subagent → `.md` deleted; non-`noo-*` files intact (O1, O2)
6. ☐ Provider write: valid `models.json`/`auth.json` after writing, `.bak` present (I1)
7. ☐ Cron: manual trigger → run created, busy-guard effective, result appended to the dedicated session, `CronRun` recorded (O3)
8. ☐ Idle recycling: 10 min without activity → pi process stopped, transparent respawn on the next message
9. ☐ Standalone conversation (no workspace) works with an ad hoc provider/model
10. ☐ Bind to `127.0.0.1` only (O4)
11. ☐ 1–1 resume-last: `GET /api/conversations?agent_id=` omits `group_id` rows; click bot reopens last jsonl (ADR-010)
12. ☐ Spawn without workspace_id uses preset `default_workspace_id`; deleted workspace → null → 400 + picker (O9)
13. ☐ Group of 2–6: one bus SSE; no `@` → only host process receives the user line; `@slug` → only that member (O8)
14. ☐ Group does not write a shared pi jsonl; each member has its own `session_file` (I5/I8)
