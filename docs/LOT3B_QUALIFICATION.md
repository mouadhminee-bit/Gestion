# NEXORA — étape 3b-3 : qualification dans GitHub Codespaces (mode opératoire)

À exécuter **par vous**, dans un Codespace de la branche `claude/stoic-edison-8s0vhq`.
La qualification utilise la pile Supabase **locale** complète, lancée dans le Codespace et
détruite à la fin. Aucun projet Supabase, aucun compte Supabase, aucune connexion distante,
aucune donnée réelle : uniquement des comptes et des lignes fictifs (`@example.test`).

## 1. Ressources et coûts

| Élément | Valeur |
|---|---|
| Machine | **4 cœurs / 16 Go** recommandée ; 2 cœurs / 8 Go suffit en principe (la pile Supabase utilise ~3 à 4 Go) |
| Disque | ~4 à 5 Go d'images Docker Supabase (téléchargées au premier lancement) |
| Durée | 1er lancement : 10 à 20 min (téléchargement des images) ; ensuite 5 à 10 min |
| Coût | 0 dans le quota gratuit mensuel de Codespaces des comptes personnels (environ 1 à 2 heures-cœur sur une machine 4 cœurs). Le Codespace consomme aussi du stockage tant qu'il existe : le supprimer après usage (§ 6) |
| Limites | Quota restant visible dans GitHub → Settings → Billing and plans → Codespaces. Un Codespace inactif s'arrête seul (30 min par défaut) |

## 2. Créer le Codespace

1. GitHub → dépôt `mouadhminee-bit/Gestion` → **Code** → onglet **Codespaces** → **⋯** →
   **New with options**.
2. Branche : **`claude/stoic-edison-8s0vhq`** ; type de machine : **4-core**.
3. Attendre la fin de `npm ci` (lancé automatiquement).

La configuration du conteneur (`.devcontainer/devcontainer.json`) est celle de `nexora-dev`,
inchangée (Node 22, `npm ci`, ports 5173/4173, scripts `dev:host`, `preview:host`, `check`),
avec **un seul ajout** : la fonctionnalité Docker-in-Docker. Un Codespace créé avant cet ajout
doit être reconstruit (palette de commandes → *Codespaces: Rebuild Container*) ou recréé.

## 3. Commande unique

Dans le terminal du Codespace :

```bash
npm run qualify:supabase
```

(équivaut à `bash scripts/qualify-supabase.sh local`). Code de sortie 0 = aucun écart.

## 4. Fonctionnement de l'orchestration

| Étape | Action | Garde-fous |
|---|---|---|
| 1. Contrôles | Docker opérationnel, Node ≥ 22, `project_id = "nexora"` | **Refus** si le dépôt est lié à un projet hébergé (`supabase/.temp/project-ref`) ; les variables `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_URL`… sont **effacées** pour l'exécution ; mode `hosted` **refusé** |
| 2. Démarrage | `npx supabase@2.122.0 start` : PostgreSQL 17 Supabase, GoTrue (Auth), PostgREST, Kong, postgres-meta, Storage… (Studio, Realtime, Edge Runtime, imgproxy, Logflare, Vector exclus) ; les **6 migrations** sont appliquées par le CLI | **Refus** si l'API n'est pas `http://127.0.0.1:54321`, si la base n'est pas `postgresql://postgres:postgres@127.0.0.1:54322/postgres`, si le conteneur n'est pas étiqueté projet `nexora`, si `auth.users` contient un compte non fictif, si les migrations appliquées diffèrent des 6 fichiers |
| 3. SQL | Outillage de test, puis `01…08` et `platform/P1_supabase_platform.sql` exécutés **dans** le conteneur de la base (`docker exec … psql`) ; rôle administrateur des tests choisi selon Q1 (`postgres` s'il contourne la RLS, sinon `service_role`) | sessions concurrentes `dblink` sur la base locale du conteneur uniquement |
| 4. HTTP | `supabase/db-tests/http/rls.mjs` : **deux utilisateurs inscrits via GoTrue**, jetons JWT réels, appels PostgREST (isolation par table, suppression physique, transfert de propriété, insertion au nom d'autrui, upsert, références croisées, contraintes différées, métadonnées serveur, `anon`, fonctions privées, jeton falsifié, GraphQL) | **Refus** de toute URL autre que `http://127.0.0.1:54321` ; uniquement la clé `anon` locale |
| 5. Rapport | Comparaison assertion par assertion avec `supabase/db-tests/baseline/pg16.json` ; rapport dans `docs/qualification/` | jetons et clés **masqués** dans les fichiers écrits |
| 6. Destruction | `supabase stop --no-backup` (conteneurs **et** volumes de données supprimés), y compris en cas d'échec ou d'interruption ; vérification qu'il ne reste aucun conteneur ni volume du projet | `KEEP_STACK=1` conserve la pile pour diagnostic (à arrêter ensuite, § 6) |

Questions tranchées par la qualification (`docs/LOT3B_PLAN.md` § 6) : Q1 rôle `postgres` et
RLS forcée · Q2 déclencheur sur `auth.users` · Q3 création directe d'utilisateurs ·
Q4 `dblink` · Q5 privilèges par défaut, GraphQL, RPC · Q6 erreurs différées via PostgREST.

## 5. Me transmettre les résultats

Le script écrit trois fichiers sans secret :

* `docs/qualification/3b-local-report.md` — synthèse (versions, composants, comparaison,
  constats Q1–Q5, journal HTTP) ;
* `docs/qualification/3b-local-sql.json` — résultats SQL bruts ;
* `docs/qualification/3b-local-http.json` — résultats HTTP bruts.

Les commiter et les pousser **sur cette branche uniquement** :

```bash
git add docs/qualification/3b-local-report.md docs/qualification/3b-local-sql.json docs/qualification/3b-local-http.json
```

```bash
git commit -m "test(3b): qualification results on local Supabase stack"
```

```bash
git push origin claude/stoic-edison-8s0vhq
```

En cas d'échec du script, poussez quand même ces fichiers s'ils existent, et copiez la fin
du terminal (sans aucune clé) dans votre message.

## 6. Destruction de l'environnement

1. Automatique : le script arrête la pile et supprime ses volumes (`supabase stop --no-backup`).
2. Vérification (les deux commandes doivent ne rien afficher) :

```bash
docker ps -a --filter label=com.supabase.cli.project=nexora -q
```

```bash
docker volume ls --filter label=com.supabase.cli.project=nexora -q
```

3. Si quelque chose subsiste (interruption brutale, `KEEP_STACK=1`) :

```bash
npx --yes supabase@2.122.0 stop --no-backup
```

4. Libérer l'espace des images (facultatif) :

```bash
docker image prune -a -f
```

5. Supprimer le Codespace : GitHub → Codespaces → **⋯** → **Delete**. Tout le contenu du
   conteneur (images, journaux, fichiers non poussés) disparaît.

## 7. Ce que l'étape ne fait pas

Pas de projet Supabase hébergé (3b-4 reporté), pas de connexion distante, pas d'accès à la
base IndexedDB `nexora` ni aux données réelles, pas d'authentification ni d'écriture cloud
dans l'application, pas d'`apply_changeset`, aucun changement sur `nexora-dev`, la
production ou Netlify. `npm run dev:host`, `preview:host` et `check` restent inchangés.
