# NEXORA — Lot 4 : écriture serveur atomique et versionnée (`apply_changeset`)

> **STATUT (01/11/2026) : EN COURS.** Étapes 4.0–4.1 (`5b494f0`), 4.2 (`f59d88d`) et 4.3
> (`4be509f`) réalisées et poussées ; étape 4.4 **implémentée, non qualifiée** (tests
> exploratoires sur PostgreSQL éphémère ; décisions en attente, § 7.11), non commitée.
> Étapes 4.5 à 4.7 non commencées. Aucun projet Supabase hébergé, migrations 1 à 7
> inchangées, aucune donnée réelle touchée.

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
| 4.3 | Protocole `ChangeSet` versionné (versions attendues, `changesetId`, conflit) | **Réalisée** (§ 6) |
| 4.4 | Fonction SQL `apply_changeset` (nouvelles migrations) | **Implémentée, en attente de validation** (§ 7) |
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

## 6. Étape 4.3 — protocole ChangeSet v1 (contrôle optimiste)

### 6.1 Fichiers

| Fichier | Statut | Rôle |
|---|---|---|
| `src/data/cloud/transport.ts` | modifié | Protocole v1 (`ChangeSet`, `ChangeOp`, `CommitResult`, `ResolveResult`), erreurs typées, empreinte de lot, vérification des confirmations |
| `src/data/cloud/CloudCacheDB.ts` | créé | Base `nexora-cache-<uid>` : tables métier v1 + table annexe `serverVersions` (version 2 de cette base seulement) ; nommage du cache (déplacé de `CloudStorage`, réexporté) et protection du constructeur (§ 6.10) |
| `src/data/cloud/CloudStorage.ts` | modifié | Versions observées à la lecture, construction du lot, confirmation, application atomique au cache, résolution d'un lot non confirmé |
| `src/data/cloud/CloudRepository.ts` | modifié | Cache `CloudCacheDB` par défaut ; chaque méthode susceptible d'écrire s'exécute dans une « opération » (`runOperation`) |
| `src/data/cloud/MemoryTransport.ts` | modifié | Serveur simulé versionné : contrôle optimiste, idempotence, abandon, pannes simulées |
| `src/data/db.ts` | modifié | Paramètre facultatif d'options Dexie (fabrique IndexedDB distincte = autre appareil, **tests uniquement**) ; schéma `nexora` v1 inchangé |
| `src/data/cloud/protocol.test.ts` | créé | 38 tests du protocole (dont 12 pour les tables locales et la protection du cache) |
| `src/data/contract.test.ts` | modifié | Outillage : 3 caches construits en `CloudCacheDB` ; test « serveur ≡ cache » restreint aux 18 tables synchronisées, avec contrôle explicite de `meta` (présente dans le cache, absente du serveur) |

### 6.2 Schéma du lot (protocole v1)

```ts
interface ChangeSet {
  protocol: 1;
  changesetId: string;          // UUID v4 (crypto.randomUUID), unique par lot ; clé d'idempotence
  userId: string;               // propriétaire logique (le serveur impose son utilisateur authentifié)
  ops: ChangeOp[];              // au plus une opération par (table, clé), dans l'ordre des écritures
}
type ChangeOp =
  | { table; type: 'put';    key; expectedVersion: number | null; row }   // ligne métier TS complète
  | { table; type: 'delete'; key; expectedVersion: number | null };       // jamais de ligne

interface CommitResult {        // confirmation du serveur
  changesetId: string;
  status: 'applied' | 'replayed';
  versions: { table; key; version: number; deleted: boolean }[];  // une entrée par opération, même ordre
}
type ResolveResult = CommitResult | { changesetId: string; status: 'abandoned' };

interface CloudTransport {
  commit(changes: ChangeSet): Promise<CommitResult>;
  resolve(changesetId: string, userId: string): Promise<ResolveResult>;
}
```

Les lignes restent au format TypeScript : la conversion SQL (`mapping.ts`, étape 4.2)
appartient au transport réseau (4.4 / Lot 5). Une confirmation n'est acceptée que si elle
correspond EXACTEMENT au lot (`checkCommitResult` : même `changesetId`, une entrée par
opération dans le même ordre, même table et même clé, version entière supérieure à la
version attendue, état supprimé cohérent avec le type d'opération).

### 6.3 Convention de version

`expectedVersion` est la dernière version serveur que le client connaît pour la clé, **telle
qu'observée lors de la première lecture de la clé par l'opération** (y compris une lecture
hors transaction) ; pour une écriture sans lecture préalable, celle connue au moment de
l'écriture.

| Cas | `expectedVersion` envoyée | Condition côté serveur | Résultat |
|---|---|---|---|
| Création d'une clé inconnue | `null` | la clé n'existe pas (ni active ni supprimée) | version 1, active |
| Modification d'une ligne active | v | version actuelle = v | v + 1, active |
| Suppression logique | v | ligne active et version actuelle = v | v + 1, supprimée (ligne conservée) |
| Réactivation (écriture d'une clé supprimée) | v (version de la ligne supprimée, conservée dans le cache) | version actuelle = v | v + 1, active |
| Rejeu d'un lot accepté (même `changesetId`, même contenu) | — | lot déjà traité | **aucune nouvelle version** : résultat d'origine, `status: 'replayed'` |
| Clé créée puis supprimée dans la même transaction | — | — | opération non transmise |

Toute autre situation est un conflit. Aucune exception D4-4 n'a été nécessaire :
`restoreBackup` et `resetToEmpty` se ramènent à des suppressions et réécritures versionnées
ordinaires.

### 6.4 Serveur simulé (`MemoryTransport`)

Ordre de traitement d'un lot : (1) forme du lot (protocole, UUID, lot non vide, tables
connues et synchronisées — toute table de `EXCLUDED_TABLES`, dont `meta`, est refusée —, une opération par clé, clé cohérente avec la ligne, version entière ≥ 1 ou `null`)
→ `CloudProtocolError('invalid_changeset')` ; (2) idempotence : `changesetId` déjà accepté →
même contenu (empreinte canonique) : résultat d'origine ; autre contenu ou autre
utilisateur : `CloudProtocolError('changeset_id_reused')` ; lot abandonné :
`CloudProtocolError('changeset_abandoned')` ; (3) isolation (ligne d'un autre utilisateur)
→ `IsolationViolationError` ; (4) **toutes** les versions vérifiées avant application → un
seul écart : `CloudConflictError` (liste des clés : version attendue, version et état
actuels) ; (5) application tout ou rien, lignes supprimées conservées.

Pannes simulées : `failNext` / `failWhen` (échec avant application), `loseResponseNext`
(appliqué puis réponse perdue), `garbleResponseNext` (réponse altérée), `resolveFailure`
(résolution impossible). `rows()` ne renvoie que les lignes actives ; `entry()` donne
version et état d'une clé.

### 6.5 Conflits, idempotence, issue inconnue

| Situation | Erreur | Serveur | Cache (lignes et versions) | Suite |
|---|---|---|---|---|
| Version obsolète | `CloudConflictError` (refus définitif) | rien appliqué | inchangé | recharger (Lot 5) puis réessayer |
| Lot mal formé, identifiant réutilisé, lot abandonné | `CloudProtocolError` (définitif) | rien appliqué | inchangé | — |
| Isolation | `CloudTransportError` (cause `IsolationViolationError`, définitif) | rien appliqué | inchangé | — |
| Échec réseau (avant ou après application : indiscernable) | `CloudTransportError` | appliqué **ou non** | inchangé | lot conservé « non confirmé » |
| Réponse ambiguë | `CloudTransportError` | appliqué | inchangé | lot conservé « non confirmé » |
| Accepté mais écriture du cache impossible | `CloudCacheWriteError` | appliqué | inchangé (transaction Dexie annulée) | résultat conservé, réappliqué |

**Réponse perdue après acceptation** (comportement défini, sans file d'attente) : un seul
emplacement mémoire contient le lot non confirmé. L'opération est signalée **non
enregistrée** ; rien n'est écrit localement. Avant toute nouvelle opération d'écriture
(`runOperation`, puis à nouveau à l'ouverture de la transaction), le client appelle
`resolve(changesetId)` :

* le serveur l'avait appliqué → il renvoie le résultat d'origine (`replayed`) ; le cache
  applique lignes et versions, puis la nouvelle opération lit des données à jour (testé :
  aucune perte, aucun doublon, aucun faux conflit) ;
* il ne l'avait pas appliqué → il le marque **abandonné** et renvoie `abandoned` ; le lot ne
  sera jamais appliqué, même s'il arrive plus tard (testé) ;
* résolution impossible (réseau) → toute écriture est refusée (`CloudTransportError`) ; la
  lecture reste possible (hors ligne : lecture seule, D4) ; aucune écriture n'est rejouée
  automatiquement.

Une opération signalée en échec n'est donc jamais présentée comme enregistrée ; si le
serveur l'avait acceptée, le cache la fait apparaître lors de la résolution.

### 6.6 Atomicité du cache

* Pendant une transaction : écritures dans la surcouche (inchangé, Lot 2).
* Après confirmation valide : lignes **et** versions écrites dans **une** transaction Dexie
  (`rw` sur les tables touchées + `serverVersions`) ; en cas d'échec, Dexie annule tout.
* Ligne et version sont lues ensemble (transaction Dexie de lecture) : instantané cohérent
  même si un autre onglet écrit en parallèle.
* Une suppression retire la ligne du cache mais conserve sa version (`deleted: true`).
* Les versions vivent dans `nexora-cache-<uid>` uniquement (jamais `nexora`), jamais dans
  les lignes métier, `snapshot()` ni `exportBackup()` (testé).

### 6.7 Défauts trouvés et corrigés pendant l'étape

1. Version attendue lue au moment de l'**envoi** : deux onglets partageant le cache
   pouvaient écraser une écriture sans conflit → version observée à la **lecture**.
2. Lecture **hors transaction** (ex. `updateAccount` lit puis écrit) : la version, capturée
   plus tard, pouvait être plus récente que les données lues (écriture perdue démontrée
   après une réponse perdue) → observations à l'échelle de l'opération publique
   (`runOperation`), et résolution du lot non confirmé avant les lectures.

### 6.8 Tests et résultats

`src/data/cloud/protocol.test.ts` (38 tests, fake-indexeddb, utilisateurs fictifs ; un
« appareil » = une fabrique IndexedDB distincte) :

| Exigence | Tests |
|---|---|
| Forme du lot, clé créée puis supprimée non transmise | 2 |
| Création (v1), modification (v + 1), suppression logique, réactivation, création sur clé existante | 4 |
| Scénario de référence à deux appareils (7 étapes) ; écritures concurrentes même clé (deux appareils, deux onglets) ; lecture hors transaction ; lot multi-tables en conflit ; clé déterministe sur deux appareils | 6 |
| Lot multi-tables atomique ; rejeu idempotent ; réutilisation frauduleuse ; 8 lots mal formés ; échec avant confirmation ; réponse perdue ; 5 réponses ambiguës ; résolution impossible ; échec du cache ; mode désactivé | 10 |
| Persistance à la réouverture, isolation par utilisateur, exclusion des sauvegardes et instantanés | 3 |
| 54 méthodes et suite variée : versions du cache ≡ serveur (tables synchronisées), `meta` locale | 1 |
| Tables locales (§ 6.10) : `meta` dans le cache et jamais transmise, autres tables transmises ; versions limitées aux tables synchronisées ; atomicité (conflit, échec du cache, panne sur l'écriture locale) ; réponse perdue (rejouée / abandonnée) ; lot purement local sans appel serveur ; refus serveur | 7 |
| Protection de `CloudCacheDB` (§ 6.10) : refus de `nexora` sans création de base ; préfixe, autre utilisateur, identifiant invalide ; nom valide (version 2) ; base `nexora` jamais mise à jour ; `CloudRepository` | 5 |

**Contrôles par mutation** (code cassé puis restauré) : serveur sans contrôle de version
(7 tests en échec), version lue à l'envoi (1), lecture hors transaction non observée (1),
pas d'idempotence (2), échec réseau non retenu (3), versions écrites avant confirmation (7),
réponse non vérifiée (1), pas de résolution avant l'écriture (1), abandon non respecté (1),
version supprimée non conservée (4) — **10 sur 10 détectées**. Tables locales et
protection du cache : `meta` non séparée (60), écritures locales avant confirmation (4), lot
local envoyé au serveur (1), écritures locales hors de la transaction confirmée (1 — détectée
après ajout du test « panne sur l'écriture locale »), serveur acceptant `meta` (1), garde du
constructeur retirée (3) — **6 sur 6 détectées**.

**Résultat** : `npm run check` — typecheck OK, **15 fichiers, 455 tests, 455 réussis**
(417 des étapes précédentes + 38 nouveaux), build OK. Aucune migration modifiée.

### 6.9 Limites et dépendances

* **R3 partiellement traité** : prouvé sur le serveur simulé ; reste le contrôle dans
  PostgreSQL (4.4–4.5) et la qualification HTTP (4.6).
* **4.4 (`apply_changeset`) doit reproduire `MemoryTransport`** : table des lots traités
  par utilisateur (identifiant, empreinte, résultat, statut appliqué / abandonné) pour
  l'idempotence et `resolve` ; vérification de toutes les versions avant écriture ; une
  seule écriture par clé (version + 1) ; `delete` = `deleted_at` non nul ; `put` sur une
  ligne supprimée = `deleted_at` remis à `null` (§ 5.7) ; codes d'erreur distincts pour
  conflit, protocole et isolation ; taille maximale mesurée (D4-6).
* **Table `meta`** : traitée (§ 6.10) — locale, jamais transmise ; `apply_changeset` n'a
  pas à la connaître et aucune table PostgreSQL `meta` n'est créée.
* **Premier usage d'un appareil** : sans récupération initiale (Lot 5), `ensureUser` crée
  `users` / `settings` avec `expectedVersion = null` alors que le serveur possède déjà le
  profil (`handle_new_user`) ou les paramètres d'un autre appareil → conflit. La
  récupération initiale est un préalable à toute écriture cloud réelle.
* **Après un conflit**, le cache reste dans son état antérieur : le rechargement relève du
  Lot 5 ; réessayer sans recharger produit le même conflit.
* **Lot non confirmé** : conservé en mémoire seulement (perdu à la fermeture ; rattrapage
  par la récupération du Lot 5). Les méthodes en lecture seule (`snapshot`…) ne déclenchent
  pas de résolution.
* Aucun transport réseau, aucune authentification, aucun `supabase-js` (Lot 5 / 6).

### 6.10 Tables locales (`meta`) et protection du cache

**Constat** (vérifié dans le code) : `meta` ne contient que `{ key: 'schemaVersion',
value: 1 }`, écrit par `ensureUser` (et donc `resetToEmpty`) ; **aucune méthode ne la lit**
(`exportBackup` / `restoreBackup` utilisent la constante `SCHEMA_VERSION`) ; elle ne fait pas
partie de `USER_TABLES`. C'est une information purement locale.

**Distinction cache local / serveur** : la liste de référence des tables locales est
`EXCLUDED_TABLES` du mapping (aujourd'hui `meta` seule), sans duplication.

* `CloudStorage` sépare, à la fin de chaque transaction, les opérations destinées au serveur
  (le `ChangeSet`) des écritures locales. Une écriture locale n'est **jamais** transmise et
  ne reçoit **aucune** version serveur.
* Les écritures locales sont appliquées dans **la même transaction Dexie** que les lignes et
  versions confirmées : un conflit, un refus ou un échec d'écriture du cache — y compris une
  panne sur l'écriture locale elle-même — n'écrit rien du tout (testé).
* **Lot non confirmé** : ses écritures locales sont conservées avec lui ; appliquées
  seulement lors d'une résolution qui confirme le lot (`replayed`), **abandonnées** avec lui
  s'il ne l'a jamais été (testé).
* **Lot purement local** : appliqué au cache dans une transaction Dexie, sans aucun appel au
  serveur (même en mode désactivé, puisque rien n'est demandé au serveur). Aucune méthode ne
  produit aujourd'hui un tel lot.
* `MemoryTransport` (et demain `apply_changeset`) refuse toute table de `EXCLUDED_TABLES`
  (`invalid_changeset`). Aucune table PostgreSQL `meta` n'est créée.
* **Équivalence** : `meta` reste écrite dans le cache comme dans la base locale ; la
  comparaison « base locale ≡ cache cloud » du Lot 2 (toutes tables, `meta` comprise) est
  inchangée et réussie ; les 54 méthodes sont inchangées.

**Protection du constructeur `CloudCacheDB`** : `new CloudCacheDB(name, { userId, dexie? })`.
Avant même la construction de la base Dexie, le nom est contrôlé (`assertCloudCacheName`) :
`nexora` refusé ; préfixe `nexora-cache-` obligatoire ; nom exactement égal à
`nexora-cache-<userId>` (identifiant au format autorisé). Un nom refusé ne crée aucune base,
et la version 2 (table annexe) ne peut jamais être déclarée sur la base locale réelle : un
test crée une base `nexora` (fabrique simulée), tente `new CloudCacheDB('nexora', …)`, puis
vérifie qu'elle est toujours en version 1, sans table annexe, données intactes.
`CloudStorage` conserve son propre contrôle (défense en profondeur) ; le schéma de
`NexoraDB` est inchangé.

## 7. Étape 4.4 — `apply_changeset` (PostgreSQL)

> Implémentation et **tests exploratoires** (PostgreSQL 16.15 et 17.11 éphémères, profils
> standard et « supabase-like »). La **qualification formelle** relève de 4.5 (SQL) et 4.6
> (HTTP, pile Supabase locale dans Codespaces). Rien n'est déclaré qualifié ici.

### 7.1 Livrables

| Fichier | Contenu |
|---|---|
| `supabase/migrations/20261101000800_apply_changeset.sql` | Rôle `nexora_writer` ; `private.request_uid()` ; liste blanche `private.changeset_tables` ; suivi `private.changesets` ; `private.changeset_error()` ; `public.apply_changeset(jsonb)` ; `public.resolve_changeset(text)` ; politiques et privilèges ; révocation D4-1 |
| `supabase/db-tests/11_apply_changeset.sql` | 258 assertions (nominal, versions, atomicité, idempotence, sécurité, forme, taille, concurrence à deux sessions) |
| `src/data/cloud/applyChangeset.test.ts` | 4 tests : liste blanche SQL ≡ mapping (4.2), enveloppe ≡ protocole v1 (`transport.ts`), aucune table `meta`, migrations 1–7 intactes |

Migrations 1 à 7 : **inchangées**. Aucun code applicatif modifié (aucun transport, aucun
`supabase-js`, `CloudRepository` non connecté).

### 7.2 Signature et format filaire

```sql
public.apply_changeset(p_changeset jsonb) returns jsonb     -- SECURITY DEFINER, owner nexora_writer
public.resolve_changeset(p_changeset_id text) returns jsonb -- SECURITY DEFINER, owner nexora_writer
```

Enveloppe = protocole v1 (`transport.ts`), **dont la table, la clé et la ligne sont exprimées
sous forme SQL par le mapping TS** (étape 4.2 ; « la conversion SQL appartient au transport ») :

```jsonc
// requête
{ "protocol": 1, "changesetId": "<uuid>", "userId": "<uuid = auth.uid()>",
  "ops": [
    { "table": "accounts", "type": "put", "key": { "id": "<uuid>" }, "expectedVersion": null,
      "row": { /* exactement les colonnes écrites (serializeRow().values) */ } },
    { "table": "recurring_occurrences", "type": "delete",
      "key": { "rule_id": "<uuid>", "due_date": "2026-03-31" }, "expectedVersion": 3 } ] }
// réponse
{ "changesetId": "<uuid>", "status": "applied" | "replayed",
  "versions": [ { "table": "accounts", "key": { "id": "<uuid>" }, "version": 1, "deleted": false }, … ] }
// resolve_changeset
{ "changesetId": "<uuid>", "status": "replayed", "versions": [ … ] }   // appliqué
{ "changesetId": "<uuid>", "status": "abandoned" }                    // jamais appliqué, ne le sera jamais
// erreur changeset_pending                                           // issue pas encore déterminée
```

Le transport HTTP (Lot 5) convertira dans les deux sens avec `sqlTableOf` / `tableOfSql`,
`toSqlKey` / `fromSqlKey` et `serializeRow` ; `checkCommitResult` s'applique après
conversion inverse. Aucune seconde définition du protocole.

### 7.3 Traitement d'un lot

1. **Identité** : `private.request_uid()` (mêmes sources que `auth.uid()` : `request.jwt.claim.sub`
   puis `request.jwt.claims->>'sub'`, testé équivalent) ; absente ou invalide → `unauthorized`.
   `userId` du lot ≠ utilisateur authentifié → `unauthorized`.
2. **Enveloppe** : objet ; champs exactement `protocol, changesetId, userId, ops` ; `protocol = 1`
   (nombre) ; UUID ; `ops` tableau non vide ; taille (§ 7.8).
3. **Verrou par utilisateur** (§ 7.5), puis **idempotence** (§ 7.6) : un lot déjà appliqué est
   renvoyé (`replayed`) avant toute autre vérification.
4. **Phase 1 — forme** de chaque opération, sans lecture métier : table de la liste blanche
   (`meta` et toute autre → `unsupported_table`) ; `type` ; `expectedVersion` entier 1…2⁵³−1 ou
   `null` ; clé = exactement les colonnes de la clé primaire ; une opération par clé ; `put` :
   ligne = exactement les colonnes écrites, **aucune métadonnée serveur**, clé cohérente ;
   `delete` sans ligne ; propriétaire de la clé et de la ligne = utilisateur authentifié.
5. **Phase 2 — versions** : chaque ligne visée est lue `FOR UPDATE` ; **toutes** les versions
   sont comparées avant la première écriture ; un seul écart → `version_conflict` (liste
   complète des écarts), rien n'est écrit.
6. **Phase 3 — écritures**, dans l'ordre du lot : création (`INSERT`), modification ou
   réactivation (`UPDATE` des colonnes écrites hors clé, `deleted_at = NULL`), suppression
   logique (`UPDATE … deleted_at = now()`). Toute erreur annule le lot entier.
7. Enregistrement du lot dans `private.changesets`, confirmation renvoyée.

Les contraintes différées (clés étrangères, unicités par exclusion) sont vérifiées à la
validation de la transaction de la requête : un échec annule aussi l'enregistrement du lot.

### 7.4 Versions, suppression logique, métadonnées serveur

Conditions identiques à `MemoryTransport` (§ 6.3) : création `null` ⇔ clé inexistante (ni
active ni supprimée) ; modification / réactivation v ⇔ version actuelle v ; suppression v ⇔
ligne active en version v. `version`, `sync_txid`, `server_updated_at` et `deleted_at` restent
calculés par le déclencheur existant `private.tg_sync_metadata` (aucun second mécanisme) :
INSERT → version 1 ; UPDATE → version + 1 ; `deleted_at` non nul → horodatage `now()` du
serveur (la valeur envoyée par la fonction n'est qu'un signal) ; `deleted_at = NULL` →
réactivation. Aucune suppression physique (aucun `DELETE`, aucun privilège `DELETE`).
Colonnes immuables (`id`, `user_id`, `created_at`) : protégées par le déclencheur (`42501`
→ `invalid_row`).

### 7.5 Verrouillage et concurrence

* **`pg_advisory_xact_lock` par utilisateur** (clé : `hashtextextended('nexora.changeset:' || uid)`),
  pris avant toute lecture, libéré à la fin de la transaction : un seul lot ou une seule
  résolution à la fois **par utilisateur**, tous appareils confondus. Justification : rend
  sûres, sans interblocage, (a) les créations concurrentes d'une même clé (qu'un `FOR UPDATE`
  ne peut pas verrouiller, la ligne n'existant pas), (b) les soumissions concurrentes d'un
  même `changesetId`, (c) l'ordre des verrous de lignes ; le débit d'un même utilisateur est
  faible. Deux utilisateurs différents ne se bloquent jamais (collision de hachage : simple
  attente, jamais d'erreur).
* **`SELECT … FOR UPDATE`** sur chaque ligne visée (défense en profondeur).
* Testé avec deux sessions réelles (`dblink`) : même version initiale → la seconde reçoit
  `version_conflict`, l'écriture acceptée n'est pas écrasée (version 2) ; même lot en
  parallèle → `applied` puis `replayed`, appliqué une fois ; création concurrente d'une
  clé → conflit pour la seconde ; résolution pendant un lot en cours → `changeset_pending`.

### 7.6 Idempotence et résolution (`private.changesets`)

| Colonne | Rôle |
|---|---|
| `(user_id, changeset_id)` | clé primaire : identifiant unique **dans le périmètre utilisateur** |
| `status` | `applied` / `abandoned` |
| `fingerprint` | SHA-256 du lot reçu sous forme `jsonb` canonique (ordre des champs indifférent) |
| `op_count`, `result` | confirmation renvoyée (tables, clés, versions — aucune donnée métier) |

Même identifiant + même empreinte → `replayed` (résultat d'origine, rien réappliqué) ;
empreinte différente → `changeset_id_reused` ; lot abandonné → `changeset_abandoned`.
`resolve_changeset` : appliqué → `replayed` ; inconnu → enregistré **abandonné** (il ne sera
jamais appliqué) ; verrou non obtenu en 5 s → `changeset_pending` (issue non encore
déterminée, rien n'est modifié). Suppression du compte : cascade depuis `auth.users`.

### 7.7 Codes d'erreur

Format PostgREST : `{ code: SQLSTATE, message: <code du protocole>, details: <JSON> }` ;
un SQLSTATE `PTxxx` fait renvoyer le statut HTTP `xxx`. Aucun détail ne porte sur les
données d'un autre utilisateur.

| Code du protocole | SQLSTATE / HTTP | Cas |
|---|---|---|
| `unauthorized` | `PT403` / 403 | non authentifié, `userId` ou propriétaire d'une ligne / clé ≠ utilisateur |
| `unsupported_protocol` | `PT400` / 400 | `protocol` ≠ 1 |
| `invalid_changeset` | `PT400` / 400 | enveloppe mal formée, UUID invalide, lot vide, deux opérations sur une clé |
| `unsupported_table` | `PT400` / 400 | table hors liste blanche (dont `meta`) |
| `invalid_operation` | `PT400` / 400 | type, champ ou `expectedVersion` invalides ; suppression ou création d'un profil |
| `invalid_key` | `PT400` / 400 | colonnes de clé, valeur, incohérence clé / ligne |
| `invalid_row` | `PT400` / 400 | colonnes inexactes, métadonnée serveur, type invalide, `CHECK`, `NOT NULL`, colonne immuable (`details.sqlstate`, `details.constraint`, `details.op`) |
| `changeset_too_large` | `PT413` / 413 | > 5 000 opérations ou > 4 Mio |
| `version_conflict` | `PT409` / 409 | `details.conflicts[] = { table, key, expectedVersion, actualVersion, actualDeleted }` |
| `duplicate_key` | `PT409` / 409 | clé primaire déjà prise par une ligne invisible (autre utilisateur, P7) |
| `changeset_id_reused` | `PT409` / 409 | même identifiant, autre contenu |
| `changeset_abandoned` | `PT409` / 409 | lot abandonné lors d'une résolution |
| `changeset_pending` | `PT409` / 409 | (`resolve_changeset`) issue non encore déterminée |
| *(`replayed`)* | 200 | n'est pas une erreur : statut de la réponse |
| `23503` / `23P01` (SQLSTATE natifs) | 409 (PostgREST) | contrainte **différée** (référence, unicité par exclusion) à la validation → côté client : `invalid_row` / `duplicate_key` |
| `42501` (permission) | 401/403 | `anon` ou écriture directe sur une table |

Correspondance avec le client TS (Lot 5) : `version_conflict` → `CloudConflictError` ;
`invalid_*`, `unsupported_*`, `changeset_id_reused`, `changeset_abandoned` →
`CloudProtocolError` (codes à étendre) ; `unauthorized` → refus définitif ;
`changeset_pending`, réseau → `CloudTransportError` (lot conservé non confirmé, § 6.5).

### 7.8 Taille maximale (D4-6) — mesures

Lots réels produits par `CloudRepository` à partir du jeu de démonstration, convertis par le
mapping (un utilisateur fictif et des identifiants neufs par volume ; volume multiplié en
dupliquant les transactions simples), appliqués après leur lot `ensureUser`, contraintes
différées comprises, sur PostgreSQL éphémère :

| Lot | Opérations | JSON | PG 16.15 (application + différées) | PG 17.11 | Rejeu |
|---|---|---|---|---|---|
| `ensureUser` | 40 | 18 Ko | — | — | — |
| Démo (restauration complète, 239 transactions, 14 tables) | 456 | 0,32 Mo | 0,33 s | 0,38 s | 6–9 ms |
| ×5 (967 transactions) | 1 184 | 1,0 Mo | 0,77 s | 0,94 s | 14 ms |
| ×10 (1 877 transactions) | 2 094 | 1,8 Mo | 1,36 s | 2,08 s | 26–40 ms |
| ×20 (3 697 transactions) | 3 914 | 3,5 Mo | 2,88 s | 3,82 s | 64 ms |

Chaque lot : **100 % des lignes relues identiques** à celles envoyées (hors métadonnées
serveur) et suppressions logiques effectives. Coût **linéaire** (≈ 0,7 à 1 ms par
opération) — une première version était quadratique (concaténations `jsonb` dans la
boucle, 8,5 s pour ×20) et a été corrigée.

**Limite proposée : 5 000 opérations et 4 Mio de JSON** (≈ 4 à 5 s sur ces bancs) : couvre
le volume ×20 de la démo (≈ 3 700 transactions) avec une marge, et reste sous l'ordre de
grandeur du `statement_timeout` que Supabase applique au rôle `authenticated` (de quelques
secondes ; **valeur exacte, limite de taille des requêtes de la passerelle et performances
de la pile Supabase non mesurées ici** : à vérifier en 4.6). Un lot plus volumineux
(restauration d'une très grosse sauvegarde) devra être découpé — ce qui casse l'atomicité
de la restauration : à traiter avec R1 (Lot 7). Une opération courante produit de 1 à
quelques dizaines d'opérations.

### 7.9 Droits PostgreSQL

| Rôle | Tables métier (17) | `profiles` | `private.*` | Fonctions |
|---|---|---|---|---|
| `anon` | aucun | aucun | aucun | aucune |
| `authenticated` | **SELECT seul** (INSERT / UPDATE révoqués, D4-1) | SELECT | aucun | EXECUTE `apply_changeset`, `resolve_changeset` |
| `nexora_writer` (NOLOGIN, sans BYPASSRLS, propriétaire des 2 fonctions) | SELECT, INSERT, UPDATE + politiques `user_id = request_uid()` | SELECT, UPDATE (`display_name`) + politiques `id = request_uid()` | SELECT liste blanche ; SELECT, INSERT suivi (+ RLS) ; EXECUTE fonctions internes | — |

* `SECURITY DEFINER` est nécessaire : sans écriture directe, `authenticated` ne pourrait pas
  écrire en `SECURITY INVOKER`. Le propriétaire n'est **pas** `postgres` mais un rôle sans
  `BYPASSRLS` : la **RLS forcée reste appliquée** dans la fonction (défense en profondeur) et
  l'isolation ne dépend pas de `BYPASSRLS` sur la plateforme (P10).
* `search_path = ''`, objets qualifiés ; noms de tables et colonnes issus uniquement de la
  liste blanche statique (`format('%I')`), valeurs passées en paramètres (`USING`) et typées
  par `jsonb_populate_record` : aucune injection (testé avec un nom de colonne malveillant).
* `authenticator` (PostgREST) n'est pas membre de `nexora_writer` ; `PUBLIC`, `anon` et
  `service_role` n'exécutent pas les fonctions. `CREATE` sur `public` n'est accordé à
  `nexora_writer` que le temps du transfert de propriété.
* Inchangé : `handle_new_user`, déclencheurs, `service_role` (contourne la RLS par
  conception) ; les politiques `… to authenticated` d'insertion / mise à jour du Lot 3
  restent en place mais sont **inertes** (plus de privilège).

### 7.10 Résultats des tests (exploratoires)

**Suite 11** (version finale, migration identique à celle mesurée au banc D4-6) :

| Environnement | Suite 11 | Banc D4-6 |
|---|---|---|
| PostgreSQL 16.15, profil standard | **258 / 258** | 12 / 12 |
| PostgreSQL 17.11 (paquet npm, comme 3b) | **258 / 258** | 12 / 12 |
| PG 16 « supabase-like », `postgres` non superutilisateur **avec** BYPASSRLS (= pile Supabase locale, Q1) | **258 / 258** | — |
| PG 16 « supabase-like », `postgres` **sans** BYPASSRLS | non exécutable : création des utilisateurs de test impossible (`handle_new_user`, **P10 préexistant**, identique sans migration 8) | — |
| `npm run check` | 16 fichiers, **459 / 459** (455 + 4), build OK | — |

**Contrôles par mutation** (copie temporaire de la migration, suite 11 finale ; détection par
assertions, sans blocage ni interruption) :

| # | Mutation | Échecs | Détection |
|---|---|---|---|
| S1 | contrôle de version retiré | 31 | assertions |
| S2 | réactivation sans `deleted_at = NULL` | 1 | assertion |
| S3 | verrou par utilisateur retiré | 4 | 3 assertions déterministes (même lot en parallèle → `version_conflict` au lieu de `replayed` ; création concurrente → `duplicate_key` au lieu de `version_conflict`) + 1 assertion bornée (résolution pendant un lot : pas de `changeset_pending` en 10 s) |
| S4 | idempotence retirée | 7 | assertions |
| S5 | contrôle du propriétaire retiré (clé et ligne) | 6 | assertions (la RLS du rôle d'écriture empêche toujours l'écriture : défense en profondeur ; seul le code d'erreur change) |
| S6 | révocation D4-1 absente | 36 | assertions |

Défauts du banc corrigés pendant ces contrôles (aucune modification de la migration) :
sans le verrou par utilisateur, `resolve_changeset` attend la ligne non validée de
`private.changesets` alors que la validation est commandée par la session de test → attente
circulaire entre sessions, que PostgreSQL ne détecte pas (suite bloquée jusqu'au délai de
900 s) ; les scénarios concurrents attendent désormais de **constater** le blocage de la
seconde session (`pg_locks`) au lieu d'une pause, la résolution est envoyée en asynchrone
avec attente bornée puis annulation, et l'annulation (`query_canceled`, non couverte par
`WHEN OTHERS`) est interceptée. Défauts de la fonction corrigés pendant l'étape : coût
quadratique (§ 7.8) et index d'opération erroné dans `invalid_row` (variable de boucle
PL/pgSQL masquant la variable externe).

**Anciennes suites (Lot 3)** — même résultat sur PG 16, PG 17 et « supabase-like » avec
BYPASSRLS ; « avant » = migrations 1–7 (1 106 / 1 106, et 1 152 / 1 152 en « supabase-like »,
identiques au Lot 3B) :

| Suite | Avant migration 8 | Après migration 8 | Cause | Action nécessaire (D4-9) |
|---|---|---|---|---|
| 01_catalog | 556 / 556 | 554 / 662 (108 échecs) | invariants devenus faux : politiques « `to authenticated` filtrées par `auth.uid()` », « 53 politiques », « aucune fonction dans `public` » | réécrire ces invariants pour l'état final (politiques du rôle d'écriture, 2 RPC autorisées) ; ajouter « aucune écriture d'`authenticated` » |
| 02_isolation | 297 / 297 | interrompue (l. 75) | B tente des `UPDATE` directs : `permission denied` (42501) au lieu de 0 ligne | préparation des données en administrateur ; tentatives d'écriture de B → refus 42501, puis par `apply_changeset` → `unauthorized` / conflit |
| 03_triggers | 20 / 20 | interrompue (l. 46) | écritures directes en `authenticated` | passer par `apply_changeset` (métadonnées serveur) ou par l'administrateur |
| 04_constraints | 122 / 122 | 23 / 122 (99 échecs) | insertions directes des cas « acceptés » | passer par `apply_changeset` (cas acceptés → `applied` ; refusés → `invalid_row` + SQLSTATE d'origine) |
| 05_relations | 7 / 7 | 0 / 7 | idem (références croisées, contraintes différées) | idem |
| 06_soft_delete | 16 / 16 | interrompue (l. 97) | `UPDATE … deleted_at` direct | suppression / réactivation par `apply_changeset` |
| 07_sync | 16 / 16 | 16 / 16 | écrit en administrateur | aucune |
| 08_lifecycle | 44 / 44 | interrompue (l. 38) ; sans révocation : 3 échecs | mise à jour directe du profil ; invariants « une seule fonction SECURITY DEFINER », « fonctions de `private` = déclencheurs » | profil via `apply_changeset` ; invariants à mettre à jour |
| 09_harness_security | 15 / 15 | 15 / 15 | — | aucune |
| 10_api_serialization | 13 / 13 (17 « supabase-like ») | idem | écrit en administrateur | aucune |
| P1_supabase_platform | 42 / 42 | 41 / 42 | Q5 « aucune fonction RPC dans `public` » | autoriser exactement les 2 RPC, avec leurs droits |
| `http/rls.mjs` (143, 4.6) | 143 / 143 (3b) | non exécuté ici | écritures directes par PostgREST | convertir en tests de refus + écritures via `/rpc/apply_changeset` |

Sans la révocation (contrôle séparé), seuls 01 (108) et 08 (3) échouent : les autres échecs
viennent uniquement de D4-1.

### 7.11 Décisions à valider

| # | Question | Options | Recommandation |
|---|---|---|---|
| D4-9 | Adaptation des suites qualifiées du Lot 3 (périmètre : tableau § 7.10 — 01, 02, 03, 04, 05, 06, 08, P1, `rls.mjs` ; 07, 09, 10 inchangées) | (a) adapter 01–10 : écritures de préparation en administrateur, écritures d'`authenticated` converties en **tests de refus** (42501) ou passées par `apply_changeset`, invariants du catalogue mis à jour (rôle d'écriture, 2 RPC) ; nouvelle référence PG 16 ; (b) faire tourner les suites du Lot 3 sur les migrations 1–7 seulement et la suite 11 sur 1–8 | **(a)** : la qualification doit porter sur l'état final ; (b) laisserait l'état de production sans preuve d'isolation |
| D4-10 | Rôle propriétaire des fonctions | `nexora_writer` dédié (implémenté) ; ou `postgres` | `nexora_writer` (RLS maintenue, indépendant de `BYPASSRLS`). **À vérifier en 4.6 sur Supabase** : création du rôle et transfert de propriété par `postgres` |
| D4-11 | Format filaire | noms SQL (implémenté, mapping côté client) ; ou noms TS convertis par le serveur | noms SQL : une seule correspondance, dans `mapping.ts` |
| D4-12 | Limite D4-6 | 5 000 opérations / 4 Mio (implémenté) | valider, sous réserve de la mesure du `statement_timeout` et de la taille de requête en 4.6 |
| D4-13 | Écarts assumés avec `MemoryTransport` | serveur : identifiant de lot par utilisateur (MemoryTransport : global) ; création de profil refusée (`invalid_operation`) ; `changeset_pending` | aligner `MemoryTransport` au Lot 5 (avec le transport HTTP) |

### 7.12 Limites et reports

* Non qualifié : 4.5 (suites SQL adaptées, PG 16/17, référence) et 4.6 (HTTP, deux
  utilisateurs réels, `statement_timeout`, taille de requête, rôle `nexora_writer` sur la
  pile Supabase) restent à faire.
* Premier `ensureUser` : la ligne `profiles` existe déjà (déclencheur) → `version_conflict`
  tant que la récupération initiale (Lot 5) n'a pas fourni sa version.
* Table de suivi : croît d'une ligne par lot ; purge à définir (Lot 8, avec P5).
* `changesetId` réutilisé par un autre utilisateur : traité comme un lot distinct (périmètre
  utilisateur), sans fuite d'information.
* R1 (restauration entre utilisateurs, `duplicate_key`), R3 (rechargement après conflit,
  Lot 5) et P10 (hébergé) restent ouverts.
