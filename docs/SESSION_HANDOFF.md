# NEXORA — Synthèse de passation de session

État au 30/10/2026, commit `30cf76f` sur `claude/nexora-finance-platform-81blaa`
(local = distant, arbre propre au moment de la rédaction). Documents de référence :
[`README.md`](../README.md) et [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

Légende : ✅ confirmé (preuve : code, commit ou test exécuté) · 🟡 en cours / partiel ·
⏳ à faire · ❓ à vérifier.

---

## 1. Vision du produit

* **Objectif** : « Personal Finance OS » — piloter ses finances personnelles avec des
  indicateurs **calculés, vérifiables, jamais inventés** (chaque chiffre a une définition
  ou une source affichée).
* **Utilisateurs cibles** : particuliers, configuration par défaut **Maroc** (français,
  MAD/DH, `Africa/Casablanca`, JJ/MM/AAAA, semaine au lundi, mois civil), désormais
  multilingue (24 langues).
* **Proposition de valeur** : local-first (IndexedDB, aucune connexion bancaire, aucun
  serveur), calculs exacts en unités minimales, assistant déterministe sans IA externe,
  interface premium sombre/clair responsive.

## 2. État technique ✅

* **Stack** : React 18 + TypeScript strict + Vite 6, Tailwind 3, react-router-dom 6
  (**routage par hash** `#/...`), Recharts 2, Dexie 4 (IndexedDB), Radix (dialog,
  popover, tooltip), lucide-react, polices Inter / Space Grotesk / Noto Sans Arabic &
  Hebrew. Tests : Vitest 3 + fake-indexeddb ; e2e Playwright (`e2e/smoke.cjs`).
* **Structure** : `src/domain/` (règles pures : `money.ts`, `dates.ts`, `types.ts`,
  `validation.ts`, `csv.ts`, `duplicates.ts`, `assistant.ts`, `categories.seed.ts`,
  `settings.ts`, `calc/` = ledger, fx, budgets, goals, recurring, debts, networth,
  forecast, scenario, analytics, insights, notifications), `src/data/` (`db.ts` schéma
  Dexie versionné, `repository.ts` scopé par `userId`, `demo.ts` jeu déterministe),
  `src/i18n/`, `src/app/` (contexte, nav), `src/components/` (ui, layout, charts),
  `src/features/`, `src/pages/` (15 fichiers : 14 écrans + Onboarding), `supabase/schema.sql`.
* **Routes** : `/`, `/transactions`, `/budgets`, `/accounts`, `/goals`, `/recurring`,
  `/debts`, `/net-worth`, `/analytics`, `/report`, `/forecast`, `/assistant`,
  `/settings`, `/import`.
* **Moteur de calcul** : montants entiers (unités minimales), définitions communes à tous
  les écrans (revenus, dépenses nettes des remboursements, épargne nette, taux, budget
  disponible…). Transfert = 2 transactions liées par `transferId` (jamais revenu/dépense) ;
  dettes : seuls les intérêts comptent ; prévisionnel **calculé**, jamais stocké.
* **Modèle de données** : voir ARCHITECTURE § 4 (UserSettings, Account à solde initial
  daté, Category 1 niveau de sous-catégorie, Transaction 6 types, Budget, SavingsGoal,
  RecurringRule/Occurrence, Debt/DebtPayment, Asset/Valuation, ExchangeRate,
  NotificationState, ImportBatch). Archivage plutôt que suppression si historique.
* **Tests (dernier passage, commit `30cf76f`)** : `npm test` → **176 tests, 8 fichiers,
  tous verts** ; `tsc` OK ; `npm run build` OK. E2E français 11/11 vert (exécuté avant
  les 2 derniers commits, cf. § 8).

## 3. Fonctionnalités

* ✅ **Terminées** (table détaillée README « Fonctionnalités et état réel ») : dashboard
  (6 KPI, graphiques, insights), transactions (5 types de saisie, filtres, multi-sélection,
  export), catégories, comptes multidevises, budgets, objectifs, récurrences, dettes &
  créances, patrimoine, analyses & rapports imprimables, prévisions + simulateur,
  assistant à règles (10 intentions), import CSV en assistant, exports CSV/JSON,
  paramètres, notifications in-app, onboarding (démo ou départ vierge), mode
  confidentialité, thèmes, **24 langues**.
* 🟡 **Préparées, non activées** : mode cloud Supabase (schéma + RLS dans
  `supabase/schema.sql`, interface repository ; aucun identifiant, RLS jamais exécutée),
  extension IA (`AssistantProvider`, aucun appel externe).
* ⏳ **Restantes / non implémentées** : authentification et synchro multi-appareils,
  chiffrement au repos, push/e-mail, sources externes de cours/taux, pièces jointes
  dans la sauvegarde JSON, transactions en devise ≠ devise du compte.

## 4. Internationalisation ✅ (avec relecture humaine à faire)

* **Langues** (`src/i18n/languages.ts`) : fr (référence), en, ar, es, pt, de, it, nl, tr,
  ru, uk, pl, ro, sv, el, cs, **he, fa, ar = RTL**, hi, zh, ja, ko, id, vi. Un fichier par
  langue dans `src/i18n/locales/` (~1 450 clés), chargement à la demande.
* **Règles** : `fr.ts` source (`MessageKey`), autres typés `Messages` (TS refuse clé
  manquante/en trop). Interpolation `{var}` ; pluriels `{zero?,one,two?,few?,many?,other}`
  via `Intl.PluralRules`, repli `other`. **`{pct}` déjà formaté avec %**, sauf
  `notif.budgetThreshold.title`, `assist.whatIf.textCategory/Total`, `budget.dayOf`,
  `budget.thresholdsHint` (`{values}`), `goal.realPct` (nombre brut → écrire « % »).
  Mots-clés `assist.kw.*` séparés par `|`, sans accents ; fr + en toujours actifs.
  `imp.letter.D/M/Y` et `set.dateFormat.*` par langue ; en RTL `fc.hint` = « à droite »,
  flèches ←. Changement de langue = remontage de l’app ; `localStorage nexora.lang` ;
  `index.html` applique `lang`/`dir` avant rendu ; Root ne synchronise sur
  `settings.language` que si le profil est onboardé. `uiLocale` pour mois/jours,
  `settings.locale` pour les nombres ; la langue ne change jamais la devise.
* **Corrections déjà faites** : `%` doublé en turc ; langue réinitialisée pendant
  l’onboarding ; axe Y arabe tronqué (`yWidth`) ; assistant : lettres non décomposées
  par NFD repliées (ł ı đ ø æ œ ß…), `%15` turc, catégories déclinées (préfixe commun,
  mots ≥ 6 lettres — désactivé pour les mots courts, faux positif vietnamien), mots-clés
  he/hi corrigés, questions ja/ko alignées sur les noms de catégories ; espaces avant
  particules japonaises ; **calendrier grégorien imposé** (`gregorian()` dans
  `dates.ts`, fa-IR affichait « مهر ۱۴۰۵ ») ; débordement mobile (voir § 5).
* **Vigilance** : traductions **produites par IA, non relues** par des natifs (dit dans
  README et ARCHITECTURE). `normalizeLabel` retire les signes combinants (matras hindi,
  dakuten japonais) — mots-clés trop courts risquent des collisions (ex. « बिल » ⊂
  « बैलेंस » corrigé). Tout nouveau mot-clé doit passer `src/i18n/i18n.test.ts`.

## 5. Interface et expérience utilisateur

* ✅ Design system maison (Tailwind, tokens sombre/clair, cartes, `ChartKit` avec
  `axisMoney`/`yWidth`), navigation latérale groupée (Pilotage/Gestion/Analyse/Système)
  + barre mobile 5 entrées avec bouton central d’ajout, raccourci **N**, sélecteur de mois.
* ✅ RTL : utilitaires logiques (`ms/me`, `ps/pe`, `start/end`, `text-start`…),
  `rtl:-scale-x-100` sur les icônes directionnelles, `.recharts-wrapper{direction:ltr}`.
* ✅ Responsive : 31 grilles reçoivent `grid-cols-1` sous leur breakpoint ; tableau du
  simulateur (Prévisions) en `overflow-x-auto`. Captures desktop 1440 + mobile 390 des
  14 dernières langues : aucun débordement, aucune clé brute, `dir` correct, aucune
  erreur console.
* ⏳ / ❓ Non vérifié dans cette session : thème clair dans les nouvelles langues,
  impression du rapport en RTL, passage complet de captures pour fr/es/pt/de/it/nl/tr/ru
  après les derniers correctifs (seule la page Prévisions mobile a été re-sondée pour
  uk, pl, de, ru).

## 6. État du code (vérifié par `git` au moment de la rédaction)

* Branche active : `claude/nexora-finance-platform-81blaa` ; `HEAD` = `origin` =
  `30cf76f` ; aucune modification non commitée (avant ajout de ce fichier).
* 23 commits ; les 5 derniers : `30cf76f` calendrier grégorien · `e708745` ja particules ·
  `e3b7259` grilles mobiles + docs · `c4db27c` tests i18n + correctifs assistant ·
  `c36db50` vietnamien.
* Aucune PR créée (ne pas en créer sans demande explicite).
* `dist/` présent localement mais ignoré par git. Les scripts de captures
  (`i18n-shots.cjs`, `overflow.cjs`…) sont dans le scratchpad de session, **pas dans le
  dépôt** (perdus à la fin du conteneur).
* Blocage : aucun côté code.

## 7. Déploiement Netlify ❌ non déployé

* ✅ `netlify.toml` commité : `npm run build`, `publish = "dist"`, Node 22, repli SPA
  `/* → /index.html`, en-têtes de sécurité, cache long sur `/assets/*`.
  `VITE_DATA_BACKEND=local` y est défini mais **n’est lu nulle part dans `src/`** (inerte).
* Blocages constatés : `api.netlify.com` répond 403 via le proxy de l’environnement et
  aucun `NETLIFY_AUTH_TOKEN` n’est configuré. **Aucune URL n’existe.**
* Étapes restantes (au choix de l’utilisateur) : (a) sur netlify.com, « Import from
  Git » → dépôt `mouadhminee-bit/Gestion`, branche ci-dessus (réglages lus dans
  `netlify.toml`) ; ou (b) configurer un secret `NETLIFY_AUTH_TOKEN` dans l’environnement
  et autoriser l’hôte `api.netlify.com`, puis déployer via la CLI. Ne jamais demander de
  coller un jeton dans la conversation. Ne jamais annoncer un déploiement sans URL
  vérifiée.

## 8. Bugs et corrections

* ✅ Résolus : voir § 4 (i18n/assistant/calendrier) ; débordement mobile Prévisions
  (uk, pl) ; remplacement d’import interrompu (motifs dupliqués) lors de l’extraction.
* Ouverts / à surveiller ❓ :
  * E2E non relancé après `e708745` et `30cf76f` (risque faible : texte ja et formatage
    de dates).
  * Ajout de mots-clés d’assistant → collisions possibles (scripts sans espaces ou à
    marques combinantes) ; le test « suggestion tapée librement » protège seulement les
    9 questions suggérées.
  * Formulations financières non relues (langues hors fr).
  * Commentaires/libellés : aucune régression connue.

## 9. Décisions déjà prises (ne pas remettre en cause sans raison)

* Local-first IndexedDB ; Supabase uniquement préparé ; **données de démo fictives
  uniquement**.
* Montants exacts en entiers ; transferts = 2 transactions ; prévisionnel jamais stocké ;
  archivage au lieu de suppression quand il y a de l’historique.
* Assistant **déterministe** à règles, aucun appel IA externe ; suggestions appelées via
  `answerIntent` directement.
* Français = langue de référence ; dictionnaires typés ; calendrier grégorien partout ;
  routage par hash.
* Règles Git : travailler/pousser uniquement sur la branche ci-dessus
  (`git push -u origin <branche>`), pas de PR sans demande, messages de commit terminés
  par les lignes `Co-Authored-By` / `Claude-Session` fournies, aucun identifiant de
  modèle dans le code ou les commits. Ne pas modifier inutilement le code fonctionnel.

## 10. Prochaines étapes (ordre proposé)

1. **Déploiement** (dépend d’une action utilisateur, § 7) → critère : URL Netlify qui
   charge l’app, démo fonctionnelle, rechargement sur `#/transactions` OK.
2. Relancer `BASE_URL=http://localhost:4173 node e2e/smoke.cjs` après `npm run build` +
   `npx vite preview --port 4173` → critère : 11/11 PASS, aucune erreur de page.
3. Passage de captures pour fr/es/pt/de/it/nl/tr/ru + thème clair + impression RTL
   (Playwright ; Chromium préinstallé) → critère : 0 débordement, 0 clé brute.
4. Relecture native des traductions (hors périmètre technique ; dépend de l’utilisateur).
5. Ensuite seulement, éventuels chantiers listés en § 3 « restantes » sur demande.

## 11. Instructions de reprise

* **Immédiatement** : `cd /home/user/Gestion && git status && git log --oneline -3` ;
  vérifier `HEAD` = `origin/claude/nexora-finance-platform-81blaa` ; `npm test`
  (attendu 176 verts) ; lire ce fichier puis attendre la demande de l’utilisateur.
* **Ne pas refaire** : extraction des chaînes, les 24 dictionnaires, la mise en RTL, les
  tests i18n, les correctifs assistant/calendrier/grilles, `netlify.toml`, la
  documentation i18n. Ne pas recréer l’application ni changer de stack.
* **Ne pas** : prétendre que Netlify est déployé, demander un jeton en clair, créer une
  PR non demandée, pousser sur une autre branche, introduire des données réelles.
