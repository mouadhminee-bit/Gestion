# NEXORA dans GitHub Codespaces — développer et prévisualiser sans Netlify

NEXORA est une application Vite statique (React + TypeScript), sans backend : les données
vivent dans IndexedDB, **dans le navigateur, pour l’origine (l’URL) de la page**. Aucune
variable d’environnement ni aucun secret n’est nécessaire pour la lancer.

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
