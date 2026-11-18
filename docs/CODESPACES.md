# NEXORA dans GitHub Codespaces — développer et prévisualiser sans Netlify

NEXORA est une application Vite statique (React + TypeScript), sans backend : les données
vivent dans IndexedDB, **dans le navigateur, pour l’origine (l’URL) de la page**. Aucune
variable d’environnement ni aucun secret n’est nécessaire pour la lancer.

Le backend Supabase (schéma, RLS, `apply_changeset`) est **préparé mais non connecté** à
l’application : il sert uniquement aux qualifications décrites au § 8, qui sont distinctes
du fonctionnement de l’application (§ 1 à § 7).

## 1. Ouvrir le Codespace

1. Sur GitHub : **Code → Codespaces → Create codespace on `<branche>`**.
2. Le conteneur `.devcontainer/devcontainer.json` (Node 22, comme Netlify) est construit,
   puis `npm ci` installe exactement les versions du `package-lock.json`.
3. Ce guide s’ouvre automatiquement.

> Le Codespace contient ce qui est **sur GitHub**. Des commits qui ne sont que locaux
> (non poussés) n’y apparaissent pas.

## 2. Commandes

| Besoin | Commande |
|---|---|
| Serveur de développement (rechargement à chaud) | `npm run dev:host` (équivaut à `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`) |
| Typecheck | `npm run typecheck` |
| Tests unitaires | `npm test` |
| Build de production | `npm run build` |
| Prévisualiser le build de production | `npm run build && npm run preview:host` (port 4173) |
| Tout vérifier d’un coup | `npm run check` (typecheck + tests + build) |
| Tests de bout en bout (facultatif) | voir § 5 |

## 3. Obtenir le lien de prévisualisation

1. Lancer `npm run dev:host` dans le terminal du Codespace.
2. Le port **5173** est redirigé automatiquement et le navigateur s’ouvre ; sinon : onglet
   **Ports** → ligne « NEXORA — serveur de développement » → icône globe.
3. L’adresse a la forme `https://<nom-du-codespace>-5173.app.github.dev/#/`.

Le port est **privé par défaut** : seul votre compte GitHub peut ouvrir ce lien. Ne le
passez pas en « Public ».

Le build de production se prévisualise de la même façon sur le port **4173**
(`https://<nom-du-codespace>-4173.app.github.dev/#/`).

## 4. Données : séparation stricte avec la production

* L’adresse `*.app.github.dev` est une **origine différente** de la production : son
  IndexedDB est vide et indépendante. Vos données réelles (Edge, site de production) ne sont
  ni lues, ni modifiées.
* Pour tester : à l’accueil, choisir **« Explorer avec des données de démonstration »**
  (données fictives).
* N’importez pas de sauvegarde contenant des données réelles dans un Codespace.
* Ne créez pas de fichier `.env` avec des secrets : `.env` et `.env.local` sont ignorés par
  Git, mais l’application n’en a de toute façon pas besoin.

## 5. Tests de bout en bout (facultatif)

Playwright n’est pas une dépendance du projet. Dans le Codespace :

```bash
npm install --no-save playwright
npx playwright install --with-deps chromium
npm run build && (npm run preview:host &) && sleep 3
BASE_URL=http://localhost:4173 npm run test:e2e
```

## 6. Arrêter et reprendre sans perdre le travail

* **Arrêter** : Codespaces → `…` → **Stop codespace** (ou arrêt automatique après inactivité).
  Les fichiers, `node_modules` et les modifications non commitées sont **conservés**.
* **Reprendre** : Codespaces → ouvrir le même Codespace, puis relancer `npm run dev:host`
  (le serveur ne redémarre pas seul). `npm ci` n’est pas rejoué.
* **Ne jamais perdre le travail** : commiter régulièrement ; un Codespace **supprimé** (ou
  supprimé automatiquement après une longue inactivité, 30 jours par défaut) perd tout ce
  qui n’a pas été poussé sur GitHub.
* Après une modification de `package.json` : `npm ci` à la main.

## 7. Netlify

`netlify.toml` est conservé tel quel pour l’hébergement de production actuel. Le
développement et la prévisualisation n’en dépendent plus. Attention : tant que Netlify est
relié au dépôt, **un push sur la branche de production déclenche un build Netlify** ; pour
l’éviter, mettre les builds en pause dans Netlify (*Site configuration → Build & deploy →
Continuous deployment → Stop builds*) avant de pousser.

## 8. Qualification du backend Supabase (indépendante de l’application)

Ces opérations ne concernent pas l’application : elles vérifient le schéma Supabase, la RLS et
le protocole d’écriture. Elles n’utilisent que des données fictives (`@example.test`).

| Besoin | Commande | Prérequis |
|---|---|---|
| Qualification sur la **pile Supabase locale** (SQL + HTTP, deux utilisateurs réels) | `bash scripts/qualify-supabase.sh local` | Docker (fonctionnalité `docker-in-docker` du conteneur), Node 22, réseau vers le registre d’images |
| Contrôle des preuves (secrets, cohérence, complétude) | `node scripts/check-qualification-evidence.mjs docs/qualification lot4-local` | Node 22 |
| Tests du contrôleur de preuves | `node --test scripts/check-qualification-evidence.test.mjs` | Node 22 |
| Suites SQL sur PostgreSQL éphémère | `npm run test:db` | binaires **serveur** PostgreSQL 16 (`PG_BIN`, défaut `/usr/lib/postgresql/16/bin`) |
| Contrôles de sécurité par mutation | `node scripts/security-mutations/run.mjs` | idem `npm run test:db` |

À savoir :

* **Pile Supabase locale** : le script démarre la pile du CLI Supabase (version épinglée),
  applique toutes les migrations, exécute les suites, écrit le rapport puis **détruit** la pile
  et ses volumes, même en cas d’échec. Il refuse toute autre cible que la pile locale ; le mode
  hébergé est désactivé.
* **Preuves** : le script écrit `docs/qualification/<préfixe>-report.md`, `-sql.json`,
  `-http.json` (préfixe `EVIDENCE`, défaut `lot4-local`). Ces fichiers **remplacent** les preuves
  du même préfixe : en copier une sauvegarde avant de relancer, ou utiliser un autre préfixe.
  Le préfixe `3b-local` est refusé (preuves historiques). Le rapport indique l’environnement,
  le commit testé et l’empreinte des migrations.
* **Registre d’images** : si le registre par défaut du CLI n’est pas joignable, définir
  `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io` (le rapport le consigne).
* **PostgreSQL 16** : vérifier `ls /usr/lib/postgresql/` ; s’il est absent, installer les
  binaires serveur PostgreSQL 16 (dépôt PGDG) avant `npm run test:db` ou les mutations.
* **Secrets** : aucun pour la pile locale (ses clés sont des valeurs locales par défaut, non
  secrètes, masquées dans les rapports). La qualification du projet hébergé **NEXORA-DEV**
  utilise les secrets Codespaces `SUPABASE_ANON_KEY` et `SUPABASE_DB_PASSWORD` ; ses accès ne
  doivent jamais être placés dans le dépôt ni dans un fichier `.env` versionné. Un secret
  ajouté n’est injecté qu’au prochain démarrage du Codespace.
* **Fichiers temporaires** : `/tmp` (dont le dossier temporaire de Claude Code) est effacé aux
  redémarrages du Codespace. Les éléments de qualification hébergée à conserver (certificat
  racine Supabase, blocs d’exécution) sont rangés **hors du dépôt**, dans `/workspaces/nexora-n2/`
  (droits `700`).
* **Accès SSH** : le conteneur inclut la fonctionnalité `sshd` (connexion SSH au Codespace, par
  exemple `gh codespace ssh`). Sa version n’est pas encore épinglée (`latest`) ; l’épinglage est
  prévu après vérification de compatibilité.
