# Artifacts

Agents publish deliverables with the `cogitator_artifact` tool; you find them in **Artifacts** (rail), in the thread panel and as cards in the chat.

## Publishing (agents)

```json
{ "title": "Tableau de bord SEO", "path": "out/dashboard.html" }
{ "title": "Rapport", "content": "# Rapport…", "filename": "rapport.md", "note": "ajout des chiffres" }
```

- `path` is relative to the conversation's working directory; or give `content` (text) with a `filename`.
- Supported: `.html` `.md` `.svg` `.png` `.jpg` `.gif` `.webp` `.csv` `.json` `.txt` `.pdf`, 10 MB per version, 50 versions per artifact.
- Same title in the same conversation, or `id`, adds a version. Another conversation cannot add versions to it.
- HTML should be self-contained (inline CSS/JS). External resources load only if the page itself fetches them.

## Viewing

The gallery lists every artifact with its type, versions and agent. The viewer renders pages in a frame, Markdown as a document, CSV as a table, images and text as is; PDFs open in a tab or download. You can pick a version, open it in a tab, download, rename or delete it, and jump back to its thread.

## Security

- Files live in `~/.cogitator/artifacts/` (folder 0700, files 0600).
- Content is served by `/api/artifacts/:id/raw` with `Content-Security-Policy: sandbox …` (no `allow-same-origin`), `X-Content-Type-Options: nosniff` and `frame-ancestors 'self'`. The UI also uses a sandboxed iframe. A published page therefore runs in an opaque origin: it cannot read cookies, the parent page or call the Cogitator API.
- Publishing goes through the agent's private owner socket (`/api/artifacts/agent`); listing, reading and managing are owner-only and refused to agent sockets and MCP dispatch.
