# Audit CI / workflows — enrôlement de dépôts et escalade de privilège PR

Ticket : [#14](https://github.com/IgnitionAI/cogitator/issues/14) (Plan 0002 §8 P2, ADR-008, Skeptic S2).
Statut : audit initial au 2026-10-10 — aucune automation PR autonome n'est activée.

## Constat actuel

Le dépôt ne contient **aucun workflow GitHub Actions** (`/.github/workflows` n'existe pas).
Conséquences immédiates :

- Aucun chemin `pull_request_target`, aucun workflow réutilisable (`workflow_call`), aucun chaînage de workflows n'existe aujourd'hui.
- Aucun secret CI n'est exposé à du code de PR.
- Aucune création autonome de PR par un agent n'est possible : les missions ne reçoivent pas de token GitHub généraliste (Plan 0002 §4 : les credentials externes restent dans la passerelle de confiance, scoped à l'action exacte).

Commande de vérification reproductible :

```sh
ls .github/workflows 2>/dev/null || echo "aucun workflow"
grep -Rn "pull_request_target\|workflow_call\|secrets\." .github/workflows 2>/dev/null || echo "aucun chemin d'escalade"
```

## Règles d'enrôlement d'un dépôt (Skeptic S2)

Avant d'enrôler un dépôt pour des missions distantes (création de branches, PR,
CI déclenchée par du code agent), l'audit suivant est obligatoire et documenté
par dépôt. Un point non conforme = enrôlement refusé, et **aucune création
autonome de PR tant que des chemins d'escalade existent**.

| # | Contrôle | Exigence |
| --- | --- | --- |
| A1 | `pull_request_target` | Interdit pour exécuter du code de la PR (checkout de la tête de PR + secrets). Présence = blocage. |
| A2 | Workflows réutilisables (`workflow_call`) | Caller et called doivent être audités ensemble ; un called modifiable par la PR ne peut pas porter de secrets. |
| A3 | Chaînage (`workflow_run`, déclencheurs croisés) | La chaîne complète est auditée : un workflow de confiance ne doit jamais exécuter des artefacts d'un workflow non fiable. |
| A4 | Secrets sur événements PR | `pull_request` (fork) : aucun secret. Aucun secret de production disponible dans un contexte influençable par la PR. |
| A5 | Jetons | Pas de `GITHUB_TOKEN` en écriture large ni persistant ; `permissions:` minimal par job ; pas de PAT dans les secrets du dépôt enrôlé. |
| A6 | Runners | Pas de runner self-hosted privilégié pour du code de PR ; pas de conteneur privilégié. |
| A7 | Protections de branches | `main`/releases protégées (revue, CI requise) ; preuve par un push dénié, pas par la documentation seule. |
| A8 | Publication de confiance | Les outils de publication n'exécutent aucun hook/filtre/credential-helper fourni par le worker (Skeptic S2, Plan 0002 §4). |
| A9 | Définitions CI en écriture | Le worker ne peut pas modifier les définitions de workflows ni les approvals du dépôt. |

## Politique d'automation PR

- Tant qu'un dépôt enrôlé présente un chemin A1–A9 non conforme : **pas de
  création autonome de PR** depuis une mission (l'outil d'effet externe GitHub
  reste désactivé pour ce dépôt).
- Les opérations GitHub/CI credentiaillées passent par des outils structurés
  allowlistés (Plan 0002 §4), jamais par un proxy HTTP générique authentifié.
- Le worker qui produit le code n'est jamais celui qui le publie : la
  publication utilise des credentials scoped (dépôt + action exacte) détenus
  par la passerelle de confiance.

## Limites

Cet audit couvre la configuration du dépôt Cogitator et les règles
d'enrôlement. Il ne remplace pas l'audit par dépôt enrôlé, ni la vérification
d'un push dénié sur la cible réelle (A7), qui restent des préalables à toute
mission distante produisant des PR.
