# Recette P2 avec daemon Docker distant

Le harnais garde son défaut Docker local sans configuration. Pour un contrôleur
conteneurisé, fournir ensemble deux chemins absolus vers le même stockage :
`COGITATOR_TEST_CONTROLLER_ROOT` (dossier existant, canonicalisé côté contrôleur)
et `COGITATOR_TEST_DAEMON_ROOT` (chemin correspondant côté daemon, sans realpath
côté contrôleur). Seul le workspace exact de la fixture est monté.

Recette pour le volume partagé de ce worktree, via le proxy Docker existant :

```sh
mkdir -p /data/work/wt-cog43/.docker-fixtures
export COGITATOR_TEST_CONTROLLER_ROOT=/data/work/wt-cog43/.docker-fixtures
export COGITATOR_TEST_DAEMON_ROOT=/var/lib/docker/volumes/openbot-host_openbot-data/_data/work/wt-cog43/.docker-fixtures
node --import tsx --test test/docker-fixture-paths.test.ts
node --import tsx --test test/execution-container.test.ts
npm run build
npm test
```

Une configuration partielle ou relative échoue. Avec les racines configurées,
Docker ou l'image indisponibles échouent aussi, sans skip. La sentinelle unique
lue par le worker et son écriture relue par le contrôleur prouvent le partage ;
une mauvaise correspondance échoue explicitement. Le test nettoie uniquement
ses dossiers `mkdtemp`, sans supprimer les anciens dossiers côté daemon.

Les assertions de confinement restent requises : UID 65534, rootfs en lecture
seule, réseau désactivé, capabilities retirées et no-new-privileges. Cette recette
ne démontre ni Docker local natif ni un daemon rootless de production.
