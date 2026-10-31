# NEXORA — Lot 1 : audit technique et architecture multi-utilisateurs Cloud-first

*Audit réalisé le 31/10/2026 sur le commit `5fd37c3` (branche de production
`claude/nexora-finance-platform-81blaa`), **rectifié le même jour sur la base
`nexora-dev` = `341f3da`** (voir l'encadré ci-dessous).*

> **Rectificatif (31/10/2026).** La première version de cet audit affirmait que la branche
> `nexora-dev` et le dossier `.devcontainer/` n'existaient pas, et comptait 232 tests.
> C'était faux : le clone de la session d'audit ne contenait que deux branches et aucun
> `git fetch` n'avait été lancé. État vérifié (`git ls-remote`, `git fetch`) :
>
> | Branche | HEAD | Rôle |
> |---|---|---|
> | `claude/nexora-finance-platform-81blaa` | `5fd37c3` | production (Netlify) |
> | `nexora-dev` | `341f3da` | développement = production + 5 commits (budgets, prévisions, Codespaces) |
>
> * `nexora-dev` contient `.devcontainer/devcontainer.json` (Node 22, `npm ci`) et
>   `docs/CODESPACES.md` ; scripts `dev:host`, `preview:host`, `check`.
> * Sur `341f3da` : **277 tests dans 12 fichiers, 276 réussis, 1 échec**
>   (`src/domain/dates.test.ts:48`, voir § A.8).
> * **Conclusions techniques inchangées** : `src/data/`, `src/app/`, `supabase/schema.sql`
>   et `src/domain/dates.ts` sont identiques entre les deux branches (`repository.ts`
>   identique à l'octet). Les 5 commits supplémentaires modifient des calculs
>   (`budgets.ts`, `forecast.ts`, `scenario.ts`, `insights.ts`), des écrans et les 24
>   dictionnaires, sans effet sur la persistance.

**Périmètre respecté** : aucun fichier de code, de schéma ou de configuration n'a été
modifié ; aucune base (IndexedDB ou PostgreSQL) n'a été ouverte en écriture ni migrée ;
aucun déploiement. Le seul ajout est ce document.

**Méthode** : lecture intégrale de `src/data/*`, `src/app/*`, `src/domain/types.ts`,
`supabase/schema.sql`, `docs/*`, `netlify.toml`, `.env.example` ; cartographie des appels
`repo.*` et des accès `IndexedDB` / `localStorage` / `sessionStorage` depuis l'UI
(`grep`) ; exécution de `npm test` et `npm run typecheck`.

Légende : ✅ conforme · 🟡 partiel / à corriger · ❌ absent · ⚠ risque.

---

## 0. Synthèse

| # | Constat | Impact sur le Cloud-first |
|---|---|---|
| 1 | ✅ Le **domaine** (`src/domain/`, calculs financiers) est pur : aucune dépendance à Dexie, React ou au navigateur. | Réutilisable tel quel. Aucun calcul à réécrire. |
| 2 | ✅ **Aucun écran n'importe Dexie.** Les pages lisent un instantané `DataSnapshot` via `useApp()` et écrivent uniquement par `repo.*`. Seuls `AppContext.tsx` (`getDB`, `useLiveQuery`, `new LocalRepository`) et `App.tsx` touchent la persistance. | Point de bascule unique et étroit : ~2 fichiers. |
| 3 | 🟡 `LocalRepository` (1 001 lignes, 54 méthodes publiques) **mélange** règles d'écriture (validation, cascades, opérations composées) et accès Dexie. Il n'existe **pas d'interface** TypeScript : l'UI dépend de la classe concrète (`repo: LocalRepository` dans `AppContext`, `Onboarding`). | À séparer : logique métier d'écriture ↔ adaptateur de stockage. |
| 4 | 🟡 `supabase/schema.sql` est un **brouillon jamais exécuté** : bon socle (16 tables, BIGINT, CHECK, RLS `owner_all`), mais pas de migrations versionnées, pas de profils, cohérence de propriétaire incomplète (⚠ fuite possible par clé étrangère), pas de mécanisme de synchronisation (suppressions, versions), pas de Storage. | À transformer en migrations (`supabase/migrations/`) corrigées et complétées. |
| 5 | ⚠ L'identifiant utilisateur local est la constante `'local-user'` (non UUID) et la base IndexedDB `nexora` contient les **données réelles Edge**. | Le cache cloud doit vivre dans une **autre base IndexedDB** ; `nexora` ne doit jamais être ouverte en mode cloud. |
| 6 | ⚠ Routage par hash (`HashRouter`) + flux d'authentification Supabase par défaut (jetons dans le fragment `#access_token=…`) = conflit. | Utiliser le flux **PKCE** (`?code=` en query string). |
| 7 | 🟡 Tests (sur `nexora-dev`) : 277 tests (12 fichiers), domaine et repository bien couverts ; **1 échec** dans cet environnement (`dates.test.ts:48`, dépendant des données de fuseau, voir § A.8) ; aucun test UI, aucune CI, aucun outil de couverture. | Ajouter des tests de contrat du repository exécutés sur les deux adaptateurs + tests RLS SQL. |
| 8 | ✅ La branche de développement `nexora-dev` existe (`341f3da`, production + 5 commits) et contient `.devcontainer/` (Codespaces). ❌ Aucun `.github/` (CI). *(La première version de l'audit affirmait à tort l'inverse, voir le rectificatif.)* | Décision D10 retenue : `nexora-dev` = branche de développement principale. |

---

## A. Cartographie de l'existant

### A.1 Couches et dépendances

```
main.tsx → App.tsx
             ├─ I18nProvider (localStorage 'nexora.lang')
             ├─ HashRouter, Tooltip/Toast/Confirm providers
             └─ Root
                 ├─ useRepository()  → new LocalRepository(getDB(), 'local-user')   [AppContext.tsx:75]
                 ├─ useSnapshot(repo) → useLiveQuery(() => repo.snapshot())          [AppContext.tsx:136]
                 ├─ Onboarding(repo)          (si pas de profil / non onboardé)
                 └─ AppProvider(repo, snapshot)
                      ├─ ctx = buildContext(data)   (domain/calc/ledger)
                      ├─ fmt (formateurs, mode confidentialité)
                      └─ pages/* , features/*  → lecture : useApp().data / ctx
                                               → écriture : useApp().repo.<méthode>()

src/data/                         src/domain/ (pur, testé)
  db.ts        Dexie v1, 19 tables     types.ts, money.ts, dates.ts, validation.ts,
  repository.ts LocalRepository  ───▶  csv.ts, duplicates.ts, assistant.ts, settings.ts,
  demo.ts      jeu de démo             categories.seed.ts, calc/* (12 modules)
```

| Composant | Rôle | Dépend de |
|---|---|---|
| `src/domain/types.ts` | Modèle de données (entités, `DataSnapshot`) | `money`, `dates`, `i18n/labels` |
| `src/domain/calc/*` (ledger, fx, budgets, goals, recurring, debts, networth, forecast, scenario, analytics, insights, notifications) | Moteur de calcul centralisé, fonctions pures sur `DataSnapshot` / `LedgerContext` | domaine uniquement |
| `src/domain/validation.ts` | Validation des saisies (UI + repository) | domaine, i18n |
| `src/data/db.ts` | Schéma Dexie v1, `USER_TABLES`, singleton `getDB()` | Dexie |
| `src/data/repository.ts` | Écritures validées et atomiques, instantané, sauvegarde/restauration | db, domaine, i18n |
| `src/data/demo.ts` | Jeu de démonstration déterministe (`DataSnapshot`) | domaine |
| `src/app/AppContext.tsx` | Instancie le repository, instantané live, formateurs, mois courant | **Dexie (`useLiveQuery`), `LocalRepository`** |
| `src/features/hooks.ts` | `useMonthData`, `useBalances` (calculs mémoïsés) | domaine, AppContext |
| `src/features/export.ts` | Exports CSV | domaine |
| `src/pages/*` (14 écrans + Onboarding) | Présentation, appels `repo.*` | AppContext, domaine, `ValidationError` |
| `src/i18n/*` | 24 langues, `t()` pur, RTL | — |

### A.2 Organisation des modules métier

| Module | Calcul (domaine) | Écran | Méthodes repository |
|---|---|---|---|
| Profil / paramètres | `settings.ts` | Settings, Onboarding, AppShell | `ensureUser`, `getSettings`, `updateSettings` |
| Comptes | `ledger.ts` | Accounts | `createAccount`, `updateAccount`, `archiveAccount`, `deleteAccount` |
| Catégories | `categories.seed.ts` | Settings | `createCategory`, `updateCategory`, `categoryUsage`, `deleteCategory`, `reorderCategories` |
| Transactions / transferts / pièces jointes | `ledger.ts`, `validation.ts` | Transactions, TransactionForm | `createTransaction`, `getTransactionGroup`, `updateTransaction`, `deleteTransactions`, `recategorize`, `add/get/removeAttachment` |
| Import CSV | `csv.ts`, `duplicates.ts` | Import | `importTransactions` |
| Budgets | `budgets.ts` | Budgets | `setBudget`, `deleteBudget`, `copyBudgets` |
| Objectifs | `goals.ts` | Goals | `saveGoal`, `deleteGoal`, `addGoalContribution` |
| Récurrences | `recurring.ts` | Recurring, LinkOccurrenceDialog | `saveRecurringRule`, `deleteRecurringRule`, `markOccurrencePaid`, `linkOccurrence`, `unlinkTransaction`, `settleOccurrence`, `reopenOccurrence`, `skipOccurrence`, `resetOccurrence` |
| Dettes / créances | `debts.ts` | Debts | `createDebt`, `updateDebt`, `deleteDebt`, `addDebtPayment`, `deleteDebtPayment` |
| Patrimoine | `networth.ts` | NetWorth | `saveAsset`, `deleteAsset`, `addValuation`, `deleteValuation` |
| Taux de change | `fx.ts` | Settings | `saveRate`, `deleteRate` |
| Notifications | `notifications.ts` | AppShell | `setNotificationState` |
| Analyses, rapport, prévisions, scénarios, assistant | `analytics`, `forecast`, `scenario`, `insights`, `assistant` | Analytics, Report, Forecast, Assistant, Dashboard | lecture seule |
| Sauvegarde / démo / réinitialisation | — | Settings, Onboarding | `exportBackup`, `restoreBackup`, `replaceWithSnapshot`, `resetToEmpty`, `clearUserData` |

### A.3 Persistance Dexie (`src/data/db.ts`)

* Base `nexora`, **version 1 unique** (aucune migration publiée), 19 tables :
  `meta`, `users`, `settings` + 16 tables métier. Toutes indexées par `userId`
  (sauf `meta`, `users`).
* Index composés : `transactions [userId+date]`, `budgets [userId+month]`,
  `notificationStates [userId+id]` (clé primaire composée).
* Clés : UUID v4 générés côté client (`lib/id.ts`), sauf
  `occurrences.id = "<ruleId>:<dueDate>"` et `notificationStates.id` (clé déterministe
  textuelle, ex. `budget:<catId>:2026-10:90`).
* Champs ajoutés sans migration : `RecurringOccurrence.closure` (non indexé).
* `users` et `attachments` **ne font pas partie de `USER_TABLES`** → exclus de la
  sauvegarde.

### A.4 Repository (`LocalRepository`)

Points forts ✅ : scoping systématique par `this.userId` (`own()` vérifie le
propriétaire) ; validations réappliquées avant écriture ; opérations composées dans des
transactions Dexie atomiques ; archivage plutôt que suppression ; aucune écriture
directe de l'UI.

Points à traiter 🟡 :

| Sujet | Détail | Conséquence cloud |
|---|---|---|
| Pas d'interface | L'UI typée sur la classe `LocalRepository` | Introduire `NexoraRepository` (interface) |
| Couplage stockage | ~190 appels `this.db.<table>` dans les méthodes métier | Extraire un adaptateur de stockage |
| Lecture-modification-écriture hors transaction | ex. `addGoalContribution` lit l'objectif avant la transaction et réécrit `savedAmount` ; `addDebtPayment` recalcule le statut | ⚠ *lost update* entre deux appareils → contrôle de version optimiste |
| Requêtes non scopées | `transactions.where('accountId')` (`updateAccount`, `deleteAccount`) et `where('transferId')` sans filtre `userId` (filtré ensuite pour les jambes) | Sans risque en local mono-utilisateur ; côté serveur la RLS couvre |
| Restauration | `restoreBackup` réécrit les lignes **avec leurs identifiants d'origine** et sans validation par ligne | ⚠ En cloud, restaurer la même sauvegarde dans deux comptes provoquerait des collisions de clé primaire → remappage des identifiants |
| Instantané complet | `snapshot()` charge toutes les tables en mémoire à chaque écriture (`useLiveQuery`) | Acceptable (volumétrie personnelle) ; reste valable sur le cache |

Inventaire des **opérations composées** (doivent rester atomiques côté serveur) :
`ensureUser` (profil + paramètres + catégories initiales), `updateCategory`
(propagation aux sous-catégories), `deleteCategory` (+ enfants), `reorderCategories`,
`createTransaction` (transfert = 2 jambes), `updateTransaction` (remplacement des
jambes), `deleteTransactions` (jambes, états d'échéance, paiements de dette, origine de
dette, pièce jointe), `recategorize`, `add/removeAttachment`, `importTransactions`
(transactions + lot), `setBudget` (plusieurs mois), `copyBudgets`, `deleteGoal`,
`addGoalContribution` (+ `savedAmount`, statut), `deleteRecurringRule`,
`markOccurrencePaid`, `linkOccurrence`, `unlinkTransaction`, `resetOccurrence`,
`createDebt` (+ transaction d'origine), `deleteDebt`, `addDebtPayment` (+ transaction,
statut), `deleteDebtPayment`, `saveAsset` (+ valorisation), `deleteAsset`,
`setNotificationState`, `restoreBackup`, `clearUserData`.

### A.5 Dépendances directes des écrans à IndexedDB

| Fichier | Dépendance | Nature |
|---|---|---|
| `src/app/AppContext.tsx` | `getDB()`, `useLiveQuery`, `new LocalRepository(…, LOCAL_USER_ID)` | **Seul point de couplage réel** |
| `src/App.tsx` | `useRepository`, `useSnapshot` (états `undefined` = chargement, `null` = onboarding) | Indirect |
| `src/pages/Onboarding.tsx` | Type `LocalRepository`, `generateDemoData` | Type concret |
| `src/pages/Settings.tsx` | `generateDemoData`, `repo.userId`, `clearUserData`, `localStorage/sessionStorage` (préférences) | Indirect |
| `Accounts`, `Debts`, `Goals`, `Recurring`, `TransactionForm` | `import { ValidationError } from '@/data/repository'` | Type d'erreur, à déplacer dans le domaine |

Aucun écran n'utilise `indexedDB`, `Dexie` ou `getDB` directement ✅.
`localStorage`/`sessionStorage` : uniquement préférences (`nexora.lang`, `nexora.theme`,
`nexora.lastAccount`, `nexora.month`, filtres) — à conserver localement.

### A.6 Sauvegarde et restauration

* `exportBackup()` : JSON `{ app, schemaVersion: 1, exportedAt, data }` des 16
  `USER_TABLES` (sans pièces jointes ni `users`).
* `restoreBackup()` : contrôle de `app`, `schemaVersion ≤ 1`, présence de `settings` ;
  **efface tout** puis `bulkPut` avec réécriture de `userId` ; aucune validation par
  ligne ; identifiants conservés.
* `replaceWithSnapshot()` (démo) et `resetToEmpty()` passent par la même mécanique.
* Exports CSV (`features/export.ts`) : indépendants du stockage ✅.

### A.7 Configuration et déploiement

* `netlify.toml` : build statique, `VITE_DATA_BACKEND=local` **lu nulle part** (inerte).
* `.env.example` : `VITE_DATA_BACKEND`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_ASSISTANT_PROXY_URL` — aucun n'est lu par le code.
* Dépendance `@supabase/supabase-js` : **absente**.
* Déploiement automatique Netlify depuis `claude/nexora-finance-platform-81blaa`
  (= production, `mflous.netlify.app`, selon `SESSION_HANDOFF.md`). Le comportement de
  Netlify pour les autres branches (déploiements de branche) n'est pas visible depuis le
  dépôt : ❓ à vérifier dans la configuration Netlify avant tout push sur `nexora-dev`.
* Développement : GitHub Codespaces via `.devcontainer/devcontainer.json` (sur
  `nexora-dev`), guide `docs/CODESPACES.md` ; `npm run check` = typecheck + tests + build.

### A.8 Tests et couverture

| Fichier | Tests | Couvre |
|---|---|---|
| `data/repository.test.ts` | 31 | CRUD, transferts, persistance, sauvegarde/restauration, isolation entre utilisateurs (local), archivage, budgets, récurrences et rapprochement, dettes, objectifs, import, démo (fake-indexeddb) |
| `domain/calc/modules.test.ts` | 32 | budgets, objectifs, dettes, patrimoine, prévisions, scénarios, analyses, récurrences |
| `domain/calc/recurringCharges.test.ts` | 21 | charges récurrentes, statuts |
| `domain/calc/ledger.test.ts` | 18 | moteur comptable, fx |
| `domain/calc/budgets.test.ts` | 18 | budgets : catégories budgétées, hors budget, projection *(nexora-dev)* |
| `domain/calc/projection.test.ts` | 15 | prévisions : méthodes de projection, minimum engagé *(nexora-dev)* |
| `domain/calc/atypical.test.ts` | 12 | dépenses atypiques *(nexora-dev)* |
| `domain/money.test.ts`, `dates.test.ts`, `csv.test.ts` | 11 / 7 / 9 | montants, dates, CSV, doublons |
| `domain/assistant.test.ts` | 9 | assistant |
| `i18n/i18n.test.ts` | 10 (cas paramétrés sur les 24 langues) | 24 dictionnaires |
| `e2e/smoke.cjs` | 11 contrôles | parcours FR, lancé à la main |

Le nombre de `it()` ci-dessus est indicatif ; les cas paramétrés (`it.each`) portent le
total exécuté à **277 tests dans 12 fichiers** sur `nexora-dev` (`341f3da`).

Résultat ici : **276/277 verts**, typecheck OK. L'échec (`dates.test.ts:48`) attend
`2027-01-01` pour `todayISO('Africa/Casablanca', 2026-12-31T23:30Z)` en supposant UTC+1 ;
les données de fuseau de cet environnement (ICU 78.3, tzdata **2026e**) placent Casablanca
à **UTC+0** à cette date. Le code (`Intl`) est correct ; c'est le test qui fige un décalage
horaire. **Corrigé** (sans toucher `dates.ts`) : changement de jour vérifié sur des zones
à décalage fixe (`Etc/GMT-1`, `Etc/GMT+5`) ; pour Casablanca, date attendue calculée à
partir du décalage réel de la zone lu dans les règles de l'environnement, et cas à midi UTC
valable quel que soit le décalage.

Non couverts ❌ : `calc/notifications.ts` (aucun test dédié), pages et composants,
`AppContext`, Onboarding, flux de restauration côté UI, toute partie cloud. Pas d'outil
de couverture (`@vitest/coverage-v8` absent) ni de CI.

---

## B. Analyse Supabase (`supabase/schema.sql`)

### B.1 Ce qui existe

* 16 tables en miroir des tables Dexie : `user_settings`, `accounts`, `categories`,
  `transactions`, `budgets`, `savings_goals`, `goal_contributions`, `recurring_rules`,
  `recurring_occurrences`, `debts`, `debt_payments`, `assets`, `asset_valuations`,
  `exchange_rates`, `notification_states`, `import_batches`.
* RLS activée et **forcée** sur les 16 tables, politique unique `owner_all`
  (`for all to authenticated using/with check (user_id = auth.uid())`).
* Un trigger de cohérence de propriétaire sur `transactions`
  (`enforce_same_owner_transaction`).
* Deux index (`transactions_user_date`, `transactions_transfer`) + l'index partiel
  `assets_one_per_account`.
* Aucun dossier `supabase/migrations/`, aucun `supabase/config.toml`, aucun bucket
  Storage, aucune fonction RPC, aucun seed. **Rien n'a été exécuté** contre une instance
  (ARCHITECTURE § 9). Je n'ai pas accès à un projet Supabase depuis cet environnement :
  l'état réel d'une éventuelle instance est **à vérifier** (décision D9).

### B.2 Ce qui est correctement configuré ✅

* `user_id uuid not null references auth.users on delete cascade` partout (suppression
  de compte = effacement complet, conforme RGPD).
* Montants `bigint`, dates métier `date`, horodatages `timestamptz`.
* CHECK pertinents : types/sens de transaction, transfert ⇒ `transfer_id` +
  contrepartie ≠ compte, ajustement ⇒ notes (cohérent avec `validation.ts:90`),
  `amount > 0`, intérêts ≤ montant, `goal_contributions.amount <> 0`,
  `principal + interest > 0`, `base <> quote`, `end_date >= start_date`.
* `budgets unique nulls not distinct (user_id, month, category_id)` (PostgreSQL ≥ 15,
  disponible sur Supabase) : un seul budget global par mois.
* `assets_one_per_account` : pas de double valorisation d'un compte.
* `recurring_occurrences` PK `(rule_id, due_date)` et `notification_states` PK
  `(user_id, id)` : cohérent avec les clés déterministes.
* RLS `force` + rôle `authenticated` uniquement (le rôle `anon` n'a aucune politique).

### B.3 Ce qui est incomplet 🟡

| # | Manque | Gravité |
|---|---|---|
| I1 | **Cohérence de propriétaire** limitée à `transactions` (compte, contrepartie, catégorie). Non contrôlés : `transactions.subcategory_id`, `refund_of_id`, `debt_id`, `debt_payment_id`, `recurring_rule_id`, `import_batch_id` ; `categories.parent_id` ; `budgets.category_id` ; `savings_goals.linked_account_id` ; `goal_contributions.goal_id` ; `recurring_rules.account_id/category_id/subcategory_id` ; `recurring_occurrences.rule_id/transaction_id` ; `debts.origin_transaction_id` ; `debt_payments.debt_id/account_id/transaction_id` ; `assets.linked_account_id` ; `asset_valuations.asset_id` ; `import_batches.account_id`. | ⚠ **Élevée** : la vérification des clés étrangères PostgreSQL **ignore la RLS** ; un utilisateur peut référencer l'UUID d'une ligne d'un autre (et sonder son existence). |
| I2 | Clés étrangères absentes : `transactions.debt_id`, `debt_payment_id`, `recurring_rule_id`, `import_batch_id`. | Moyenne |
| I3 | Pas de table **profils** (`users` Dexie sans équivalent ; `display_name` dans `user_settings`). Pas de création automatique à l'inscription. | Élevée (vision multi-utilisateurs) |
| I4 | Pas de table **pièces jointes** ni de bucket Storage (seulement un commentaire) ; `transactions.attachment_path` ≠ `Transaction.attachmentId`. | Moyenne |
| I5 | Pas de **synchronisation** : aucune colonne de suppression logique / journal des suppressions, aucun numéro de version, `updated_at` absent de `goal_contributions`, `debt_payments`, `asset_valuations`, `exchange_rates`, `import_batches` ; seul `transactions` met à jour `updated_at` (et c'est le trigger de propriétaire qui le fait). | Élevée |
| I6 | `recurring_occurrences.closure` absent (champ `closure: 'waived'` du domaine). | Élevée (perte de donnée) |
| I7 | CHECK manquants : `categories.nature` vs `kind`, `transactions.payment_method`, `savings_goals.priority/status`, `debts.type/status/installment_frequency`, `assets.type`, `asset_valuations.source`, `exchange_rates.source`, `user_settings.language/date_format/currency_display`, devise `^[A-Z]{3}$`, couleur. | Faible à moyenne |
| I8 | Index manquants : `user_id` sur toutes les tables (utilisé par chaque politique), clés étrangères (`account_id`, `category_id`, `goal_id`, `debt_id`, `asset_id`, `rule_id`), `transactions (user_id, recurring_rule_id, recurring_due_date)`, `exchange_rates (user_id, base, quote, date)`. | Moyenne (performance) |
| I9 | Aucune migration versionnée (`create table if not exists` ne fait jamais évoluer une table existante). | Élevée (exploitation) |
| I10 | Aucune fonction RPC transactionnelle pour les opérations composées (§ A.4). | Élevée |
| I11 | Aucun test SQL (RLS, contraintes). | Élevée |

### B.4 Ce qui doit être modifié ✏️

| # | Modification | Raison |
|---|---|---|
| M1 | Politiques : `(select auth.uid())` au lieu de `auth.uid()` ; politiques séparées par commande si besoin (ex. tables en ajout seul). | Recommandation Supabase (évaluation unique par requête) |
| M2 | Remplacer le trigger de propriétaire par des **clés étrangères composites** `(user_id, x_id) references parent (user_id, id)` avec `unique (user_id, id)` sur chaque table parente. Pour `on delete set null`, utiliser la forme PostgreSQL 15 `on delete set null (x_id)` (sinon `user_id` serait aussi mis à NULL). | Isolation déclarative, sans code, couvre I1/I2 |
| M3 | `categories.parent_id on delete restrict` → `no action` (vérifié en fin d'instruction) ou `cascade`, car `deleteCategory` supprime parent et enfants ensemble. | Compatibilité avec le repository |
| M4 | `transactions.attachment_path` → `attachment_id uuid` (FK vers `attachments`). | Aligner sur le domaine |
| M5 | `import_batches.account_id` : conserver nullable (`set null`), mais le type TS doit l'accepter (`accountId?: ID`). | Cohérence TS ↔ SQL |
| M6 | Références circulaires `debts.origin_transaction_id ↔ transactions.debt_id` et `debt_payments.transaction_id ↔ transactions.debt_payment_id` : contraintes `deferrable initially deferred`. | Insertion des deux lignes dans la même transaction |
| M7 | `updated_at` : trigger générique `set_updated_at()` sur toutes les tables modifiables, séparé du contrôle de propriétaire. | Synchronisation incrémentale |
| M8 | Fonctions `security definer` éventuelles : `set search_path = ''` et noms qualifiés. Par défaut, toutes les RPC métier en **`security invoker`** (la RLS s'applique). | Sécurité |
| M9 | `recurring_occurrences.transaction_id` : conserver pour compatibilité (anciennes échéances), le lien de référence étant `transactions.recurring_rule_id + recurring_due_date`. | Règle métier en vigueur |

### B.5 Ce qui doit être créé ➕

`supabase/config.toml` et `supabase/migrations/*` ; table `profiles` + trigger
`on auth.users insert` ; table `attachments` + bucket privé + politiques Storage ;
colonnes de synchronisation (`version`, `deleted_at` ou journal `deletions`) ; RPC
`apply_changeset` (cf. § C.4) ; tests SQL (pgTAP via `supabase test db`) ; types générés
(`supabase gen types typescript`) ; client `@supabase/supabase-js`.

---

## C. Architecture cible

### C.1 Vue d'ensemble

```
┌──────────────────────────── UI (inchangée) ─────────────────────────────┐
│ pages/ features/ components/   lisent useApp().data, écrivent repo.*()  │
└──────────────▲──────────────────────────────────────┬────────────────────┘
               │ DataSnapshot (live)                  │ NexoraRepository (interface)
┌──────────────┴──────────────┐        ┌──────────────▼───────────────────────────┐
│ Cache IndexedDB (Dexie)     │◀───────│ RepositoryCore (logique d'écriture       │
│ base « nexora-cache-<uid> » │ applique│ actuelle : validation, cascades,         │
│ même schéma que db.ts v1    │ le lot  │ opérations composées) → ChangeSet        │
│ + table _sync               │ validé  └──────────────┬───────────────────────────┘
└──────────────▲──────────────┘                       │ StorageAdapter
               │ pull incrémental                      ├─ LocalAdapter   → Dexie « nexora » (mode local, Edge)
               │                                       └─ CloudAdapter   → rpc('apply_changeset') puis cache
┌──────────────┴──────────────────────────────────────▼───────────────────┐
│ Supabase : Auth (PKCE) · PostgreSQL (RLS user_id) · Storage privé       │
└─────────────────────────────────────────────────────────────────────────┘
          domain/ (calculs, validation, 24 langues) : inchangé
```

Principes :

1. **PostgreSQL fait autorité.** Une écriture n'est appliquée au cache qu'après
   confirmation du serveur (pas d'écriture optimiste au premier jalon).
2. **Le domaine ne change pas.** Les calculs consomment toujours un `DataSnapshot`.
3. **L'UI ne change pas** : elle continue de lire un instantané live (`useLiveQuery`
   sur le cache) et d'appeler les mêmes méthodes.
4. **Le mode local reste disponible** (`VITE_DATA_BACKEND=local`) et constitue le
   comportement par défaut tant que le cloud n'est pas validé. La base `nexora` (Edge)
   n'est **jamais** ouverte en mode cloud.

### C.2 Supabase Auth et profils

* Client unique `src/data/cloud/supabaseClient.ts` :
  `createClient(url, publishableKey, { auth: { flowType: 'pkce', persistSession: true, detectSessionInUrl: true } })`.
  Clé **publique** uniquement (anon / publishable) ; jamais `service_role`.
* PKCE obligatoire avec `HashRouter` : le retour se fait en `/?code=…#/` ; le code est
  échangé avant le premier rendu du routeur (`exchangeCodeForSession`).
* Méthodes : e-mail + mot de passe et lien magique (décision D3), réinitialisation de
  mot de passe, déconnexion. Les URL de redirection autorisées sont configurées dans le
  projet Supabase (production, aperçus Netlify, localhost, Codespaces).
* `AuthProvider` (nouveau, au-dessus de `Root`) expose `session | null | 'loading'` ;
  écran `SignIn` traduit dans les 24 langues (nouvelles clés `auth.*` dans `fr.ts` puis
  les 23 autres dictionnaires — le typage `Messages` impose la complétude).
* Inscription : trigger SQL `handle_new_user()` (`security definer`,
  `search_path = ''`) qui crée `profiles` et `user_settings`. Les **catégories initiales**
  restent créées par le client (`buildSeedCategories`, déjà traduites via `key`) dans la
  même RPC que l'onboarding (décision D5).

### C.3 Repositories indépendants du stockage

```ts
// src/data/contracts.ts (nouveau) — signature reprise à l'identique de LocalRepository
export interface NexoraRepository { readonly userId: ID; snapshot(): Promise<DataSnapshot | null>;
  ensureUser(...): ...; createAccount(...): ...; /* … les 54 méthodes publiques actuelles */ }

// src/data/storage.ts (nouveau)
export interface ChangeSet {
  upserts: Partial<Record<UserTableName | 'attachments', Row[]>>;
  deletes: Partial<Record<UserTableName | 'attachments', Key[]>>;
  expect?: { table: UserTableName; id: Key; version: number }[]; // contrôle optimiste
}
export interface StorageAdapter {
  read: ReadPort;                       // get / where userId / where index (lit le cache)
  commit(cs: ChangeSet): Promise<void>; // atomique : Dexie transaction | RPC serveur
}
```

* `RepositoryCore` = le code actuel de `LocalRepository`, dont chaque bloc
  `db.transaction('rw', …)` est remplacé par la construction d'un `ChangeSet` puis
  `adapter.commit()`. **Les règles, validations et messages i18n sont conservés
  mot pour mot** ; c'est un refactoring mécanique, testé par la suite existante.
* `LocalAdapter` : applique le `ChangeSet` dans une transaction Dexie (comportement
  actuel, base `nexora`).
* `CloudAdapter` : envoie le `ChangeSet` à `rpc('apply_changeset')` ; en cas de succès,
  applique les lignes renvoyées par le serveur (horodatages et versions faisant foi) au
  cache `nexora-cache-<uid>` dans une transaction Dexie ; en cas d'échec, rien n'est
  écrit localement et l'erreur est traduite (`ValidationError`, conflit, hors ligne).
* `ValidationError` déplacé dans `src/domain/errors.ts` (ré-exporté depuis
  `data/repository.ts` pour ne pas toucher aux imports existants au premier jalon).

### C.4 Écriture serveur : RPC `apply_changeset`

* `security invoker` → la RLS s'applique à chaque ligne ; une seule transaction SQL.
* Pour chaque table autorisée (liste blanche) : `insert … on conflict (id) do update`
  avec `user_id` forcé à `(select auth.uid())`, conversion camelCase → snake_case par
  une table de correspondance unique (côté client), contrôle `version` attendu
  (`expect`) → erreur `40001` « conflit » si la ligne a changé entre-temps ; suppressions
  logiques (`deleted_at = now()`).
* Les **invariants** restent garantis par le schéma (CHECK, clés composites, unicités,
  contraintes différées) : un client modifié ne peut pas écrire de données incohérentes
  ni hors de son espace.
* Invariants inter-lignes vérifiés par trigger de contrainte différé (à la validation) :
  transfert = exactement 2 jambes de sens opposés, comptes différents, même
  `transfer_id` ; paiement de dette ↔ transaction liée cohérents.
* Alternative écartée : réécrire chaque opération composée en PL/pgSQL (duplication
  des règles métier, risque de divergence des calculs). Voir décision D2.

### C.5 Cache IndexedDB

* Base **distincte par utilisateur** : `nexora-cache-<auth.uid>` ; même schéma Dexie
  que `db.ts` v1 (classe `NexoraDB` paramétrée par nom — le constructeur l'accepte déjà)
  + table `_sync` (`table`, `lastPulledAt`, `lastServerVersion`).
* Contenu : copie non autoritaire des lignes de l'utilisateur ; `snapshot()` lit le
  cache (aucun changement du chemin de lecture ni des calculs).
* Déconnexion explicite : suppression de la base de cache (décision D6).
* Pièces jointes : métadonnées en cache ; fichier téléchargé à la demande par URL
  signée (non mis en cache par défaut).

### C.6 Synchronisation contrôlée

| Étape | Règle |
|---|---|
| Ouverture de session | Pull complet si cache vide ; sinon pull incrémental `updated_at > lastPulledAt` (incluant les lignes `deleted_at` non nulles, appliquées comme suppressions dans le cache). |
| Écriture | En ligne uniquement au premier jalon : `commit` → serveur → cache. Hors ligne : écritures refusées avec message clair, lecture du cache autorisée (décision D4). |
| Autres appareils | Pull au retour au premier plan (`visibilitychange`), au retour réseau et périodiquement (ex. 60 s) ; Supabase Realtime en option (D7). |
| Conflits | Contrôle de version optimiste sur les lignes modifiées (`version` incrémenté par trigger). Conflit → rechargement des lignes, message à l'utilisateur, aucune fusion automatique de montants. |
| Champs dérivés | `savings_goals.saved_amount` et `debts.status` sont recalculés à partir des lignes filles dans la même RPC (ou protégés par `expect`), pour éviter les mises à jour perdues. |
| Purge | Les lignes supprimées logiquement sont purgées côté serveur après N jours (tâche planifiée, lot ultérieur). |

### C.7 Sélection du mode et configuration

* `VITE_DATA_BACKEND = local | supabase` (enfin lu par le code, dans `AppContext`).
* `local` : `LocalRepository` actuel sur `nexora`, sans authentification (Edge
  inchangé). `supabase` : `AuthProvider` → `CloudRepository` sur le cache par
  utilisateur.
* Netlify : variables `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` (ou
  `ANON_KEY`) par contexte (production / aperçu). La production reste en `local` jusqu'à
  validation (décision D8).

---

## D. Modèle de données cible

Conventions communes à toutes les tables métier :

```
id          uuid primary key            -- UUID v4 généré par le client (idempotence)
user_id     uuid not null references auth.users(id) on delete cascade
created_at  timestamptz not null default now()
updated_at  timestamptz not null default now()     -- trigger set_updated_at
version     bigint not null default 1               -- trigger : +1 à chaque update
deleted_at  timestamptz                             -- suppression logique (sync)
unique (user_id, id)                                -- cible des clés composites
index (user_id, updated_at)                         -- pull incrémental
RLS : owner_all using/with check (user_id = (select auth.uid()))
```

Les références internes sont des **clés composites** `(user_id, x_id)` → isolation
garantie par le schéma. Les vues de lecture filtrent `deleted_at is null`.

### D.1 Profils et paramètres

| Table | Colonnes clés | Intégrité |
|---|---|---|
| `profiles` *(nouvelle)* | `id uuid PK = auth.users.id`, `display_name`, `avatar_url`, `created_at`, `updated_at` | Créée par trigger à l'inscription ; RLS `id = auth.uid()` (lecture/mise à jour, pas d'insert/delete client). Réservé SaaS : `plan text default 'free'` non modifiable par le client (décision D1). |
| `user_settings` | PK `user_id` ; colonnes actuelles + `created_at`, `version` | CHECK `language` ∈ 24 codes, `date_format`, `currency_display`, `theme`, devise `^[A-Z]{3}$`, seuils 1–100. `display_name` migre vers `profiles` (lecture conservée dans `UserSettings` via la jointure du cache). |

### D.2 Comptes et catégories

| Table | Ajouts / corrections | Intégrité |
|---|---|---|
| `accounts` | conventions communes | CHECK type, devise ; `unique (user_id, id)` |
| `categories` | conventions communes | FK `(user_id, parent_id) → categories(user_id, id)` `on delete no action` ; CHECK `nature is null or kind = 'expense'` ; un seul niveau (trigger : le parent n'a pas de parent) ; `unique (user_id, key) where key is not null` |

### D.3 Transactions, pièces jointes, imports

| Table | Ajouts / corrections | Intégrité |
|---|---|---|
| `transactions` | `attachment_id` (remplace `attachment_path`) ; conventions communes | FK composites vers `accounts` (account, counterpart), `categories` (category, subcategory), `transactions` (refund_of), `debts`, `debt_payments` (différées), `recurring_rules`, `import_batches`, `attachments` ; CHECK `payment_method` ; trigger différé « transfert = 2 jambes » ; index `(user_id, date desc)`, `(user_id, account_id)`, `(user_id, transfer_id)`, `(user_id, recurring_rule_id, recurring_due_date)` |
| `attachments` *(nouvelle)* | `id`, `user_id`, `transaction_id`, `storage_path`, `name`, `mime_type`, `size` | Bucket privé `attachments`, chemin `<user_id>/<transaction_id>/<id>` ; politiques Storage `(storage.foldername(name))[1] = auth.uid()::text` ; taille max et types MIME limités |
| `import_batches` | conventions communes | FK `(user_id, account_id)` `on delete set null (account_id)` |

### D.4 Budgets

`budgets` : conventions communes ; FK `(user_id, category_id)` ; unicité actuelle
`nulls not distinct (user_id, month, category_id)` **appliquée aux lignes non
supprimées** (index unique partiel `where deleted_at is null`) ; CHECK `month`, seuils.

### D.5 Objectifs

| Table | Intégrité |
|---|---|
| `savings_goals` | FK `(user_id, linked_account_id)` `on delete set null (linked_account_id)` ; CHECK `priority` ∈ (low, medium, high), `status` ∈ (active, paused, achieved, archived) ; `saved_amount` recalculé = Σ contributions (même RPC) |
| `goal_contributions` | FK `(user_id, goal_id)` `on delete cascade` ; + `updated_at`, `version`, `deleted_at` |

### D.6 Récurrences

| Table | Intégrité |
|---|---|
| `recurring_rules` | FK composites compte / catégories ; CHECK fréquence et `custom_*` cohérents (`frequency = 'custom'` ⇔ intervalle et unité renseignés) |
| `recurring_occurrences` | PK conservée `(rule_id, due_date)` + `user_id` ; **`closure text check (closure in ('waived'))`** ; FK `(user_id, rule_id)` `on delete cascade` ; `transaction_id` conservé (compatibilité). Côté cache, `id = "<ruleId>:<dueDate>"` reste dérivé (aucun changement du domaine). |

Lien de règlement : inchangé, porté par `transactions.recurring_rule_id +
recurring_due_date` (une opération = une échéance). La table d'affectation
multi-échéances reste **hors périmètre** (décision antérieure).

### D.7 Dettes et créances

| Table | Intégrité |
|---|---|
| `debts` | CHECK `type` (6 valeurs), `status`, `installment_frequency`, cohérence `type ↔ direction` (`DEBT_TYPE_DIRECTION`) ; FK différée `(user_id, origin_transaction_id)` `on delete set null (origin_transaction_id)` ; `status` recalculé à partir des paiements dans la RPC |
| `debt_payments` | FK `(user_id, debt_id)` `cascade`, `(user_id, account_id)`, `(user_id, transaction_id)` différée ; + `updated_at`, `version`, `deleted_at` |

### D.8 Patrimoine et taux

| Table | Intégrité |
|---|---|
| `assets` | CHECK `type` ; FK `(user_id, linked_account_id)` ; index unique partiel existant étendu à `deleted_at is null` |
| `asset_valuations` | FK `(user_id, asset_id)` `cascade` ; CHECK `source = 'manual'` |
| `exchange_rates` | CHECK devise, `source` ; index `(user_id, base, quote, date desc)` ; unicité `(user_id, base, quote, date)` **à décider** (le local autorise des doublons) |

### D.9 Notifications

`notification_states` : PK `(user_id, id text)` conservée ; + `version` ; pas de
`deleted_at` (état écrasable).

### D.10 Correspondance TypeScript ↔ SQL à corriger

| Domaine (TS) | SQL actuel | Cible |
|---|---|---|
| `Account.order`, `Category.order` | `sort_order` | mapping explicite `order ↔ sort_order` |
| `Transaction.attachmentId` | `attachment_path` | `attachment_id` |
| `RecurringOccurrence.id`, `.closure` | absents | `id` dérivé côté client ; `closure` ajouté |
| `ImportBatch.accountId: ID` (obligatoire) | nullable | `accountId?: ID` |
| `UserSettings.id` | absent (`user_id` PK) | `id = user_id` reconstitué par le mapping |
| `User` (Dexie `users`) | absent | `profiles` |
| `ExchangeRate.rate: number` | `numeric(20,10)` | renvoyé en nombre JSON par PostgREST : OK |
| montants `number` (entiers) | `bigint` | sûr jusqu'à 2⁵³ (`Number.isSafeInteger` déjà contrôlé) |

---

## E. Plan de migration technique (couches de persistance)

Aucune donnée Edge n'est lue, transformée ou déplacée par ce plan.

1. **Contrat** : extraire `NexoraRepository` (interface) depuis les signatures publiques
   de `LocalRepository` ; typer `AppContext`, `App`, `Onboarding` sur l'interface ;
   déplacer `ValidationError` vers `src/domain/errors.ts` (ré-export).
2. **Unit of work** : introduire `ChangeSet` + `StorageAdapter` ; transformer
   `LocalRepository` en `RepositoryCore` + `LocalAdapter` **sans changer le
   comportement** (la suite de 31 tests repository doit rester verte sans modification).
   Rendre atomiques les lectures-modifications-écritures (`addGoalContribution`,
   `addDebtPayment`, `updateDebt`).
3. **Base nommée** : `getDB(name)` ; mode local = `nexora` (inchangé), mode cloud =
   `nexora-cache-<uid>` ; garde-fou explicite : en mode cloud, toute tentative d'ouvrir
   `nexora` lève une erreur (test dédié).
4. **Schéma cloud** : convertir `schema.sql` en migrations versionnées (`0001_init`
   reprenant le brouillon, `0002_profiles`, `0003_integrity_composite_fk`, `0004_sync_columns`,
   `0005_attachments_storage`, `0006_rpc_apply_changeset`), appliquées **uniquement sur un
   projet Supabase de développement** puis testées (pgTAP).
5. **Mapping** : `src/data/cloud/mapping.ts` — une table de correspondance par entité
   (camelCase ↔ snake_case, `order ↔ sort_order`, `id` dérivés), testée en aller-retour
   sur le jeu de démonstration (toutes les entités y figurent).
6. **CloudAdapter + sync** : `commit` via RPC puis application au cache ; `pull`
   incrémental ; gestion `deleted_at`, `version`, erreurs.
7. **Auth** : `AuthProvider`, écran de connexion (24 langues), PKCE, déconnexion
   (purge du cache), sélection du backend par `VITE_DATA_BACKEND`.
8. **Sauvegarde/restauration cloud** : `exportBackup` inchangé (format JSON v1 lisible
   par les deux modes) ; `restoreBackup` en cloud = **remappage de tous les
   identifiants** (table d'équivalence ancien → nouveau, appliquée à toutes les
   références : `accountId`, `transferId`, `debtId`, `ruleId`, ids d'échéances, clés de
   notifications contenant un id…), puis un seul `ChangeSet` atomique. C'est aussi la
   brique qui servira, dans un lot ultérieur, à importer les données Edge **à partir
   d'un fichier de sauvegarde exporté par l'utilisateur** — sans accès direct à la base
   Edge.
9. **Démo** : en cloud, la démo s'exécute dans un compte dédié ou reste réservée au mode
   local (décision D11) ; `replaceWithSnapshot` passe par le même chemin que la
   restauration.

---

## F. Plan d'exécution

Chaque lot est livrable seul, sur une branche de développement (jamais la branche de
production), avec `npm test`, `npm run typecheck`, `npm run build` verts. Lots 2 à 4
n'ont **aucun effet visible** pour l'utilisateur et ne touchent pas aux données.

### Lot 2 — Contrat de repository et adaptateur de stockage (front, sans cloud)

| | |
|---|---|
| Objectifs | Interface `NexoraRepository` ; `ChangeSet` / `StorageAdapter` ; `LocalAdapter` ; `ValidationError` dans le domaine ; atomicité des lectures-modifications-écritures ; `getDB(name)` ; correction du test de fuseau. |
| Fichiers | `src/data/contracts.ts` (+), `src/data/storage.ts` (+), `src/data/local/LocalAdapter.ts` (+), `src/data/repository.ts`, `src/data/db.ts`, `src/domain/errors.ts` (+), `src/app/AppContext.tsx`, `src/App.tsx`, `src/pages/Onboarding.tsx`, `src/domain/dates.test.ts` |
| Dépendances | Aucune |
| Risques | Régression d'une opération composée lors du passage au `ChangeSet` ; ordre des écritures ; `useLiveQuery` ne se déclenche plus si l'adaptateur n'écrit pas dans une transaction Dexie. |
| Tests | Suite existante inchangée (276 + test de fuseau corrigé) ; nouveaux : un test par opération composée vérifiant le `ChangeSet` produit ; atomicité (échec simulé au milieu du commit → aucune écriture). |
| Validation | 0 test existant modifié (hors fuseau) ; `git diff` sans changement dans `src/domain/calc/` ni `src/i18n/locales/` ; e2e FR 11/11 ; schéma Dexie `nexora` v1 strictement identique. |

### Lot 3 — Schéma Supabase versionné (projet de développement uniquement)

| | |
|---|---|
| Objectifs | Migrations 0001–0005 (profils, clés composites, CHECK, index, colonnes de sync, attachments + Storage, triggers `updated_at`/`version`, `handle_new_user`) ; tests pgTAP RLS et intégrité ; types générés. |
| Fichiers | `supabase/config.toml` (+), `supabase/migrations/*.sql` (+), `supabase/tests/*.sql` (+), `src/data/cloud/database.types.ts` (+, généré) ; `supabase/schema.sql` conservé comme référence historique ou supprimé (D9). |
| Dépendances | Décisions D1, D2, D5, D9 ; projet Supabase **de développement** créé par l'utilisateur. |
| Risques | Clés composites + `set null (col)` (PG ≥ 15 requis) ; contraintes différées circulaires ; performance des politiques. |
| Tests | pgTAP : utilisateur A ne lit / ne modifie / ne référence aucune ligne de B (pour **chaque** table et **chaque** FK) ; `anon` n'accède à rien ; CHECK ; unicité budgets ; un transfert à une jambe est refusé à la validation. |
| Validation | `supabase db reset` + `supabase test db` verts en local ; avis « Security Advisor » / « Performance Advisor » Supabase sans alerte critique. |

### Lot 4 — RPC `apply_changeset` et mapping

| | |
|---|---|
| Objectifs | Fonction `apply_changeset(jsonb)` (`security invoker`, liste blanche de tables et colonnes, contrôle `version`, suppression logique, recalcul `saved_amount` / statut de dette) ; `mapping.ts`. |
| Fichiers | `supabase/migrations/0006_rpc_apply_changeset.sql` (+), `supabase/tests/apply_changeset.sql` (+), `src/data/cloud/mapping.ts` (+), `src/data/cloud/mapping.test.ts` (+) |
| Dépendances | Lots 2 et 3 |
| Risques | Injection via noms de colonnes (→ liste blanche stricte) ; conversions de types ; taille des lots d'import (limiter / découper). |
| Tests | Aller-retour mapping sur toutes les entités du jeu de démo ; RPC : idempotence (même `ChangeSet` rejoué), conflit de version, rejet d'un `user_id` étranger. |
| Validation | Démo complète écrite via RPC puis relue : `DataSnapshot` identique (hors horodatages serveur) ; mêmes totaux de dashboard (test existant `les totaux du dashboard correspondent…` réexécuté sur les données relues). |

### Lot 5 — CloudAdapter, cache par utilisateur et synchronisation

| | |
|---|---|
| Objectifs | `CloudAdapter.commit` (RPC → cache) ; `pull` initial et incrémental ; `_sync` ; reprise au premier plan / réseau ; mode hors ligne en lecture seule. |
| Fichiers | `src/data/cloud/CloudAdapter.ts` (+), `src/data/cloud/sync.ts` (+), `src/data/cloud/supabaseClient.ts` (+), `src/data/db.ts`, `package.json` (`@supabase/supabase-js`) |
| Dépendances | Lot 4 ; D4, D6, D7 |
| Risques | Désynchronisation cache/serveur ; horloges (toujours utiliser `updated_at` serveur) ; écriture accidentelle dans `nexora`. |
| Tests | **Tests de contrat** : la suite `repository.test.ts` exécutée contre `LocalAdapter` et contre `CloudAdapter` (Supabase local) ; deux clients simulés (deux appareils) : création sur A visible sur B après pull, suppression propagée, conflit détecté ; garde-fou « base `nexora` jamais ouverte en mode cloud ». |
| Validation | Suite de contrat verte sur les deux adaptateurs ; aucune différence de calcul. |

### Lot 6 — Authentification et profils (UI)

| | |
|---|---|
| Objectifs | `AuthProvider`, écrans connexion / inscription / mot de passe oublié / déconnexion, PKCE avec `HashRouter`, onboarding cloud (profil + paramètres + catégories initiales + premier compte en un `ChangeSet`), sélection `VITE_DATA_BACKEND`. |
| Fichiers | `src/app/AuthProvider.tsx` (+), `src/pages/SignIn.tsx` (+), `src/App.tsx`, `src/app/AppContext.tsx`, `src/pages/Onboarding.tsx`, `src/pages/Settings.tsx` (section compte), `src/i18n/locales/*.ts` (nouvelles clés `auth.*` dans les 24 langues), `.env.example` |
| Dépendances | Lot 5 ; D3, D8 |
| Risques | Boucle de redirection ; jetons dans l'URL ; textes manquants dans une langue (bloqué par le typage `Messages`) ; RTL. |
| Tests | `i18n.test.ts` étendu automatiquement ; e2e : inscription → onboarding → saisie → déconnexion → reconnexion sur un second contexte navigateur (données retrouvées) ; mode `local` : e2e FR 11/11 inchangé. |
| Validation | Deux comptes de test isolés ; aucun accès `anon` ; production toujours en mode `local`. |

### Lot 7 — Sauvegarde/restauration cloud et pièces jointes

| | |
|---|---|
| Objectifs | Restauration avec remappage des identifiants ; export identique dans les deux modes ; pièces jointes via Storage (envoi, URL signée, suppression en cascade). |
| Fichiers | `src/data/backup.ts` (+, extrait de `repository.ts`), `src/data/cloud/attachments.ts` (+), `src/pages/Settings.tsx`, `src/features/transactions/TransactionForm.tsx` |
| Dépendances | Lots 5 et 6 ; D11 |
| Risques | Références oubliées lors du remappage (ids contenus dans des clés textuelles : échéances, notifications) ; fichiers orphelins dans Storage. |
| Tests | Sauvegarde du jeu de démo restaurée deux fois dans deux comptes sans collision ; totaux identiques avant/après ; une pièce jointe d'un utilisateur inaccessible à un autre. |
| Validation | Format de sauvegarde v1 relu par les deux modes ; prêt pour le lot « migration des données Edge » (non inclus). |

### Lot 8 — Durcissement et mise en service (sur décision)

CI GitHub Actions (typecheck, tests, pgTAP), outil de couverture, en-têtes CSP
(`connect-src` Supabase) dans `netlify.toml`, supervision, activation progressive du
mode cloud par contexte Netlify, documentation (`ARCHITECTURE.md` § 7 et § 9).

**Ordre et parallélisme** : 2 → (3 ∥ préparation projet Supabase) → 4 → 5 → 6 → 7 → 8.
Le lot 3 peut démarrer en parallèle du lot 2.

---

## G. Décisions techniques à valider avant toute implémentation

| # | Décision | Options | Recommandation |
|---|---|---|---|
| **D1** | Unité d'isolation | (a) `user_id` seul ; (b) `workspace_id` dès maintenant (foyers, comptes partagés, SaaS) | **(a)**, conforme à la demande ; politiques regroupées dans une fonction unique pour faciliter une évolution vers (b). Évolution vers des espaces partagés = migration lourde : à trancher maintenant si c'est envisagé à moyen terme. |
| **D2** | Où vivent les règles d'écriture | (a) TypeScript (`RepositoryCore`) + RPC générique `apply_changeset` + contraintes SQL ; (b) une RPC PL/pgSQL par opération composée | **(a)** : aucune duplication des règles, calculs préservés ; le serveur garantit isolation et invariants. |
| **D3** | Méthodes d'authentification | e-mail + mot de passe, lien magique, OAuth (Google, Apple) | e-mail + mot de passe et lien magique ; OAuth plus tard. Confirmation d'e-mail obligatoire. |
| **D4** | Hors ligne | (a) lecture seule hors ligne ; (b) file d'attente d'écritures (outbox) avec rejeu | **(a)** au premier jalon ; (b) dans un lot ultérieur si besoin réel. |
| **D5** | Création des catégories initiales | client (dans la langue de l'utilisateur, via `buildSeedCategories`) ou trigger SQL | client, dans le `ChangeSet` d'onboarding. |
| **D6** | Cache à la déconnexion | supprimé / conservé | supprimé (appareils partagés). |
| **D7** | Propagation multi-appareils | pull périodique / Supabase Realtime | pull (au premier plan + 60 s) ; Realtime optionnel. |
| **D8** | Mode de la production | `local` jusqu'à validation complète / bascule directe | `local` ; cloud activé d'abord sur un contexte d'aperçu Netlify. |
| **D9** | Projet Supabase | Existe-t-il déjà une instance (et le brouillon y a-t-il été exécuté) ? Région (UE pour le RGPD ?) ; projets dev / prod séparés ; sort de `schema.sql` | Deux projets (dev, prod), région UE ; `schema.sql` remplacé par les migrations. |
| **D10** | Branches et environnement | `nexora-dev` (existante, `341f3da`, avec `.devcontainer/`) comme branche de développement ; production = `claude/nexora-finance-platform-81blaa` | ✅ Retenu : `nexora-dev` = branche de développement principale ; aucun push avant vérification de la configuration Netlify. |
| **D11** | Démo en mode cloud | réservée au mode local / compte de démonstration dédié / bouton « démo » écrivant dans le compte | réservée au mode local au premier jalon. |
| **D12** | Unicité des taux de change `(user, base, quote, date)` | imposer / laisser les doublons | imposer (le calcul prend de toute façon le dernier taux daté). |
| **D13** | Suppressions | suppression logique `deleted_at` + purge / journal `deletions` séparé | `deleted_at` + purge planifiée. |
| **D14** | Pièces jointes | Storage privé + URL signées ; quota par utilisateur ; inclusion dans la sauvegarde | Storage privé, 10 Mo / fichier, hors sauvegarde JSON (inchangé). |

Une fois ces décisions validées, le Lot 2 peut démarrer : il ne dépend d'aucune d'elles,
sauf D10 (choix de la branche de travail).
