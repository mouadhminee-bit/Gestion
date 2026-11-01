# NEXORA — Lot 4 : écriture serveur atomique et versionnée (`apply_changeset`)

> **STATUT (01/11/2026) : EN COURS.** Étapes 4.0 et 4.1 réalisées et poussées (`5b494f0`) ;
> étape 4.2 réalisée sur `claude/stoic-edison-8s0vhq`, en attente de revue. Étapes 4.3 à 4.7
> non commencées. Aucun projet Supabase hébergé, aucune migration ajoutée ou modifiée,
> aucune donnée réelle touchée.

Références : `docs/AUDIT_LOT1_CLOUD.md` (§ C.3, C.4, F), `docs/LOT2_REPOSITORY.md`,
`docs/LOT3_PLAN.md`, `docs/LOT3B_CLOTURE.md`, `docs/SUIVI_TECHNIQUE.md` (R1–R3, P1–P11).

## 1. Décisions validées par le responsable du projet

| # | Décision | Conséquence pour la suite du lot |
|---|---|---|
| D4-0 | Branche de travail exclusive : `claude/stoic-edison-8s0vhq`. Branches protégées : `claude/nexora-finance-platform-81blaa` (production), `nexora-dev` | Aucun push ailleurs ; aucun rebase, reset destructif ni force push |
| D4-1 | Toutes les écritures métier cloud passent **exclusivement** par `apply_changeset` | Une **nouvelle** migration retirera à `authenticated` les privilèges `insert` / `update` directs (les 7 migrations validées restent inchangées) ; les tests HTTP d'écriture directe deviendront des tests de refus |
| D4-2 | Versions serveur conservées dans une **table annexe du cache** | Le domaine, `snapshot()` et `exportBackup()` ne voient jamais les versions |
| D4-3 | **Aucune duplication des règles métier en SQL** | Pas de recalcul serveur de `saved_amount` ni du statut des dettes : le contrôle de version de la ligne parente empêche les mises à jour perdues |
| D4-4 | Contrôle de version **partout**, exceptions explicitement encadrées | Chaque exception (par exemple l'écrasement explicite de `restoreBackup`) est listée, justifiée et testée |
| D4-5 | Idempotence par `changesetId` (UUID client) | Un lot rejoué n'est pas appliqué deux fois (prépare P1) |
| D4-6 | Taille maximale d'un lot déterminée **par mesure** sur les données de démonstration | Mesure documentée avant de fixer la limite dans la fonction |
| D4-7 | Contrôles inter-lignes complexes (par exemple « transfert = exactement 2 jambes ») **reportés** | Hors Lot 4 |
| D4-8 | Qualification HTTP dans Codespaces **obligatoire** avant clôture | L'étape 4.6 conditionne 4.7 |

## 2. Périmètre et étapes

| Étape | Contenu | Statut |
|---|---|---|
| 4.0 | Préalables : décisions consignées, documentation périmée corrigée | **Réalisée** (§ 3) |
| 4.1 | Atomicité R2 : `saveAsset` + valorisation initiale, `resetToEmpty` | **Réalisée** (§ 4) |
| 4.2 | Mapping TypeScript ↔ SQL (`src/data/cloud/mapping.ts`) | **Réalisée** (§ 5) |
| 4.3 | Protocole `ChangeSet` versionné (versions attendues, `changesetId`, conflit) | À faire |
| 4.4 | Fonction SQL `apply_changeset` (nouvelles migrations) | À faire |
| 4.5 | Tests PostgreSQL 16 / 17 éphémères | À faire |
| 4.6 | Qualification HTTP (Codespaces, par le responsable du projet) | À faire |
| 4.7 | Clôture et archivage | À faire |

**Exclus** : transport réseau et `@supabase/supabase-js`, récupération des changements et
rechargement après conflit (Lot 5) ; authentification dans l'application (Lot 6) ; R1,
pièces jointes et Storage (Lot 7) ; projet hébergé (3b-4) ; données Edge.

## 3. Étape 4.0 — préalables

Corrections documentaires (informations devenues inexactes, sans changer aucun résultat) :

| Fichier | Correction |
|---|---|
| `docs/LOT3B_CLOTURE.md` § 3, § 7.6, § 8 | Les trois rapports Codespaces sont **versionnés** depuis `8cdd310` (et non « non versionnés ») ; contrôle `scripts/check-qualification-evidence.mjs` rejoué : « fichiers propres et cohérents » ; condition « décision de lancement du Lot 4 » marquée comme donnée |
| `docs/LOT3B_QUALIFICATION.md` § 4 | « les 6 migrations » → toutes les migrations du répertoire (7 à ce jour) ; le script compare déjà dynamiquement avec le contenu de `supabase/migrations/` |
| `scripts/qualify-supabase.sh` | Même correction dans le commentaire d'en-tête (aucun changement de comportement) |
| `docs/SUIVI_TECHNIQUE.md` | R2 : constat complémentaire et traitement (étape 4.1) ; R3 : renvoi aux décisions D4 |

Les documents conservés « sans modification » par choix (`LOT3_PLAN.md` partie II,
`LOT3B_PLAN.md` § 4) gardent leurs chiffres d'origine (« 6 migrations ») ; leur statut en
tête le signale déjà.

**Vérifié** : les 7 migrations `supabase/migrations/*.sql` sont inchangées (diff vide).

## 4. Étape 4.1 — réserve R2

### 4.1 Constats (avant correction, `8cdd310`)

1. `saveAsset` écrivait l'actif hors transaction, puis appelait `addValuation` (seconde
   écriture). En cloud : **deux lots** ; une panne entre les deux laissait un actif sans
   valorisation.
2. La valorisation initiale était validée **après** l'écriture de l'actif : une date ou une
   valeur invalide créait l'actif puis levait une `ValidationError`, **y compris en mode
   local**. Dans `NetWorth.tsx`, le formulaire restait ouvert : une nouvelle tentative créait
   un second actif (ou échouait sur « compte déjà valorisé »).
3. `resetToEmpty` enchaînait `clearUserData`, `ensureUser` et `updateSettings` sans
   transaction commune : une panne après l'effacement laissait un espace sans paramètres
   (retour à l'onboarding) ou sans catégories initiales.

### 4.2 Corrections (`src/data/RepositoryCore.ts`)

* **`saveAsset`** : validations, puis écritures, dans **une seule transaction**
  `['assets', 'valuations']`. Ordre des validations conservé (nom vide → compte déjà
  valorisé → actif inconnu) ; la validation de la valorisation initiale (date puis valeur,
  mêmes messages) est ajoutée **avant** la première écriture. `addValuation` est appelée
  telle quelle : l'appel imbriqué rejoint la transaction englobante (Dexie et
  `CloudStorage`).
* **`addValuation`** : inchangée fonctionnellement ; ses deux contrôles sont factorisés dans
  une fonction de module `checkValuation` (et non une méthode, pour que la surface de l'API
  reste de 54 méthodes).
* **`resetToEmpty`** : une transaction englobante dont la portée couvre toutes les tables
  des appels imbriqués (`USER_TABLES`, `attachments`, `users`, `meta`).

**Règles métier** : aucune modifiée. Seul effet observable : en cas d'échec (validation de la
valorisation initiale, panne), **plus rien n'est écrit**, au lieu d'une écriture partielle.
En cloud, chaque opération produit désormais **un seul lot** (règle « une opération métier =
un `ChangeSet` », préalable à `apply_changeset`).

### 4.3 Tests (`src/data/contract.test.ts`, bloc « atomicité R2 », 23 tests)

Exécutés sur `LocalRepository` (transaction Dexie) **et** `CloudRepository`
(`MemoryTransport`), uniquement sur fake-indexeddb et des données fictives. Comparaison
exhaustive de la base / du cache **et**, en cloud, du serveur simulé.

| Test | Vérifie |
|---|---|
| Valorisation initiale invalide (5 cas : date inexistante, date mal formée, valeur négative, non entière, NaN) | `ValidationError`, aucun actif, aucun lot envoyé |
| Messages | Date invalide signalée avant la valeur (ordre d'origine) |
| Panne à l'écriture de la valorisation | Aucun actif orphelin ; nouvelle tentative possible (pas de « compte déjà valorisé ») |
| Panne à l'écriture de l'actif | Ni actif ni valorisation |
| Succès | Création avec valorisation (un seul lot cloud contenant `assets` + `valuations`), modification sans valorisation, modification avec valorisation |
| Erreurs existantes | Nom vide, compte déjà valorisé, actif inconnu : aucune écriture |
| `resetToEmpty`, panne à 4 étapes (effacement, profil, catégories initiales, paramètres) | État strictement identique à l'état initial |
| `resetToEmpty`, succès | Espace vierge, préférences conservées, `demoMode = false`, catégories initiales, un seul lot cloud |
| Équivalence | Mêmes résultats et mêmes données en local et en cloud (horloge et identifiants figés) |

**Contrôles par mutation** (code volontairement cassé puis restauré) :

| Mutation | Tests en échec |
|---|---|
| M1 — `saveAsset` sans transaction | 3 (panne valorisation local + cloud, lot unique cloud) |
| M2 — `resetToEmpty` sans transaction englobante | 7 (3 pannes local, 3 pannes cloud, lot unique cloud) |
| M3 — code d'origine exact (sans transaction, validation après écriture) | 5 (valorisation invalide local + cloud, panne valorisation local + cloud, lot unique cloud) |

Deux tests ne peuvent pas détecter ces mutations, par construction : « panne à l'écriture
de l'actif » (première écriture, rien avant elle) et « panne à l'effacement »
(`clearUserData` est déjà atomique à lui seul). Ils protègent contre d'autres régressions.

### 4.4 Résultats

* `npm run check` : typecheck OK, **13 fichiers, 337 tests, 337 réussis** (314 existants
  inchangés + 23 nouveaux), build OK.
* `repository.test.ts` : 31/31, sans modification.
* E2E (`e2e/smoke.cjs`, build local servi sur `localhost`, profil Chromium neuf) : **10/11**,
  aucune erreur de page. L'échec « transfert non compté en dépense (dépenses = 410,80) »
  est **préexistant** : il se reproduit à l'identique sur `8cdd310` sans les corrections
  du Lot 4. Hypothèse non vérifiée : test dépendant de la date du jour (exécution le
  01/11, premier jour du mois ; 11/11 le 31/10 au Lot 2). Hors périmètre 4.1, à analyser
  séparément.

### 4.5 Limites restantes

* R2 est **corrigée et testée** ; sa levée formelle intervient à la validation du Lot 4
  (règle du registre).
* L'atomicité côté serveur (un lot = une transaction PostgreSQL) reste à prouver avec
  `apply_changeset` (étapes 4.4 à 4.6).
* Les autres opérations à écriture unique ne sont pas concernées ; aucune autre opération
  composée hors transaction n'a été trouvée dans `RepositoryCore` (`saveGoal` et
  `saveRecurringRule` n'écrivent qu'une ligne par appel).

## 5. Étape 4.2 — mapping TypeScript ↔ PostgreSQL

### 5.1 Livrables

| Fichier | Rôle |
|---|---|
| `src/data/cloud/mapping.ts` (créé) | Matrice unique des 18 tables (`MAPPING`) et fonctions de conversion. Indépendant de React, Dexie et Supabase ; aucune dépendance ajoutée ; seul import applicatif : `isValidISODate` (`src/domain/dates.ts`, fonction pure) |
| `src/data/cloud/mapping.test.ts` (créé) | 79 tests dédiés ; le schéma de référence est lu dans `supabase/migrations/` |
| `src/data/contract.test.ts` (modifié) | 1 test : toutes les lignes écrites par le scénario de conformité du Lot 2 passent par le mapping |

Fonctions exposées : `assertCloudTable`, `sqlTableOf`, `tableOfSql`, `sqlColumnsOf` (tables) ;
`serializeRow` (TS → SQL), `deserializeRow` (SQL → TS, avec `ServerMetadata`) ;
`assertKnownFields`, `assertNoServerMetadata` (champs interdits) ; `toSqlKey`, `fromSqlKey`,
`occurrenceKey`, `parseOccurrenceKey` (clés) ; `toCloudRow` (retrait des champs locaux).
Erreur unique `MappingError` avec un code (`unknown_table`, `excluded_table`,
`unknown_column`, `forbidden_column`, `missing_column`, `invalid_value`, `key_mismatch`,
`owner_mismatch`), la table et le champ.

Rien n'utilise encore ce module dans l'application (`CloudStorage`, `CloudRepository` et les
transports sont inchangés) : son branchement relève des étapes 4.3 à 4.5.

### 5.2 Matrice des tables

Chaque champ de chaque type TS a un descripteur (complétude vérifiée **à la compilation**
par le type `TableSpec`) ; chaque colonne de chaque table des migrations a son champ ou est
une métadonnée serveur (vérifié **par test**, sur le texte des migrations : noms, types,
`NOT NULL` ⇔ champ obligatoire, clé primaire). Détail colonne par colonne :
`docs/LOT3_SCHEMA.md` § 9, désormais exécutable dans `MAPPING`.

| Table TS | Table SQL | Clé TS → clé SQL | Écriture | Champs | Particularités |
|---|---|---|---|---|---|
| `users` | `profiles` | `id` → `id` | **mise à jour seule** | 4 (3 colonnes) | `email` local ; `created_at` lu, jamais écrit |
| `settings` | `user_settings` | `id` (= userId) → `user_id` | upsert | 20 (19) | `id` dérivé (= `userId`) |
| `accounts` | `accounts` | `id` | upsert | 14 | `order` → `sort_order` |
| `categories` | `categories` | `id` | upsert | 13 | `order` → `sort_order` ; `parentId` `T \| null` |
| `transactions` | `transactions` | `id` | upsert | 28 | `tags` `text[]` ; `categoryId`, `subcategoryId` `T \| null` |
| `attachments` | `attachments` | `id` | upsert | 7 (6) | `blob` local, jamais transmis |
| `importBatches` | `import_batches` | `id` | upsert | 8 | — |
| `budgets` | `budgets` | `id` | upsert | 9 | `month` `char(7)` ; `alertThresholds` `double precision[]` |
| `goals` | `savings_goals` | `id` | upsert | 17 | — |
| `goalContributions` | `goal_contributions` | `id` | upsert | 7 | — |
| `recurringRules` | `recurring_rules` | `id` | upsert | 19 | `subcategoryId` `T? \| null` (§ 5.4) ; `customInterval` `double precision` |
| `occurrences` | `recurring_occurrences` | `"<ruleId>:<dueDate>"` → `(rule_id, due_date)` | upsert | 8 (7) | `id` dérivé |
| `debts` | `debts` | `id` | upsert | 18 | `interestRate` `double precision` |
| `debtPayments` | `debt_payments` | `id` | upsert | 10 | — |
| `assets` | `assets` | `id` | upsert | 10 | — |
| `valuations` | `asset_valuations` | `id` | upsert | 8 | — |
| `rates` | `exchange_rates` | `id` | upsert | 8 | `rate` `double precision` |
| `notificationStates` | `notification_states` | `[userId, id]` → `(user_id, id)` | upsert | 5 | `id` texte déterministe |
| `meta` | — | — | **exclue** | — | version du schéma IndexedDB local ; aucun équivalent serveur |

### 5.3 Transformations

| Sujet | TS → PostgreSQL | PostgreSQL → TS |
|---|---|---|
| Noms | camelCase → snake_case selon la matrice (aucune conversion automatique) | inverse ; toute colonne inconnue ou absente est refusée |
| Valeurs absentes | `undefined` / `null` → `NULL` pour un champ non obligatoire ; la ligne écrite contient **toutes** les colonnes écrites (état final complet) ; champ obligatoire absent ou `null` refusé | `NULL` → champ absent (`T?`) ou `null` (`T \| null`, `T? \| null`) ; `NULL` dans une colonne obligatoire refusé |
| Montants `bigint` | entier sûr JavaScript (\|x\| ≤ 2⁵³ − 1), transmis comme nombre ; décimal, non sûr, chaîne, `bigint` JS refusés | nombre, ou chaîne décimale exacte ; au-delà de 2⁵³ − 1 refusé (aucune perte silencieuse) |
| `integer`, `smallint` | entier dans la plage du type (32 / 16 bits) | idem |
| Taux `double precision` | nombre transmis tel quel (exactitude par l'API garantie par la migration 7) ; `NaN`, `±Infinity` refusés (JSON les changerait en `null`) | nombre fini, conservé bit à bit |
| Dates `date`, mois `char(7)` | `AAAA-MM-JJ` (date réelle) / `AAAA-MM`, inchangés | idem |
| Horodatages `timestamptz` | ISO 8601 avec fuseau **obligatoire** (`Z`, `±HH`, `±HHMM`, `±HH:MM`, séparateur `T` ou espace) → forme canonique `toISOString()` (`Z`, millisecondes) : même instant | `+00:00` (PostgREST) ou autre fuseau → même forme canonique `Z` ; chiffres non nuls au-delà de la milliseconde refusés |
| UUID | forme canonique en minuscules exigée | idem |
| Texte | caractère NUL refusé (PostgreSQL le rejette) | — |
| Métadonnées serveur | `version`, `sync_txid`, `server_updated_at`, `deleted_at` (et formes camelCase) **refusées** dans toute ligne à écrire | séparées dans `ServerMetadata` : `version` (entier sûr), `syncTxid` (texte, `xid8` 64 bits sans perte), `serverUpdatedAt` et `deletedAt` tels que renvoyés |
| Propriétaire | facultatif : `serializeRow(…, { userId })` refuse une ligne d'un autre utilisateur | — |
| Profil | seules `id` (clé) et `display_name` sont écrites ; aucune création | `created_at` = date d'inscription fixée par le serveur |

Le mapping ne contient aucune règle métier : une valeur du bon type mais refusée par un
`CHECK` (type de compte inconnu, montant négatif…) est transmise ; son refus appartient à
`RepositoryCore` et au schéma.

### 5.4 Exceptions à l'aller-retour (documentées et testées)

| # | Exception | Justification |
|---|---|---|
| X1 | `attachments.blob` n'est ni transmis ni relu | fichier local ; Storage au Lot 7 (P4) |
| X2 | `users.email` n'est ni transmis ni relu | l'adresse fait foi dans `auth.users` |
| X3 | `users.createdAt` n'est pas écrit ; relu = date d'inscription serveur | `profiles` est créé par `handle_new_user` ; `authenticated` n'a que `UPDATE (display_name)` |
| X4 | Champ facultatif (`T?`) écrit à `null` → relu absent ; champ `T \| null` absent → relu `null` | `NULL` SQL unique pour les deux ; même sens métier |
| X5 | `recurringRules.subcategoryId` (`T? \| null`) absent → relu `null` | l'interface écrit `null`, la démo omet le champ, les lecteurs font `?? null` ; **seule exception rencontrée** sur les jeux de démonstration et de conformité (8 lignes) |
| X6 | Horodatage relu en forme canonique `Z` | même instant ; c'est déjà la forme produite par le client (`nowISO`) |
| X7 | `-0` devient `0` par JSON | aucun montant ni taux concerné (`-0 === 0`) |

### 5.5 Tests et résultats

| Domaine | Tests | Vérifie |
|---|---|---|
| Couverture du schéma | 21 | 18 tables SQL ↔ 18 tables TS, `meta` seule exclue ; pour chaque table : colonnes, types, nullabilité et clé primaire identiques aux migrations ; champs non-colonnes limités à X1, X2 et aux deux clés dérivées ; noms de tables dans les deux sens |
| Aller-retour | 21 | 18 tables × (ligne complète + ligne minimale), idempotence ; ligne écrite complète ; null / undefined ; tableaux et texte (unicode, guillemets, retours à la ligne) |
| Horodatages et dates | 5 | 12 formats d'écriture → même instant ; lecture `+00:00` ; refus sans fuseau, perte de précision, formats invalides ; dates et mois ; métadonnées horodatées |
| Échéances et clés | 5 | `occurrenceKey` ≡ `occurrenceId` du domaine ; 10 clés mal formées refusées ; clés des paramètres, notifications, tables simples |
| users / profiles | 4 | mise à jour seule, colonnes écrites, lecture de `created_at`, propriétaire ; paramètres `id = userId` |
| Exclusions | 4 | `meta` refusée partout ; tables inconnues (dont `__proto__`) ; fichier jamais transmis ; binaire refusé dans toute colonne |
| Colonnes interdites | 5 | champ inconnu (même `undefined`) ; colonne inconnue ou absente à la lecture ; 7 métadonnées refusées sur les 18 tables ; `xid8` sans perte ; propriétaire |
| Montants et taux | 6 | entiers sûrs jusqu'à 2⁵³ − 1 ; 10 valeurs refusées ; lecture de chaînes `bigint` ; 9 taux conservés bit à bit ; `NaN` / `Infinity` refusés ; bornes 32 / 16 bits |
| Démonstration | 1 | 100 % des lignes de `generateDemoData` (plus de 100), avec contrôle du propriétaire ; seule X5 apparaît |
| Cas limites | 7 | UUID, NUL, booléens, entrées non conformes, absence de règle métier, entrée non modifiée, messages |
| Jeu de conformité (`contract.test.ts`) | 1 | **661 lignes écrites** par le scénario des 54 méthodes, sur **les 18 tables**, et **582 clés de suppression** : 100 % convertibles ; seule X5 apparaît |

**Contrôles par mutation** (code cassé puis restauré) : colonne renommée (2 tests en échec),
métadonnées non filtrées (1), horodatage non normalisé (25), montant non entier accepté (4),
fichier transmis (6), clé d'échéance non vérifiée (2), `NaN` accepté (1) — toutes détectées.

**Résultat** : `npm run check` — typecheck OK, **14 fichiers, 417 tests, 417 réussis**
(337 précédents inchangés + 80 nouveaux), build OK. Aucune migration modifiée.

### 5.6 Limites

* Le mapping n'est pas encore utilisé : le `ChangeSet` reste non versionné (4.3) et aucune
  écriture ne passe par PostgreSQL (4.4–4.6). L'aller-retour est simulé (forme des réponses
  PostgREST, passage JSON) ; sa vérification contre la vraie API relève de 4.5–4.6.
* Validation stricte : une ligne IndexedDB portant un champ hors du type TS (donnée
  ancienne, champ d'interface glissé dans une écriture) sera refusée en mode cloud, et
  `userId = 'local-user'` (mode local) n'est pas un UUID. Effet voulu ; à traiter avec P3
  avant toute migration des données Edge.
* Les contraintes `CHECK` ne sont pas reproduites côté client (D4-3) : leur refus sera
  renvoyé par `apply_changeset`.
* `profiles` : la ligne doit exister (créée à l'inscription) ; si `handle_new_user` ne
  s'exécute pas sur un projet hébergé (P10), la mise à jour du profil échouera.

### 5.7 Suppression logique (`deleted_at`) : vérification

Vérifié dans le code, les migrations et les tests (aucune modification de code).

| # | Exigence | Garanti aujourd'hui | Où | Reste à faire (4.4 : `apply_changeset`) |
|---|---|---|---|---|
| 1 | Le client demande une suppression par une opération `delete` | **Oui, côté client** : `CloudStorage` produit `{ type: 'delete', key }` ; le mapping convertit la clé (`toSqlKey`, testé sur 582 clés du jeu de conformité) | `CloudStorage.ts`, `mapping.ts` | Traduire `delete` en `UPDATE … SET deleted_at = <non nul>` (jamais `DELETE` : aucun privilège ni politique, migration 6) ; décider du cas d'une clé absente du serveur |
| 2 | Le serveur renseigne `deleted_at` | **Oui** : le déclencheur `tg_sync_metadata` remplace toute valeur non nulle par `now()` (ou conserve la date d'une ligne déjà supprimée) | migration 1 ; tests `06_soft_delete.sql` (« valeur client ignorée », « date conservée »), HTTP `rls.mjs` (horodatage serveur, version + 1) | — |
| 3 | Le client récupère `deleted_at` à la lecture | **Oui, dans le mapping** : `deserializeRow` renvoie `meta.deletedAt` (tel que renvoyé) et ne l'intègre jamais à la ligne métier ; une ligne supprimée est renvoyée comme les autres | `mapping.ts` ; tests « métadonnées séparées », « server_updated_at » | Lecture effective par le réseau : Lot 5 (récupération des changements) ; c'est l'appelant qui traite `deletedAt ≠ null` comme une suppression |
| 4 | Réactivation d'une ligne supprimée | **Oui, au niveau base** : `deleted_at = null` réactive la ligne, la version continue ; unicités revérifiées (`23P01` si un doublon actif existe) | migration 1 ; tests `06_soft_delete.sql` (restauration, budget en doublon, séquence de restauration de sauvegarde) | **Exigence** : une opération `put` doit **remettre explicitement `deleted_at` à `null`**. Le mapping n'émet jamais `deleted_at` : un `INSERT … ON CONFLICT DO UPDATE` limité aux colonnes de `values` laisserait la ligne supprimée. À tester en 4.5 (suppression puis réécriture, `restoreBackup`, `reopenOccurrence`) |
| 5 | Le client ne peut ni imposer ni modifier directement `deleted_at` | **Partiellement.** Valeur : jamais imposée (horodatage serveur). Mapping : `deleted_at` / `deletedAt` refusés dans toute ligne à écrire (18 tables). **Mais** les privilèges actuels (`insert`, `update` directs pour `authenticated`, migration 6) permettent encore à un client modifié de basculer `deleted_at` entre nul et non nul par PostgREST, hors de `apply_changeset` (comportement testé et voulu au Lot 3) | `mapping.ts` ; migration 6 | **D4-1** : nouvelle migration retirant `insert` / `update` directs ; seul `apply_changeset` décide de `deleted_at` (à partir du type d'opération) ; tests de refus en 4.5 / 4.6 |

**Limites** : tant que D4-1 n'est pas appliquée (4.4), la garantie n° 5 repose sur le
client ; la réactivation par `put` (n° 4) dépend de l'implémentation d'`apply_changeset` ;
la propagation des suppressions vers les autres appareils relève du Lot 5 ; la purge des
lignes supprimées reste au Lot 8 (P5).
