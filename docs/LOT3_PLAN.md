# NEXORA — Lot 3 : schéma PostgreSQL / Supabase versionné — PROPOSITION

*Cadrage du 31/10/2026, en attente d'approbation explicite. Aucune implémentation, aucune
connexion à Supabase, aucun projet créé, aucun schéma modifié, aucune donnée touchée.*

Références : `docs/AUDIT_LOT1_CLOUD.md` (§ B, C, D), `docs/LOT2_REPOSITORY.md`,
`docs/SUIVI_TECHNIQUE.md` (réserves R1–R3).

---

## 1. Objectif

Produire le **schéma cible versionné** de NEXORA sous forme de migrations Supabase,
**sécurisé** (RLS forcée, clés étrangères composites, aucun privilège dangereux) et
**prêt pour la synchronisation** (version, suppression logique, marqueur de changement
fiable). Le schéma doit accepter **toutes** les données que le domaine TypeScript
considère valides, sans aucune contrainte plus stricte que lui. Il est validé par des
tests SQL automatisés, exécutés sur une base PostgreSQL **éphémère et locale**.

Le Lot 3 ne contient ni fonction d'écriture (`apply_changeset` : Lot 4), ni code
client, ni connexion.

## 2. Périmètre

**Inclus**
* Migrations `supabase/migrations/*.sql` : conventions, tables, relations, déclencheurs,
  RLS et privilèges, création du profil à l'inscription.
* `supabase/config.toml` minimal (aucun secret) pour un usage ultérieur du CLI.
* Couche d'émulation `auth` **réservée aux tests** (jamais appliquée à Supabase).
* Tests SQL et script d'exécution sur base éphémère (`scripts/db-test.sh`).
* Table de correspondance complète TypeScript ↔ SQL (champ par champ).
* Rapport `docs/LOT3_SCHEMA.md`.

**Exclus** (lots suivants)
* `apply_changeset`, contrôle de version optimiste et mapping camelCase ↔ snake_case → Lot 4.
* Fonction de récupération des changements, transport réseau, `@supabase/supabase-js` → Lot 5.
* Authentification côté interface → Lot 6.
* Bucket Storage et politiques Storage, remappage des identifiants (R1) → Lot 7.
* Purge des suppressions logiques, CI → Lot 8.
* Toute modification du code TypeScript, des calculs, des traductions et de l'IndexedDB.

## 3. Fichiers et composants

| Fichier | Contenu |
|---|---|
| `supabase/config.toml` | Configuration CLI locale (`project_id = "nexora"`, ports par défaut), sans clé |
| `supabase/migrations/20261101000100_conventions.sql` | Schéma `private`, extension `pgcrypto`, fonctions déclencheurs génériques |
| `…000200_profiles_settings.sql` | `profiles`, `user_settings` |
| `…000300_core_tables.sql` | Les 15 tables métier + `attachments` |
| `…000400_relations.sql` | Clés étrangères composites (toutes différées), unicités partielles, index |
| `…000500_triggers.sql` | Métadonnées de synchronisation, immutabilité, inscription |
| `…000600_rls_grants.sql` | RLS activée + forcée, politiques, révocation des privilèges |
| `supabase/tests/shim/auth_shim.sql` | **Tests uniquement** : schéma `auth` minimal (`auth.users`, `auth.uid()`, `auth.jwt()`), rôles `anon` / `authenticated` / `service_role` |
| `supabase/tests/0x_*.sql` | Tests (§ 9) |
| `scripts/db-test.sh` | `initdb` d'un cluster PostgreSQL 16 temporaire (`/tmp`, port libre), application shim + migrations, tests, destruction |
| `package.json` | *(si approuvé, D3-6)* script `"test:db": "bash scripts/db-test.sh"` |
| `docs/LOT3_SCHEMA.md` | Rapport final, correspondance TS ↔ SQL |

**Non modifiés** : `supabase/schema.sql` (conservé en archive, voir D3-5), tout `src/`,
`netlify.toml`, dépendances.

Outillage constaté dans cet environnement : PostgreSQL 16 (binaires serveur, `pgcrypto`)
disponible ; **pgTAP absent** ; Docker sans démon, donc pas de `supabase start` ici (possible
en revanche dans GitHub Codespaces).

## 4. Principes du schéma

1. **Jamais plus strict que le domaine.** Une contrainte n'est ajoutée que si
   `RepositoryCore` garantit déjà la règle sur la **valeur finale écrite**. Exemples
   écartés après vérification du code : longueur du libellé (le libellé automatique d'un
   transfert n'est pas borné), longueur des notes (les notes d'un paiement de dette ne sont
   pas validées), nom de compte ≤ 80 caractères (non validé), unicité des taux de change
   (`saveRate` accepte les doublons).
2. **Isolation déclarative** : chaque référence entre tables utilisateur est une clé
   étrangère composite `(user_id, x_id) → parent (user_id, id)` ; un utilisateur ne peut ni
   référencer ni sonder la ligne d'un autre, même si PostgreSQL ignore la RLS lors des
   vérifications de clés étrangères.
3. **Métadonnées métier ≠ métadonnées serveur.** `created_at` / `updated_at` restent les
   valeurs du client (elles servent aux calculs : `networth.ts:81`, tri des transactions) ;
   le serveur gère ses propres colonnes (`version`, `sync_txid`, `server_updated_at`,
   `deleted_at`), que le client ne peut pas forcer.
4. **Suppression logique uniquement** côté client ; la suppression physique ne survient
   que par la suppression du compte (`auth.users` → cascade).

## 5. Modèle de données

### 5.1 Colonnes communes (toutes les tables métier)

| Colonne | Type | Règle |
|---|---|---|
| `id` | `uuid` | clé primaire (UUID client) — sauf exceptions § 5.3 |
| `user_id` | `uuid not null` | `references auth.users(id) on delete cascade` ; immuable |
| `created_at` | `timestamptz not null` | valeur client, immuable après insertion |
| `updated_at` | `timestamptz` | valeur client (métadonnée métier) |
| `version` | `bigint not null default 1` | +1 à chaque mise à jour, par déclencheur |
| `sync_txid` | `xid8 not null` | identifiant de la transaction qui a écrit la ligne (`pg_current_xact_id()`), par déclencheur |
| `server_updated_at` | `timestamptz not null` | `now()` à chaque écriture, par déclencheur (audit) |
| `deleted_at` | `timestamptz` | suppression logique (`null` = active) |

Contrainte `unique (user_id, id)` (cible des clés composites) ; index
`(user_id, sync_txid)` (récupération des changements).

### 5.2 Tables

| Table (TS) | Colonnes métier | Contraintes CHECK (alignées sur le domaine) |
|---|---|---|
| `profiles` (`users`) | `id` = `auth.users.id` (PK), `display_name`, `created_at` | — (créée par déclencheur à l'inscription) |
| `user_settings` (`settings`) | PK `user_id` ; colonnes du brouillon (`base_currency`, `language`, `locale`, `time_zone`, `date_format`, `week_starts_on`, `theme`, `currency_display`, `privacy_mode`, `budget_alert_thresholds`, `notify_*`, `bill_reminder_days`, `onboarded`, `demo_mode`) + `display_name` | `week_starts_on ∈ {0,1}`, `theme`, `currency_display`, `date_format` ∈ valeurs du type |
| `accounts` | `name`, `type`, `currency`, `initial_balance bigint`, `initial_balance_date date`, `archived`, `include_in_total`, `color`, `description`, `sort_order` | `type` ∈ 6 valeurs ; `currency ~ '^[A-Z]{3}$'` ; `name` non vide |
| `categories` | `key`, `name`, `kind`, `nature`, `parent_id`, `icon`, `color`, `archived`, `sort_order` | `kind` ∈ 3 ; `nature` ∈ {fixed, variable} ou null |
| `transactions` | colonnes du brouillon ; `attachment_id uuid` (remplace `attachment_path`) | type ↔ sens ; `amount > 0` ; transfert ⇒ `transfer_id` + contrepartie ≠ compte ; ajustement ⇒ notes ; `0 ≤ interest_amount ≤ amount` ; `status`, `payment_method` ∈ valeurs du type |
| `attachments` *(nouvelle)* | `transaction_id`, `name`, `mime_type`, `size`, `storage_path` (null jusqu'au Lot 7) | `mime_type` ∈ types acceptés par `addAttachment` ; `size ≤ 5 Mo` |
| `import_batches` | `file_name`, `account_id`, `row_count`, `imported_count`, `skipped_count` | compteurs ≥ 0 |
| `budgets` | `month char(7)`, `category_id`, `amount`, `currency`, `alert_thresholds smallint[]` | `month ~ '^\d{4}-\d{2}$'` ; `amount ≥ 0` |
| `savings_goals` (`goals`) | colonnes du brouillon | `target_amount > 0`, `saved_amount ≥ 0`, `priority`, `status` ∈ valeurs du type |
| `goal_contributions` | `goal_id`, `date`, `amount`, `note` | `amount ≠ 0` |
| `recurring_rules` | colonnes du brouillon | `kind`, `frequency`, `custom_unit` ∈ valeurs ; `amount > 0` ; `end_date ≥ start_date` |
| `recurring_occurrences` (`occurrences`) | `rule_id`, `due_date`, `status`, `transaction_id`, **`closure`** | `status` ∈ {paid, skipped} ; `closure` ∈ {waived} ou null |
| `debts` | colonnes du brouillon ; `interest_rate double precision` | `type` (6), `direction`, `status`, `installment_frequency` ∈ valeurs ; `principal > 0` |
| `debt_payments` | `debt_id`, `date`, `principal`, `interest`, `account_id`, `transaction_id`, `note` | `principal ≥ 0`, `interest ≥ 0`, somme > 0 |
| `assets` | `name`, `type`, `currency`, `linked_account_id`, `archived`, `notes` | `type` ∈ 5 valeurs |
| `asset_valuations` (`valuations`) | `asset_id`, `date`, `value`, `source`, `note` | `value ≥ 0` ; `source = 'manual'` |
| `exchange_rates` (`rates`) | `base`, `quote`, `rate double precision`, `date`, `source` | `rate > 0`, `base ≠ quote` |
| `notification_states` | `id text`, `read`, `dismissed` | — |

`meta` (Dexie) n'a pas d'équivalent serveur (version de schéma locale) ; correspondance
`users` → `profiles` et traitement de `meta` : Lot 4 (P2).

**Types numériques** : montants en `bigint` (entiers sûrs, `MAX_AMOUNT` = 10¹⁴ < 2⁵³) ;
taux et taux d'intérêt en `double precision` (au lieu de `numeric`) pour restituer
**exactement** le nombre JavaScript saisi — condition de l'équivalence des calculs.

### 5.3 Clés particulières

| Table | Clé primaire | Raison |
|---|---|---|
| `profiles` | `id` (= `auth.users.id`) | un profil par compte |
| `user_settings` | `user_id` | une ligne par utilisateur |
| `recurring_occurrences` | `(rule_id, due_date)` | identifiant TS dérivé `"<ruleId>:<dueDate>"` |
| `notification_states` | `(user_id, id)` | clé déterministe textuelle |

### 5.4 Relations (toutes `(user_id, x) → parent (user_id, id)`, `deferrable initially deferred`, `on delete no action`)

| Table | Références |
|---|---|
| `categories` | `parent_id → categories` |
| `transactions` | `account_id`, `counterpart_account_id → accounts` ; `category_id`, `subcategory_id → categories` ; `refund_of_id → transactions` ; `debt_id → debts` ; `debt_payment_id → debt_payments` ; `recurring_rule_id → recurring_rules` ; `import_batch_id → import_batches` |
| `attachments` | `transaction_id → transactions` |
| `import_batches` | `account_id → accounts` |
| `budgets` | `category_id → categories` |
| `savings_goals` | `linked_account_id → accounts` |
| `goal_contributions` | `goal_id → savings_goals` |
| `recurring_rules` | `account_id → accounts` ; `category_id`, `subcategory_id → categories` |
| `recurring_occurrences` | `rule_id → recurring_rules` ; `transaction_id → transactions` |
| `debts` | `origin_transaction_id → transactions` |
| `debt_payments` | `debt_id → debts` ; `account_id → accounts` ; `transaction_id → transactions` |
| `assets` | `linked_account_id → accounts` |
| `asset_valuations` | `asset_id → assets` |

* **Toutes différées** : l'ordre des écritures d'un lot devient indifférent (références
  circulaires dette ↔ transaction, paiement ↔ transaction, transaction ↔ remboursement) ;
  la cohérence est vérifiée à la validation de la transaction.
* **`on delete no action`** : aucune suppression physique côté client ; lors de la
  suppression d'un compte, toutes les lignes de l'utilisateur partent dans la même
  instruction (cascade depuis `auth.users`), la vérification de fin d'instruction passe.
* **Exception volontaire** : `transactions.attachment_id` **sans** clé étrangère. Le
  domaine conserve `attachmentId` après une restauration (les pièces jointes ne sont pas
  sauvegardées, P4) : une clé étrangère ferait échouer `restoreBackup`. Le lien de
  référence pour l'isolation est `attachments.transaction_id`.
* Une ligne supprimée logiquement **reste physiquement** : les références vers elle
  restent valides, comme les références pendantes que le domaine tolère aujourd'hui (un
  remboursement garde `refundOfId` après suppression de la dépense, un objectif garde un
  compte supprimé…). Aucune contrainte « pas de référence active vers une ligne
  supprimée » : elle rejetterait des opérations que le mode local accepte.

### 5.5 Unicités (partielles, sur les lignes actives)

| Table | Unicité | Garantie par le domaine |
|---|---|---|
| `budgets` | `(user_id, month, category_id) nulls not distinct where deleted_at is null` | `setBudget` / `copyBudgets` font une mise à jour si le budget existe |
| `assets` | `(linked_account_id) where linked_account_id is not null and not archived and deleted_at is null` | `saveAsset` refuse un second actif actif sur un compte |
| `categories` | `(user_id, key) where key is not null and deleted_at is null` | catégories initiales générées une fois par espace |

## 6. RLS et garanties d'isolation

| Élément | Règle |
|---|---|
| RLS | `enable` + `force` sur **toutes** les tables du schéma `public` |
| Politiques tables métier | `select` : `user_id = (select auth.uid())` ; `insert` : `with check` identique ; `update` : `using` + `with check` identiques ; **aucune politique `delete`** |
| `profiles` | `select` / `update` : `id = (select auth.uid())` ; insertion uniquement par le déclencheur d'inscription |
| Rôle `anon` | aucun privilège, aucune politique |
| Rôle `authenticated` | `select`, `insert`, `update` uniquement ; **révocation** de `delete`, `truncate` (qui ignore la RLS), `references`, `trigger` — Supabase accorde tout par défaut aux nouvelles tables |
| Immutabilité | déclencheur : `id`, `user_id`, `created_at` non modifiables ; `version`, `sync_txid`, `server_updated_at` toujours calculés par le serveur |
| Fonctions | déclencheurs dans le schéma `private` (non exposé par l'API) ; `handle_new_user` en `security definer` avec `set search_path = ''` et noms qualifiés |
| Inscription | déclencheur `after insert on auth.users` : crée `profiles` et `user_settings` (valeurs par défaut) |
| Suppression du compte | cascade depuis `auth.users` sur toutes les tables, y compris les lignes supprimées logiquement |

La question « écritures directes autorisées ou uniquement via `apply_changeset` »
(retrait de `insert`/`update` au profit d'une fonction) est tranchée au Lot 4 (D4-1) ; le
Lot 3 garantit que même une écriture directe reste isolée et contrainte.

## 7. Versionnement, suppression logique, synchronisation

**Versionnement (prépare R3)** : `version` vaut 1 à l'insertion et augmente de 1 à chaque
mise à jour, quel que soit ce qu'envoie le client. Au Lot 4, `apply_changeset` recevra la
version attendue de chaque ligne modifiée et rejettera le lot entier en cas d'écart
(conflit → rechargement côté client, aucune fusion automatique).

**Suppression logique** : supprimer = `deleted_at` renseigné (et `version` + 1). Réécrire
une ligne supprimée (restauration, réouverture d'une échéance) la réactive. Les unicités ne
portent que sur les lignes actives. Purge des tombstones : Lot 8 (P5).

**Marqueur de changement fiable** : un simple `updated_at > curseur` perd des lignes
lorsque deux transactions se valident dans le désordre (celle qui a commencé la première
se valide en dernier avec un horodatage plus ancien que le curseur). Proposition : chaque
écriture enregistre `sync_txid = pg_current_xact_id()` ; au Lot 5, la récupération renvoie
les lignes telles que `curseur ≤ sync_txid < pg_snapshot_xmin(pg_current_snapshot())`, et
le nouveau curseur vaut cette borne : aucune transaction encore en cours ne peut ensuite
apparaître sous le curseur. Le Lot 3 pose la colonne, le déclencheur et l'index, et teste la
propriété avec deux sessions concurrentes.

## 8. Risques et dépendances

| Risque | Mesure |
|---|---|
| Écart entre l'émulation `auth` des tests et Supabase réel | Émulation limitée à `auth.users`, `auth.uid()`, `auth.jwt()` et aux rôles, conforme aux définitions Supabase ; validation complémentaire avec `supabase start` dans Codespaces (étape 3b, par vous) puis sur le projet de développement |
| Contrainte plus stricte que le domaine | Principe § 4.1 ; tests d'acceptation sur des lignes représentatives ; **au Lot 4**, test d'acceptation complet du jeu de démo et du scénario de conformité du Lot 2 |
| Versions PostgreSQL (Supabase 15/17, local 16) | Fonctionnalités utilisées disponibles dès PG 15 (`nulls not distinct`, `xid8`) |
| Privilèges par défaut de Supabase (`truncate` notamment) | Révocation explicite + test sur le catalogue |
| Performance des politiques | `(select auth.uid())` + index sur `user_id` |
| Données locales existantes avec références orphelines | P3 : détection / réparation avant la migration Edge |
| Format des horodatages (`…Z` côté TS, `+00:00` renvoyé par PostgREST) | Normalisation au Lot 4 (les comparaisons de chaînes de `networth.ts` en dépendent) |

**Dépendances** : Lot 4 s'appuie sur les clés, les clés étrangères différées et `version` ;
Lot 5 sur `sync_txid` ; Lot 6 sur `handle_new_user` ; Lot 7 sur `attachments` et sur la
résolution de R1 ; la migration Edge sur P3.

## 9. Tests (SQL, base PostgreSQL 16 éphémère)

| Groupe | Contenu |
|---|---|
| Application | Migrations appliquées sur base vierge, sans erreur, dans l'ordre |
| Catalogue (garde-fous automatiques) | 100 % des tables `public` avec RLS activée et forcée ; aucune politique pour `anon` ; aucun privilège `delete` / `truncate` / `references` / `trigger` pour `anon` et `authenticated` ; chaque table métier a `user_id not null`, `unique (user_id, id)`, les 4 colonnes serveur et l'index `(user_id, sync_txid)` ; **chaque** clé étrangère entre tables utilisateur inclut `user_id` et est différée ; chaque fonction `security definer` fixe `search_path` |
| Matrice d'isolation | Pour chaque table : B ne voit aucune ligne de A, ne peut ni la modifier, ni insérer une ligne au nom de A, ni la supprimer ; pour **chaque** clé étrangère (générée depuis le catalogue) : B ne peut pas référencer une ligne de A |
| Anonyme | Aucune lecture ni écriture |
| Déclencheurs | `version` +1 ; `sync_txid` et `server_updated_at` posés par le serveur malgré des valeurs forcées ; `id` / `user_id` / `created_at` immuables |
| Contraintes | Pour chaque CHECK : une ligne valide au sens du domaine acceptée, une ligne invalide refusée |
| Clés différées | Dette + transaction d'origine insérées dans n'importe quel ordre : acceptées ; référence pendante : refusée à la validation |
| Suppression logique | Ligne supprimée toujours référencée valablement ; unicité libérée ; réactivation |
| Synchronisation | Deux sessions concurrentes : la borne `pg_snapshot_xmin` n'expose jamais une transaction non validée, aucune ligne n'est perdue |
| Inscription / suppression | Création d'un utilisateur → `profiles` + `user_settings` ; suppression → toutes ses lignes supprimées, celles des autres intactes |
| Non-régression TS | `npm run check` inchangé (314/314) : aucun fichier `src/` modifié |

Format proposé : **SQL simple** avec une petite fonction d'assertion, exécutable par `psql`
contre n'importe quelle base (cluster éphémère ici, `supabase start` dans Codespaces) ;
pgTAP optionnel plus tard (D3-4).

## 10. Critères objectifs de validation

1. `scripts/db-test.sh` crée une base vierge, applique l'émulation puis les 6 migrations
   sans erreur, exécute tous les tests SQL et détruit la base : **0 échec**.
2. Garde-fous du catalogue : 100 % des tables sous RLS forcée ; 0 politique `anon` ; 0
   privilège `delete` / `truncate` pour `anon` et `authenticated` ; 100 % des clés étrangères
   entre tables utilisateur composites et différées.
3. Matrice d'isolation : 0 fuite (lecture, écriture, référence) sur toutes les tables et
   toutes les clés étrangères.
4. Correspondance TS ↔ SQL : chaque champ des 18 types persistés a sa colonne ; chaque
   colonne correspond à un champ TS ou à une métadonnée serveur documentée.
5. Aucune contrainte plus stricte que le domaine (justification par contrainte dans le
   rapport).
6. `npm run check` : 314/314, diff limité à `supabase/` (hors `schema.sql`), `scripts/`,
   `docs/` (et `package.json` si D3-6 approuvé).
7. Aucune connexion à Supabase, aucun projet créé, aucune donnée réelle touchée, aucun push
   sur `nexora-dev` ni la production, aucun déploiement.

## 11. Décisions à approuver

| # | Décision | Recommandation |
|---|---|---|
| D3-1 | Exécuter les migrations **sur un cluster PostgreSQL 16 éphémère local** (dans `/tmp`, détruit après les tests) pendant l'implémentation | Oui : c'est la seule façon de tester ; aucune base existante ni Supabase n'est concerné |
| D3-2 | Marqueur de synchronisation `sync_txid` (`xid8`) plutôt que `updated_at` | Oui (§ 7) |
| D3-3 | `created_at` / `updated_at` = valeurs du client ; métadonnées serveur séparées | Oui (calculs dépendants de `createdAt`) |
| D3-4 | Tests en SQL simple (psql) plutôt que pgTAP | Oui (pgTAP absent ici ; portable vers Codespaces) |
| D3-5 | `supabase/schema.sql` conservé inchangé comme archive (en-tête « remplacé par `migrations/` » ajouté au Lot 3), ou supprimé | Conservé, avec en-tête |
| D3-6 | Ajouter le script `test:db` à `package.json` | Oui (aucune dépendance) |
| D3-7 | Taux en `double precision` (et non `numeric`) | Oui (§ 5.2) |
| D3-8 | Pas d'unicité sur les taux de change (D12 de l'audit non appliquée) | Oui : `saveRate` accepte les doublons |
| D3-9 | Étape 3b (facultative, par vous) : rejouer les tests dans Codespaces avec `supabase start` ; application au projet Supabase de développement seulement après le Lot 4 | Oui |
