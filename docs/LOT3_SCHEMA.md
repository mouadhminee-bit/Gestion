# NEXORA — Lot 3 : schéma PostgreSQL / Supabase versionné — RAPPORT

*Réalisé le 01/11/2026 sur `claude/stoic-edison-8s0vhq`, selon `docs/LOT3_PLAN.md` et les
décisions D3-1 à D3-9 validées. Aucune connexion à Supabase, aucun projet créé, aucune
base existante touchée, aucun fichier `src/` modifié.*

## 1. Livrables

| Livrable | Emplacement |
|---|---|
| Migrations versionnées (6) | `supabase/migrations/20261101000100_conventions.sql` … `…000600_rls_grants.sql` |
| Schéma PostgreSQL complet (export `pg_dump --schema-only` après application des migrations) | `docs/LOT3_SCHEMA_DUMP.sql` |
| Matrice TypeScript ↔ PostgreSQL (vérifiée par script : 0 écart) | § 9 de ce rapport |
| Tests SQL (8 fichiers, 1 057 assertions) | `supabase/db-tests/` |
| Exécution sur base éphémère | `npm run test:db` (`scripts/db-test.sh`) |
| Configuration CLI locale | `supabase/config.toml` |
| Registre des réserves (mis à jour) | `docs/SUIVI_TECHNIQUE.md` |

## 2. Fichiers créés et modifiés

| Fichier | Statut |
|---|---|
| `supabase/migrations/20261101000100_conventions.sql` | créé — schéma `private`, déclencheur générique `tg_sync_metadata` |
| `supabase/migrations/20261101000200_profiles_settings.sql` | créé — `profiles`, `user_settings` |
| `supabase/migrations/20261101000300_core_tables.sql` | créé — 15 tables métier + `attachments`, contraintes CHECK |
| `supabase/migrations/20261101000400_relations.sql` | créé — 25 clés composites différées, 2 unicités différées, index |
| `supabase/migrations/20261101000500_triggers.sql` | créé — 18 déclencheurs de métadonnées, `handle_new_user` |
| `supabase/migrations/20261101000600_rls_grants.sql` | créé — RLS forcée, 53 politiques, privilèges |
| `supabase/db-tests/shim/auth_shim.sql` | créé — émulation Supabase **réservée aux tests** (jamais appliquée à Supabase) |
| `supabase/db-tests/_setup.sql`, `01_…` à `08_…` | créés — outillage et tests |
| `supabase/config.toml` | créé — sans secret |
| `scripts/db-test.sh` | créé — cluster éphémère, migrations, tests, destruction |
| `docs/LOT3_SCHEMA.md`, `docs/LOT3_SCHEMA_DUMP.sql` | créés |
| `package.json` | modifié — script `"test:db"` (aucune dépendance) |
| `supabase/schema.sql` | modifié — **en-tête « archive » uniquement** (D3-5), contenu inchangé |
| `docs/SUIVI_TECHNIQUE.md` | modifié — points P6 à P9 |

Inchangés : tout `src/` (diff vide), `netlify.toml`, `package-lock.json`, dépendances.

## 3. Schéma

18 tables dans `public` : `profiles`, `user_settings`, `accounts`, `categories`,
`import_batches`, `transactions`, `attachments`, `budgets`, `savings_goals`,
`goal_contributions`, `recurring_rules`, `recurring_occurrences`, `debts`, `debt_payments`,
`assets`, `asset_valuations`, `exchange_rates`, `notification_states`. Aucune vue, aucune
fonction dans `public`. Deux fonctions dans `private` (non exposé).

* **Colonnes** : exactement les champs TypeScript (matrice § 9) + 4 métadonnées serveur
  `version`, `sync_txid` (`xid8`), `server_updated_at`, `deleted_at`. `created_at` /
  `updated_at` n'existent que là où le type TS les porte, et gardent la valeur du client.
* **Types** : montants `bigint` ; taux et taux d'intérêt `double precision` (restitution
  exacte des nombres JavaScript, testée avec `0.30000000000000004`) ; dates métier `date` ;
  horodatages `timestamptz` (restitution à la milliseconde au format `toISOString`, testée).
* **Relations** : 25 clés étrangères composites `(user_id, x) → parent (user_id, id)`, toutes
  `deferrable initially deferred`, `on delete no action` ; 17 clés `user_id → auth.users
  on delete cascade`. Exception : `transactions.attachment_id` sans clé étrangère.
* **Unicités** (lignes actives seulement, différées) : un budget par (mois, catégorie) —
  budget global compris ; un actif actif par compte valorisé. Contraintes d'**exclusion**
  différées, car un index unique partiel ne peut pas être différé : l'ordre des écritures
  d'un lot reste indifférent.
* **Déclencheurs** : `private.tg_sync_metadata(colonnes immuables…)` sur les 18 tables ;
  `private.handle_new_user()` sur `auth.users` (crée le profil uniquement).

## 4. Politiques RLS et privilèges

| Table(s) | RLS | Politiques (rôle `authenticated` uniquement) | Privilèges `authenticated` | `anon` |
|---|---|---|---|---|
| 17 tables portant `user_id` | activée + **forcée** | `<table>_select_own` : `using (user_id = (select auth.uid()))` · `<table>_insert_own` : `with check (user_id = (select auth.uid()))` · `<table>_update_own` : `using` et `with check` identiques · **aucune politique de suppression** | `SELECT`, `INSERT`, `UPDATE` ; **révoqués** : `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER` | aucun |
| `profiles` | activée + forcée | `profiles_select_own`, `profiles_update_own` : `id = (select auth.uid())` | `SELECT` ; `UPDATE (display_name)` seulement | aucun |
| schéma `private` | — | — | aucun usage, aucune exécution | aucun |

Garanties vérifiées par les tests (§ 6) :

* un utilisateur ne lit, ne modifie, ne supprime ni ne vide aucune ligne d'autrui ; il ne
  peut ni insérer au nom d'autrui, ni transférer sa ligne (`user_id` immuable — par la RLS
  **et** par le déclencheur, chacun testé séparément), ni écraser une ligne d'autrui par
  upsert ;
* il ne peut référencer aucune ligne d'autrui (25 clés étrangères, contrôle positif à
  chaque fois) ;
* la suppression physique est impossible côté client (`DELETE` et `TRUNCATE` refusés, y
  compris sur ses propres lignes) ;
* seule `private.handle_new_user` est `SECURITY DEFINER` : `search_path` vide, noms
  qualifiés, non exécutable par les clients, fonction de déclencheur (non appelable) ;
* un client sans identifiant (`auth.uid()` nul) ne voit rien ; `anon` n'accède à rien.

## 5. Suppression logique et synchronisation

**`deleted_at`**

| Opération | Effet |
|---|---|
| Supprimer | `deleted_at` renseigné ; **horodatage du serveur** (valeur du client ignorée) ; `version` + 1 ; la ligne reste lisible par son propriétaire (tombstone pour la synchronisation) |
| Supprimer à nouveau | la date d'origine est conservée |
| Propagation | **aucune propagation automatique** : les suppressions en cascade (contributions d'un objectif, échéances d'une règle, valorisations d'un actif, jambes d'un transfert…) sont décidées par `RepositoryCore` et arrivent comme des suppressions explicites |
| Référencer une ligne supprimée | autorisé (comme le domaine, qui tolère les références pendantes) |
| Restaurer | réécrire la ligne avec `deleted_at` nul ; `version` continue ; les unicités sont revérifiées |
| Supprimer physiquement | impossible pour le client ; uniquement par suppression du compte (cascade, tombstones compris). Purge des tombstones : non développée (Lot 8, P5) |

**Synchronisation** — chaque écriture enregistre `sync_txid = pg_current_xact_id()`. La
récupération de référence (`tests.pull`, prototype du Lot 5, **non livré dans le schéma**)
calcule d'abord `borne = pg_snapshot_xmin(pg_current_snapshot())`, puis renvoie les lignes
`curseur ≤ sync_txid < borne` ; le nouveau curseur vaut la borne. Toute transaction
d'identifiant inférieur à la borne est terminée : sa visibilité ne peut plus changer.

| Scénario exigé | Résultat |
|---|---|
| Deux transactions validées dans l'ordre inverse de leur démarrage | ✅ la ligne validée en premier est différée tant que l'autre est en cours, puis les deux sont récupérées ; **contrôle négatif** : un curseur sur l'horodatage aurait perdu la ligne |
| Démarrage (`BEGIN`) avant, première écriture après | ✅ |
| Transaction annulée | ✅ ni l'insertion ni la modification annulées n'apparaissent ; le curseur avance ensuite |
| Modifications successives d'une même ligne | ✅ pendant une transaction en cours, le client a la dernière version validée ; ensuite l'état final, version identique au serveur |
| Suppression logique, puis restauration | ✅ tombstone récupéré, réactivation récupérée |
| Récupération sans perte après actualisation du curseur | ✅ cache incrémental = état du serveur ; récupération complète depuis 0 = état du serveur |
| Entrelacements pseudo-aléatoires (3 écrivains, 300 étapes, validations / annulations / récupérations, graine fixe) | ✅ cache = serveur, 0 ligne manquante |
| **Mutation** : borne `pg_snapshot_xmax` au lieu de `xmin` | ❌ 4 tests de synchronisation échouent (perte détectée) |

## 6. Résultats des tests SQL

`npm run test:db` — PostgreSQL 16.15, cluster éphémère dans `/tmp` (socket Unix seule,
aucun port TCP), détruit à la fin.

| Fichier | Assertions | Échecs | Contenu |
|---|---|---|---|
| `01_catalog.sql` | 556 | 0 | RLS forcée sur 18/18 tables ; privilèges `anon` (7 × 18) et `authenticated` (4 × 18) ; colonnes serveur, déclencheur et index de récupération sur chaque table ; `user_id not null` + cascade ; politiques (53, toutes `authenticated` + `auth.uid()`) ; 25 clés composites différées ; 0 vue, 0 fonction dans `public` |
| `02_isolation.sql` | 297 | 0 | matrice par table (lecture, modification, DELETE, TRUNCATE, insertion au nom d'autrui + contrôle positif, transfert de propriété, upsert sur la clé d'autrui, lignes d'autrui inchangées) ; matrice des 25 clés (refus + contrôle positif) ; `anon` sur 18 tables ; client sans identifiant ; collision d'UUID |
| `03_triggers.sql` | 20 | 0 | métadonnées serveur imposées malgré les valeurs du client ; horodatages métier conservés à la milliseconde ; immutabilité (en client et en administrateur) |
| `04_constraints.sql` | 101 | 0 | 41 cas **acceptés** (dont ceux que le brouillon aurait rejetés) ; 58 cas **refusés** (valeurs exclues par les types) ; restitution exacte des nombres |
| `05_relations.sql` | 7 | 0 | références circulaires dans les deux ordres ; références pendantes refusées à la validation ; `attachment_id` libre |
| `06_soft_delete.sql` | 16 | 0 | règles du § 5 ; unicités sur lignes actives ; séquence de restauration de sauvegarde |
| `07_sync.sql` | 16 | 0 | scénarios du § 5 ; récupération soumise à la RLS |
| `08_lifecycle.sql` | 44 | 0 | inscription (profil seul) ; profils ; suppression du compte (17 tables vidées, autre utilisateur intact) ; fonctions privilégiées |
| **Total** | **1 057** | **0** | |

**Contrôles par mutation** (copie jetable sous `/tmp`, schéma volontairement cassé) :

| Mutation | Détection |
|---|---|
| M1 RLS non forcée sur `transactions` | ✅ 1 échec (catalogue) |
| M2 politique de lecture `using (true)` sur `budgets` | ✅ 3 échecs (catalogue, isolation) |
| M3 clé étrangère simple sur `transactions.account_id` | ✅ 2 échecs (catalogue, référence inter-utilisateurs acceptée) |
| M4 `DELETE` accordé à `authenticated` | ✅ 51 échecs |
| M5 privilèges Supabase par défaut non révoqués (`TRUNCATE`…) | ✅ 119 échecs |
| M6 `sync_txid` non mis à jour lors des modifications | ✅ 6 échecs (déclencheurs, synchronisation) |
| M7 `user_id` retiré des colonnes immuables | ✅ 1 échec (test administrateur ajouté : avant, la RLS masquait seule le problème) |
| M8 contrainte trop stricte (libellé ≤ 140) | ✅ 1 échec (compatibilité domaine) |
| M9 borne `pg_snapshot_xmax` au lieu de `xmin` | ✅ 4 échecs (synchronisation) |
| M10 clé `debts.origin_transaction_id` non différée | ✅ suite interrompue (l'écriture circulaire du jeu de test échoue) |
| M11 fonction `SECURITY DEFINER` exposée dans `public` | ✅ 2 échecs |

**Destruction du cluster** : le script supprime le répertoire dans tous les cas (trap) et
le confirme (« Cluster temporaire détruit »). Vérifié après chaque exécution : aucun
répertoire `/tmp/nexora-pgtest.*` résiduel ; le cluster système de la machine
(`/etc/postgresql/16`, non démarré) n'a pas été utilisé.

**Application** : `npm run check` → 13 fichiers, **314/314** tests, build OK (aucun fichier
`src/` modifié).

## 7. Écarts par rapport au plan

| # | Écart | Justification |
|---|---|---|
| E1 | `handle_new_user` ne crée **que** le profil, pas `user_settings` | `ensureUser` ne crée paramètres + catégories initiales que si les paramètres sont absents : un `user_settings` pré-créé empêcherait la création des catégories (testé) |
| E2 | `created_at` / `updated_at` uniquement sur les tables dont le type TS les porte | exigence de la matrice : chaque colonne = un champ TS ou une métadonnée serveur |
| E3 | `attachments` sans `transaction_id` ni `storage_path` | le type `Attachment` n'a pas de `transactionId` ; le chemin Storage est dérivable (`<user_id>/<id>`) |
| E4 | Pas d'unicité `(user_id, key)` sur `categories` | inutile à toute logique serveur ; risque de rejeter des données existantes |
| E5 | Unicités par contraintes d'exclusion différées (au lieu d'index uniques partiels) | ordre des écritures d'un lot indifférent (ex. budget supprimé puis recréé) |
| E6 | Tests dans `supabase/db-tests/` (au lieu de `supabase/tests/`) | `supabase test db` exécute `supabase/tests/` avec pgTAP : nos tests SQL y échoueraient |
| E7 | `debts.principal ≥ 0` (et non `> 0`), `debts.label` sans contrainte | `updateDebt` accepte un principal nul et ne valide pas le libellé |
| E8 | Réglages numériques (`bill_reminder_days`, seuils, `custom_interval`) en `double precision`, sans bornes | `updateSettings` ne valide rien ; `saveRecurringRule` ne vérifie que « ≥ 1 » |
| E9 | Extension `pgcrypto` non utilisée | aucun identifiant généré côté serveur (UUID du client) |
| E10 | Défaut détecté et corrigé pendant le lot : `check (… or custom_interval >= 1)` laissait passer `null` (en SQL, `null >= 1` n'est pas faux) | corrigé en `coalesce(custom_interval, 0) >= 1` ; couvert par un test |

## 8. Limites et points à valider

* **Fidélité de l'émulation** : `auth.users`, `auth.uid()`, rôles et privilèges par défaut
  reproduisent Supabase, mais la validation sur la vraie pile reste à faire (étape 3b :
  `supabase start` dans Codespaces, puis `supabase db reset` ; les tests SQL se lancent avec
  `psql` sans l'émulation). `config.toml` fixe `major_version = 15` : à aligner sur le projet.
* **Restauration de sauvegarde** (P6) : `restoreBackup` ne valide aucune ligne ; le schéma
  refuse une ligne qui viole les types du domaine (sauvegarde corrompue ou modifiée à la
  main). Une validation des sauvegardes avant écriture est à prévoir (Lot 7, avec R1).
* **Existence d'un UUID** (P7) : réutiliser l'UUID d'une ligne d'autrui provoque une
  collision de clé (23505) sans accès aux données ; risque négligeable (UUID aléatoires),
  supprimé si R1 conduit à des clés `(user_id, id)`.
* **Liveness du curseur** (P8) : une transaction longue retient la borne (aucune perte,
  mais retard de récupération pour tous) ; les écritures applicatives seront courtes (Lot 4).
* **`version`** compte les mises à jour de ligne (deux modifications dans une transaction
  = + 2) ; le contrôle de conflit (Lot 4, R3) ne compare que l'égalité.
* **`service_role`** contourne la RLS par conception (Supabase) : sa clé ne doit jamais
  quitter le serveur.
* **Données Edge** (P3) : les références orphelines issues de suppressions physiques en
  IndexedDB seront refusées par les clés étrangères : détection et réparation avant migration.

## 9. Matrice TypeScript ↔ PostgreSQL

Générée et vérifiée automatiquement à partir de `src/domain/types.ts` et du schéma exporté :
**0 champ sans colonne, 0 colonne sans champ (hors métadonnées serveur), 0 champ facultatif
associé à une colonne `NOT NULL`.** Les contraintes de chaque colonne figurent dans
`docs/LOT3_SCHEMA_DUMP.sql` et sont testées par `04_constraints.sql`.

### `User` → `public.profiles`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` | PK = auth.users.id |
| `displayName` | `string` | `display_name` | `text DEFAULT ''::text NOT NULL` |  |
| `email?` | `string` | — | `—` | non stocké : lu dans auth.users.email |
| `createdAt` | `string` | `created_at` | `timestamp with time zone DEFAULT now() NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `UserSettings` → `public.user_settings`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | — | `—` | dérivé : = user_id (mapping Lot 4) |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `displayName` | `string` | `display_name` | `text NOT NULL` |  |
| `baseCurrency` | `CurrencyCode` | `base_currency` | `text NOT NULL` |  |
| `language` | `Lang` | `language` | `text NOT NULL` |  |
| `locale` | `string` | `locale` | `text NOT NULL` |  |
| `timeZone` | `string` | `time_zone` | `text NOT NULL` |  |
| `dateFormat` | `DateFormat` | `date_format` | `text NOT NULL` |  |
| `weekStartsOn` | `1 ∣ 0` | `week_starts_on` | `smallint NOT NULL` |  |
| `theme` | `ThemeMode` | `theme` | `text NOT NULL` |  |
| `currencyDisplay` | `CurrencyDisplay` | `currency_display` | `text NOT NULL` |  |
| `privacyMode` | `boolean` | `privacy_mode` | `boolean NOT NULL` |  |
| `budgetAlertThresholds` | `number[]` | `budget_alert_thresholds` | `double precision[] NOT NULL` |  |
| `notifyBudgets` | `boolean` | `notify_budgets` | `boolean NOT NULL` |  |
| `notifyBills` | `boolean` | `notify_bills` | `boolean NOT NULL` |  |
| `notifyDebts` | `boolean` | `notify_debts` | `boolean NOT NULL` |  |
| `billReminderDays` | `number` | `bill_reminder_days` | `double precision NOT NULL` |  |
| `onboarded` | `boolean` | `onboarded` | `boolean NOT NULL` |  |
| `demoMode` | `boolean` | `demo_mode` | `boolean NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Account` → `public.accounts`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `name` | `string` | `name` | `text NOT NULL` |  |
| `type` | `AccountType` | `type` | `text NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `initialBalance` | `number` | `initial_balance` | `bigint NOT NULL` |  |
| `initialBalanceDate` | `ISODate` | `initial_balance_date` | `date NOT NULL` |  |
| `archived` | `boolean` | `archived` | `boolean NOT NULL` |  |
| `includeInTotal` | `boolean` | `include_in_total` | `boolean NOT NULL` |  |
| `color` | `string` | `color` | `text NOT NULL` |  |
| `description?` | `string` | `description` | `text` |  |
| `order` | `number` | `sort_order` | `integer NOT NULL` | `order` est un mot réservé SQL |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Category` → `public.categories`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `name` | `string` | `name` | `text NOT NULL` |  |
| `kind` | `CategoryKind` | `kind` | `text NOT NULL` |  |
| `nature?` | `ExpenseNature` | `nature` | `text` |  |
| `parentId` | `ID ∣ null` | `parent_id` | `uuid` |  |
| `icon` | `string` | `icon` | `text NOT NULL` |  |
| `color` | `string` | `color` | `text NOT NULL` |  |
| `archived` | `boolean` | `archived` | `boolean NOT NULL` |  |
| `order` | `number` | `sort_order` | `integer NOT NULL` | `order` est un mot réservé SQL |
| `key?` | `string` | `key` | `text` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Transaction` → `public.transactions`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `type` | `TransactionType` | `type` | `text NOT NULL` |  |
| `direction` | `Direction` | `direction` | `text NOT NULL` |  |
| `amount` | `number` | `amount` | `bigint NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `label` | `string` | `label` | `text NOT NULL` |  |
| `date` | `ISODate` | `date` | `date NOT NULL` |  |
| `categoryId` | `ID ∣ null` | `category_id` | `uuid` |  |
| `subcategoryId` | `ID ∣ null` | `subcategory_id` | `uuid` |  |
| `accountId` | `ID` | `account_id` | `uuid NOT NULL` |  |
| `paymentMethod?` | `PaymentMethod` | `payment_method` | `text` |  |
| `payee?` | `string` | `payee` | `text` |  |
| `notes?` | `string` | `notes` | `text` |  |
| `tags` | `string[]` | `tags` | `text[] NOT NULL` |  |
| `attachmentId?` | `ID` | `attachment_id` | `uuid` |  |
| `status` | `TransactionStatus` | `status` | `text NOT NULL` |  |
| `transferId?` | `ID` | `transfer_id` | `uuid` |  |
| `counterpartAccountId?` | `ID` | `counterpart_account_id` | `uuid` |  |
| `refundOfId?` | `ID` | `refund_of_id` | `uuid` |  |
| `debtId?` | `ID` | `debt_id` | `uuid` |  |
| `debtPaymentId?` | `ID` | `debt_payment_id` | `uuid` |  |
| `interestAmount?` | `number` | `interest_amount` | `bigint` |  |
| `recurringRuleId?` | `ID` | `recurring_rule_id` | `uuid` |  |
| `recurringDueDate?` | `ISODate` | `recurring_due_date` | `date` |  |
| `importBatchId?` | `ID` | `import_batch_id` | `uuid` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Attachment` → `public.attachments`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `name` | `string` | `name` | `text NOT NULL` |  |
| `mimeType` | `string` | `mime_type` | `text NOT NULL` |  |
| `size` | `number` | `size` | `integer NOT NULL` |  |
| `blob` | `Blob` | — | `—` | fichier → Supabase Storage (Lot 7), chemin dérivable <user_id>/<id> |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `ImportBatch` → `public.import_batches`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `fileName` | `string` | `file_name` | `text NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `rowCount` | `number` | `row_count` | `integer NOT NULL` |  |
| `importedCount` | `number` | `imported_count` | `integer NOT NULL` |  |
| `skippedCount` | `number` | `skipped_count` | `integer NOT NULL` |  |
| `accountId` | `ID` | `account_id` | `uuid NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Budget` → `public.budgets`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `month` | `MonthKey` | `month` | `character(7) NOT NULL` |  |
| `categoryId` | `ID ∣ null` | `category_id` | `uuid` |  |
| `amount` | `number` | `amount` | `bigint NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `alertThresholds?` | `number[]` | `alert_thresholds` | `double precision[]` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `SavingsGoal` → `public.savings_goals`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `name` | `string` | `name` | `text NOT NULL` |  |
| `description?` | `string` | `description` | `text` |  |
| `targetAmount` | `number` | `target_amount` | `bigint NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `savedAmount` | `number` | `saved_amount` | `bigint NOT NULL` |  |
| `targetDate?` | `ISODate` | `target_date` | `date` |  |
| `priority` | `GoalPriority` | `priority` | `text NOT NULL` |  |
| `linkedAccountId?` | `ID` | `linked_account_id` | `uuid` |  |
| `trackLinkedAccount` | `boolean` | `track_linked_account` | `boolean NOT NULL` |  |
| `monthlyContribution?` | `number` | `monthly_contribution` | `bigint` |  |
| `status` | `GoalStatus` | `status` | `text NOT NULL` |  |
| `icon` | `string` | `icon` | `text NOT NULL` |  |
| `color` | `string` | `color` | `text NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `GoalContribution` → `public.goal_contributions`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `goalId` | `ID` | `goal_id` | `uuid NOT NULL` |  |
| `date` | `ISODate` | `date` | `date NOT NULL` |  |
| `amount` | `number` | `amount` | `bigint NOT NULL` |  |
| `note?` | `string` | `note` | `text` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `RecurringRule` → `public.recurring_rules`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `kind` | `'expense' ∣ 'income'` | `kind` | `text NOT NULL` |  |
| `label` | `string` | `label` | `text NOT NULL` |  |
| `amount` | `number` | `amount` | `bigint NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `accountId` | `ID` | `account_id` | `uuid NOT NULL` |  |
| `categoryId` | `ID ∣ null` | `category_id` | `uuid` |  |
| `subcategoryId?` | `ID ∣ null` | `subcategory_id` | `uuid` |  |
| `payee?` | `string` | `payee` | `text` |  |
| `frequency` | `Frequency` | `frequency` | `text NOT NULL` |  |
| `customInterval?` | `number` | `custom_interval` | `double precision` |  |
| `customUnit?` | `CustomUnit` | `custom_unit` | `text` |  |
| `startDate` | `ISODate` | `start_date` | `date NOT NULL` |  |
| `endDate?` | `ISODate` | `end_date` | `date` |  |
| `active` | `boolean` | `active` | `boolean NOT NULL` |  |
| `notes?` | `string` | `notes` | `text` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `RecurringOccurrence` → `public.recurring_occurrences`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | — | `—` | dérivé : "<ruleId>:<dueDate>" (clé primaire = rule_id, due_date) |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `ruleId` | `ID` | `rule_id` | `uuid NOT NULL` |  |
| `dueDate` | `ISODate` | `due_date` | `date NOT NULL` |  |
| `status` | `OccurrenceStatus` | `status` | `text NOT NULL` |  |
| `transactionId?` | `ID` | `transaction_id` | `uuid` |  |
| `closure?` | `'waived'` | `closure` | `text` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Debt` → `public.debts`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `label` | `string` | `label` | `text NOT NULL` |  |
| `type` | `DebtType` | `type` | `text NOT NULL` |  |
| `direction` | `DebtDirection` | `direction` | `text NOT NULL` |  |
| `principal` | `number` | `principal` | `bigint NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `startDate` | `ISODate` | `start_date` | `date NOT NULL` |  |
| `dueDate?` | `ISODate` | `due_date` | `date` |  |
| `counterparty?` | `string` | `counterparty` | `text` |  |
| `interestRate?` | `number` | `interest_rate` | `double precision` |  |
| `installmentAmount?` | `number` | `installment_amount` | `bigint` |  |
| `installmentFrequency?` | `'monthly' ∣ 'quarterly' ∣ 'annual'` | `installment_frequency` | `text` |  |
| `status` | `DebtStatus` | `status` | `text NOT NULL` |  |
| `notes?` | `string` | `notes` | `text` |  |
| `originTransactionId?` | `ID` | `origin_transaction_id` | `uuid` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `DebtPayment` → `public.debt_payments`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `debtId` | `ID` | `debt_id` | `uuid NOT NULL` |  |
| `date` | `ISODate` | `date` | `date NOT NULL` |  |
| `principal` | `number` | `principal` | `bigint NOT NULL` |  |
| `interest` | `number` | `interest` | `bigint NOT NULL` |  |
| `accountId?` | `ID` | `account_id` | `uuid` |  |
| `transactionId?` | `ID` | `transaction_id` | `uuid` |  |
| `note?` | `string` | `note` | `text` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `Asset` → `public.assets`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| `name` | `string` | `name` | `text NOT NULL` |  |
| `type` | `AssetType` | `type` | `text NOT NULL` |  |
| `currency` | `CurrencyCode` | `currency` | `text NOT NULL` |  |
| `linkedAccountId?` | `ID` | `linked_account_id` | `uuid` |  |
| `archived` | `boolean` | `archived` | `boolean NOT NULL` |  |
| `notes?` | `string` | `notes` | `text` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `AssetValuation` → `public.asset_valuations`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `assetId` | `ID` | `asset_id` | `uuid NOT NULL` |  |
| `date` | `ISODate` | `date` | `date NOT NULL` |  |
| `value` | `number` | `value` | `bigint NOT NULL` |  |
| `source` | `'manual'` | `source` | `text NOT NULL` |  |
| `note?` | `string` | `note` | `text` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `ExchangeRate` → `public.exchange_rates`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `ID` | `id` | `uuid NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `base` | `CurrencyCode` | `base` | `text NOT NULL` |  |
| `quote` | `CurrencyCode` | `quote` | `text NOT NULL` |  |
| `rate` | `number` | `rate` | `double precision NOT NULL` |  |
| `date` | `ISODate` | `date` | `date NOT NULL` |  |
| `source` | `'manual'` | `source` | `text NOT NULL` |  |
| `createdAt` | `string` | `created_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |

### `NotificationState` → `public.notification_states`

| Champ TypeScript | Type TS | Colonne | Type SQL | Remarque |
|---|---|---|---|---|
| `id` | `string` | `id` | `text NOT NULL` |  |
| `userId` | `ID` | `user_id` | `uuid NOT NULL` |  |
| `read` | `boolean` | `read` | `boolean NOT NULL` |  |
| `dismissed` | `boolean` | `dismissed` | `boolean NOT NULL` |  |
| `updatedAt` | `string` | `updated_at` | `timestamp with time zone NOT NULL` |  |
| — | — | `version` | `bigint DEFAULT 1 NOT NULL` | métadonnée serveur |
| — | — | `sync_txid` | `xid8 DEFAULT pg_current_xact_id() NOT NULL` | métadonnée serveur |
| — | — | `server_updated_at` | `timestamp with time zone DEFAULT now() NOT NULL` | métadonnée serveur |
| — | — | `deleted_at` | `timestamp with time zone` | métadonnée serveur |
