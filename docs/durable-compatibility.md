# Durable runtime — matrice de compatibilité (ticket #15, Plan 0002 §6)

Date : 2026-10-11. S'applique au seam durable intégré (`src/runtime.ts` → `src/durable/`), SDK Pi Durable pinné `1.1.0` (avec `pi-ai`/`chord` 1.1.0), Node ≥ 22.19.

Règle directrice (Plan 0002 §4) : **tant qu'une capacité n'est pas classée et testée, elle est indisponible pour les missions durables**. L'admission échoue fermé (`DurableAdmissionError`, HTTP 403 à la création) plutôt que d'élargir silencieusement l'accès ou de laisser tomber des outils en silence.

## Profils supportés par ce seam

| Capacité | Statut | Preuve |
| --- | --- | --- |
| Génération avec fournisseur du catalogue pi-ai (clés détenues par le contrôleur ; `builtinModels()`) | **SUPPORTÉ** | Runtime serveur + tests faux provider (`test/durable-runtime.test.ts`) |
| Reprise après SIGKILL mid-generation (checkpoint, partiel commité → reprise, identités d'entrées uniques) | **SUPPORTÉ / prouvé** | `test/durable-sigkill.test.ts` (driver subprocess, SIGKILL réel) |
| Outil d'édition rejoué de façon sûre (`replay: "safe"`, réconciliation before/after, résultat autoritatif exigé) | **SUPPORTÉ / prouvé** | scénario `edit` de la matrice SIGKILL |
| Classification et arrêt d'un worker orphelin vivant (identité persistée avant dispatch, disposition durable, aucune fuite) | **SUPPORTÉ / prouvé** | scénario `worker` de la matrice SIGKILL |
| requestId stable et borné (1–128, `[A-Za-z0-9._-]`), accusé après acceptation durable, POST dupliqué sans duplication | **SUPPORTÉ / prouvé** | runtime + tests serveur (même `submissionId`, une seule entrée utilisateur) |
| Bail d'exécution OS (SQLite `locking_mode=EXCLUSIVE`), second processus refusé, libération par mort du détenteur | **SUPPORTÉ / prouvé** | `test/durable-core.test.ts` |
| Stockage SQLite `synchronous=FULL`, profil de mission gelé (preset/toolchain/extensions/SDK), preflight fail-closed | **SUPPORTÉ / prouvé** | `test/durable-core.test.ts` |
| Runtime classic (processus pi du pool, JSONL I5) | **INCHANGÉ** | suite existante 186/186, garde `makeSpawner.ensure` |

## Non supporté (fail closed)

| Capacité | Statut | Comportement |
| --- | --- | --- |
| Extensions Durable au-delà de celles explicitement approuvées (`COGITATOR_DURABLE_APPROVED_EXTENSIONS`) | **NON SUPPORTÉ** | Registre vide par défaut ; une mission gelée dont l'extension disparaît rejette l'ouverture (preflight) |
| Serveurs MCP (`spawn.mcpServers`) hors allowlist (`COGITATOR_DURABLE_APPROVED_MCPS`) | **NON SUPPORTÉ** | 403 à la création, aucun stockage créé, aucun travail caché |
| Commandes/toolchain hors registre classé (`COGITATOR_DURABLE_APPROVED_COMMANDS`) | **NON SUPPORTÉ** | Classification P2 (`UnclassifiedCapabilityError`) |
| Presets classiques (Majordome, Chef de Projet, Architecte) importés tels quels en durable | **NON SUPPORTÉ** | Leurs dépendances (mutations admin, board/GitHub writes, hooks, imports) n'ont pas d'adaptateur durable ; ils restent disponibles en classic local |
| herdr / sous-agents | **NON SUPPORTÉ** | Aucun adaptateur ; une conversation Durable n'est jamais étiquetée herdr |
| Basule de modèle à chaud (`POST /:id/model`) sur une mission durable | **REFUSÉ** | 409 : le modèle est figé par mission (O6) ; créer une nouvelle conversation |
| Résolution/réouverture/renouvellement des attentions, rejeu automatique des effets incertains | **NON SUPPORTÉ dans #45** | GET mission et mission_state exposent les cas structurés ; une nouvelle autorisation ne réconcilie aucun ancien effet. Aucune API de résolution ni nouvel écran |

## Gestion et limites assumées

- Le retry implicite du SDK est désactivé sur ce seam (`retry.enabled: false`) en attendant la politique de retry budgétée (Plan 0002 §1) ; la compaction est également désactivée faute de politique de mission.
- Le bail est détenu par processus contrôleur unique ; deux instances du service sur le même `COGITATOR_HOME` refusent l'ouverture (une seule planifie, D3).
- Les fournisseurs disponibles sont ceux du catalogue pi-ai dont le contrôleur détient les clés ; les workers n'ont aucune clé (frontière P2 inchangée).
- Ce document ne couvre pas l'isolation rootless de production (P2 livré comme spec/confinement) ni les preuves déployées P3–P5.

## Tranche #45 — attention durable

Les cas `effect_outcome_unknown` et `action_denied` sont dérivés des documents
autoritatifs et bloquent reprise/drain/nouveaux effets protégés. Les intents
interrompus sont classés avant reprise SDK, les intents sains en vol ne sont
pas modifiés par une lecture. Le refus survit aux messages et aux redémarrages.
Voir le [contrat API](architecture/api-contract.md#durable-recovery-attention-bounded-45-increment).

Les preuves locales utilisent un faux provider et un compteur externe simulé :
elles ne certifient aucun connecteur externe réel. Les outils edit/worker de la
matrice historique sont des fixtures ; la ligne worker ci-dessus ne prouve ni
une identité worker robuste ni un backend utilisateur récupérable. Le registre
serveur reste vide par défaut. Les routes d’approbation et le panneau existent
déjà ; cette tranche enrichit uniquement leur contrat de statut, sans test UI.
#17 demeure partiel ; aucune certification production ou Docker n’en découle.
