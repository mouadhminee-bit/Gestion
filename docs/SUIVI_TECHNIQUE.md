# NEXORA — Suivi technique (réserves et points ouverts)

Registre des réserves formulées lors des validations de lots. Une réserve est levée
uniquement par un lot validé qui la traite explicitement (test à l'appui).

## Réserves bloquantes pour l'activation du cloud en production

| # | Réserve | Origine | Traitement prévu | Condition de levée |
|---|---|---|---|---|
| R1 | **Restauration de sauvegardes entre utilisateurs** : `restoreBackup` réutilise les identifiants de la sauvegarde. En local (même base), restaurer chez u2 la sauvegarde de u1 réattribue les lignes de u1 ; côté PostgreSQL, la clé primaire globale provoquerait une collision. **V3.4-d (arbitrage A2)** : en mode aligné, cette restauration sur le même serveur est refusée (`duplicate_key`), rien n'est écrit — attendu par `contract.test.ts` ; remappage reporté à V5. | Lot 2 (test `it.fails` dans `contract.test.ts`) | Lot 7 : remappage complet des identifiants (y compris références et clés textuelles d'échéances / notifications) | Le test `it.fails` devient un test normal et passe ; restauration d'une même sauvegarde dans deux comptes sans collision |
| R2 | **Atomicité de `saveAsset` et de la valorisation initiale** : l'actif et sa première valorisation sont écrits dans deux opérations distinctes. Constat complémentaire (audit Lot 4) : la valorisation était validée **après** l'écriture de l'actif (valorisation invalide → actif créé puis erreur, y compris en mode local) ; `resetToEmpty` enchaînait trois écritures non atomiques. | Lot 2 (§ 8.7 du rapport) | **Lot 4, étape 4.1** : `saveAsset` et `resetToEmpty` en une seule transaction, validations avant toute écriture | Panne simulée entre les deux écritures → ni actif ni valorisation (test sur les deux repositories) — **corrigée et testée à l'étape 4.1 (23 tests, contrôles par mutation, `docs/LOT4_PLAN.md` § 4) ; levée formelle à la validation du Lot 4** |
| R3 | **Concurrence entre plusieurs appareils** : `CloudRepository` sérialise les appels d'une instance, mais deux appareils peuvent modifier la même ligne. | Lot 2 (§ 8.1) | Lot 3 : colonne `version` et métadonnées de synchronisation ; Lot 4 : contrôle de version optimiste dans `apply_changeset` (rejet + rechargement, sans fusion automatique) ; Lot 5 : récupération des changements | Test à deux clients : la seconde écriture concurrente sur une ligne est rejetée avec un conflit, aucune donnée n'est perdue — **partiellement réalisé (étape 4.3)** : protocole ChangeSet v1 (versions attendues, `changesetId`), versions dans le cache, serveur simulé : la seconde écriture concurrente est rejetée en entier, rien n'est perdu (deux appareils, deux onglets, lecture hors transaction — `docs/LOT4_PLAN.md` § 6). **Étape 4.4 (implémentée, non qualifiée)** : contrôle optimiste dans PostgreSQL (`apply_changeset`, migration 8) — toutes les versions vérifiées avant écriture, verrou par utilisateur ; testé avec deux sessions réelles (seconde écriture → `version_conflict`, rien d'écrasé) sur PG 16/17 éphémères (`docs/LOT4_PLAN.md` § 7). ~~**Restent** : qualification 4.5 (suites adaptées) et 4.6 (HTTP), rechargement après conflit (Lot 5)~~ — **mis à jour (Lot 0)** : contrôle optimiste qualifié sur la pile Supabase **locale** (suites adaptées : SQL 1 847 / 1 847 ; HTTP 302 / 302 avec deux utilisateurs réels : seconde écriture concurrente → `version_conflict`, rien d'écrasé ; deux requêtes simultanées → une seule acceptée), reproduit à l'identique dans le Codespace (`docs/LOT0_QUALIFICATION.md` § 10). **Restent** : qualification hébergée, rechargement après conflit (Lot 5) |

## Points ouverts (non bloquants, à suivre)

| # | Point | Origine | Lot |
|---|---|---|---|
| P1 | Cache cloud en retard si l'écriture du cache échoue après acceptation du serveur. **Atténué à l'étape 4.3** : le résultat accepté est conservé et réappliqué avant toute nouvelle écriture (`CloudCacheWriteError`) ; perdu si l'application est fermée entre-temps → rattrapage par la récupération des changements. **V3.4** : le chargement complet exécuté à chaque ouverture de session ou rechargement remplace le cache par l'état du serveur, ce qui rattrape un tel écart dès que ce chargement réussit ; effectif dans l'application une fois les écritures Cloud branchées (V3.5). **Effectif depuis V3.5** (écritures branchées ; chargement complet à chaque ouverture de session) | Lot 2 § 8.2 | 5 |
| P2 | `ChangeSet` sans version ; correspondance des tables `users` / `meta` vers le serveur. **Correspondance traitée à l'étape 4.2** (`src/data/cloud/mapping.ts` : `users` → `profiles` en mise à jour seule, `meta` exclue — `docs/LOT4_PLAN.md` § 5) ; **version du `ChangeSet` : traitée à l'étape 4.3** (protocole v1, `docs/LOT4_PLAN.md` § 6) ; `meta` exclue du protocole (locale, jamais transmise, refusée par le serveur simulé — § 6.10) | Lot 2 § 8.3 | 4 |
| P3 | Références orphelines possibles dans les données locales existantes (suppressions physiques en IndexedDB : compte supprimé encore référencé par un objectif, etc.) : à détecter et réparer avant toute migration des données Edge | Cadrage Lot 3 | lot « migration Edge » |
| P4 | Pièces jointes exclues des sauvegardes JSON alors que `transactions.attachmentId` est conservé. **Traité par le correctif Backup / Restore v2 (en attente de validation)** : pièces jointes exportées (base64) et restaurées ; une pièce jointe référencée mais absente du fichier (fichier v1) est conservée localement (`docs/BACKUP_RESTORE.md` § 5, tests « 14 » et « 20 ») | existant | v2 / 7 (stockage distant) |
| P5 | Purge des lignes supprimées logiquement (croissance des tombstones) | Cadrage Lot 3 | 8 |
| P6 | `restoreBackup` ne valide aucune ligne : une sauvegarde corrompue ou modifiée à la main peut contenir des valeurs que le schéma refuse. Valider les sauvegardes avant écriture. **Traité par le correctif Backup / Restore v2 (en attente de validation)** : migration et validation stricte (structure, types, identifiants, relations) avant toute écriture, transaction unique contrôlée après écriture (`docs/BACKUP_RESTORE.md` § 2–4 ; 51 tests Local + Cloud) | Lot 3 (rapport § 8) | v2 |
| P7 | Réutiliser l'UUID d'une ligne d'autrui provoque une collision de clé (23505) : révèle l'existence d'un UUID aléatoire, sans accès aux données | Lot 3 | 7 (avec R1) |
| P8 | Une transaction longue retient la borne de récupération (`pg_snapshot_xmin`) : aucune perte, mais retard de synchronisation | Lot 3 | 4–5 — **comportement vérifié sur la vraie fonction `pull_changes` (V4.1, suite 07 S1 : une transaction en cours retient la borne, la ligne validée après elle est différée puis récupérée, aucune perte)** ; reste une propriété assumée (retard, jamais de perte) |
| P9 | Qualification du schéma sur la vraie pile Supabase. **Pile Supabase locale : qualification réussie** (étape 3b, Codespaces : SQL 1 152/1 152, HTTP 143/143, 7 migrations, `major_version = 17` aligné). **Validation sur un projet hébergé : non réalisée** (3b-4 reportée). **Lot 0 (migrations 1 à 8)** : pile Supabase locale, SQL 1 847 / 1 847, HTTP 302 / 302, PostgreSQL 17.11, 1 793 assertions identiques à la référence PG 16 ; résultats reproduits à l'identique dans le Codespace (preuves `docs/qualification/lot4-local-*`). Hébergé : toujours non réalisé (P22) | Lot 3 (étape 3b) | 3b-4 |
| P10 | Inscription impossible si le rôle `postgres` n'a pas `BYPASSRLS` (déclencheur `handle_new_user`, RLS forcée sur `profiles`). **Résolu pour la pile Supabase locale testée** (Q1 positive ; profil créé à l'inscription vérifié par la suite HTTP 143/143). **Reste ouvert : vérification sur un projet hébergé**. Lot 0 : toujours vérifié sur la pile locale (inscription de deux utilisateurs réels, profil créé, HTTP 302 / 302) ; hébergé non réalisé (P22) | Étape 3b | 3b-4 |

## Points clos

| # | Point | Clôture | Preuves |
|---|---|---|---|
| P11 | Arrondi des `double precision` dans les réponses de l'API (l'image Supabase fixe `extra_float_digits = 0`) | **Clos pour la pile Supabase locale** — étape 3b, 01/11/2026. Sur un projet hébergé, l'application des réglages de rôle de la migration 7 reste à vérifier dans le cadre de P9 | Perte localisée à la sérialisation de la réponse (écriture et stockage exacts, bits vérifiés) ; correction par la migration 7 ; **143/143 HTTP et 8/8 contrôles de précision** sur la pile locale ; mutation sans migration 7 = mêmes 3 valeurs en échec (`docs/qualification/3b-pg17-local.md` § 6) |

Archivage des preuves : `docs/LOT3B_CLOTURE.md` § 3 (les rapports bruts de l'exécution
Codespaces sont à contrôler par `scripts/check-qualification-evidence.mjs` avant ajout).

Preuves archivées dans `docs/qualification/` (à contrôler par
`node scripts/check-qualification-evidence.mjs docs/qualification <préfixe>`) :

| Préfixe | Migrations | Résultats | Origine | Référence de complétude |
|---|---|---|---|---|
| `3b-local` | 1 à 7 | SQL 1 152, HTTP 143 | étape 3b, Codespace (01/11/2026) | `scripts/qualification-reference/3b-local.json` |
| `lot4-local` | 1 à 8 | SQL 1 847, HTTP 302 | Lot 0, **Codespace** (14/11/2026, 14:58 UTC) ; mêmes signatures que la session cloud, dont les preuves ne sont pas dans le dépôt | `scripts/qualification-reference/lot4-local.json` |

Le contrôleur vérifie la complétude par rapport à ces références (empreinte épinglée ; mise à
jour volontaire : `scripts/qualification-reference/README.md`). Les rapports antérieurs à la
remédiation du Lot 0 n'indiquent ni l'environnement, ni le commit, ni l'empreinte des
migrations ; les suivants les indiquent (`scripts/qualify-supabase.sh`).

## Points ouverts ajoutés à l'étape 4.4 (décisions en attente : `docs/LOT4_PLAN.md` § 7.11)

| # | Point | Lot |
|---|---|---|
| P12 | Les suites SQL du Lot 3 (01–10) et la suite HTTP `rls.mjs` reposent sur des écritures directes d'`authenticated` et sur des invariants que la migration 8 rend faux (politiques du rôle d'écriture, 2 RPC dans `public`) : adaptation à décider (D4-9) avant la qualification 4.5 / 4.6. **Traité (Lot 0, en attente de validation)** : suites adaptées à l'état final, 1 793 / 1 793 sur PG 16, 1 847 / 1 847 et HTTP 302 / 302 sur la pile Supabase locale (`docs/LOT0_QUALIFICATION.md`) | 4.5–4.6 |
| P13 | Rôle `nexora_writer` : création et transfert de propriété des fonctions par `postgres`, `statement_timeout` d'`authenticated` et taille maximale des requêtes de la passerelle à vérifier sur la pile Supabase (D4-10, D4-12). **Vérifié sur la pile Supabase locale (Lot 0)** : rôle créé et propriété transférée par `postgres` non superutilisateur ; `statement_timeout` d'`authenticated` = 8 s, lot de 5 000 opérations appliqué en 2,2 s ; lot > 4 Mio refusé par la fonction (413). **Reste ouvert : projet hébergé** | 4.6 |
| P14 | Croissance de `private.changesets` (une ligne par lot) : purge à définir | 8 |
| P15 | Écarts `MemoryTransport` / serveur (périmètre de `changesetId`, création de profil, `changeset_pending`, codes d'erreur, **clé canonique exigée par le serveur depuis le Lot 0**) : aligner avec le transport HTTP (D4-13). **Livré en V3.3 (plan directeur V1, 19/11/2026) ; levée complète conditionnée à la suppression du mode `legacy`.** `MemoryTransport` est aligné sur le serveur par défaut (lots propres à chaque utilisateur, identité de session, profil créé à l'inscription, clés canoniques, codes d'erreur du serveur, `changeset_pending`, clés primaires globales). Suite de contrat commune `src/data/cloud/transportContract.test.ts` : **12 scénarios exécutés sur les deux transports** (`MemoryTransport` aligné ; `HttpTransport` jusqu'à un serveur PostgREST simulé), **24 / 24**. Limites de couverture : la branche « création de profil interdite » n'est pas exercée (inatteignable pour un utilisateur inscrit) ; `changeset_too_large` n'est vérifié que par les tests HTTP. **Dérogation jusqu'à V3.4** : les cinq anciennes suites (`protocol.test.ts`, `contract.test.ts`, `backup.test.ts`, `undo.test.ts`, `historicalV1.test.ts`) restent temporairement en `{ legacy: true }` (comportement d'avant V3.3, attentes inchangées), pour ne pas anticiper V3.4 — en mode aligné : 96 / 171 échecs, dont 90 `invalid_key` (identifiants fictifs non canoniques), et création du profil par `ensureUser` sans version connue. **Suppression du mode `legacy` obligatoire avant V3.5.** Conditions de levée : (1) V3.4 a fourni le chargement initial et la version du profil ; (2) les cinq anciennes suites utilisent des UUID canoniques et des horodatages valides ; (3) leurs attentes sont alignées sur les codes d'erreur du serveur ; (4) la branche `legacy` et les mécanismes historiques associés (`IsolationViolationError`, identifiants de lot globaux) sont supprimés ; (5) tous les tests passent en mode aligné **Levé en V3.4-d (plan directeur V1, 20/11/2026)** : les cinq conditions sont satisfaites — (1) chargement initial et version du profil fournis par V3.4-a et V3.4-b ; (2) UUID canoniques et horodatages valides dans les cinq suites ; (3) attentes alignées sur les codes du serveur ; (4) mode `legacy`, `apply` / `validateShape` / `resolveLegacy`, identifiants de lot globaux et `IsolationViolationError` supprimés de `MemoryTransport`, code `unknown_changeset` retiré de `CloudProtocolErrorCode` ; (5) 171 / 171 tests des cinq suites en mode aligné (assertions 444 → 448, aucune retirée). Voir la section V3.4 ci-dessous | V3.3 : livré ; **levé en V3.4-d** |

## Points ouverts ajoutés par le correctif Backup / Restore v2 (`docs/BACKUP_RESTORE.md`)

| # | Point | Lot |
|---|---|---|
| P16 | Les liens historiques orphelins (avertissements non bloquants à la restauration : règle → compte supprimé, objectif → compte lié, etc.) sont acceptés en local et par `MemoryTransport`, mais le schéma PostgreSQL les refuse (clés étrangères différées, sauf `attachment_id`) : une restauration cloud serait rejetée en bloc. À traiter avec P3 (détection / réparation) avant toute restauration vers le cloud | 7 (avec P3) |
| P17 | Sauvegardes volumineuses : pièces jointes en base64 dans le JSON (+33 %), fichier lu intégralement en mémoire (limite d'interface 100 Mo). Format d'archive (ZIP : JSON + fichiers) proposé, non implémenté | 7 |
| P18 | La sauvegarde de sécurité est téléchargée avant le remplacement ; son enregistrement effectif sur le disque ne peut pas être vérifié par le navigateur. **Atténué (en attente de validation)** : annulation immédiate, sauvegarde de sécurité conservée en mémoire de l'onglet (`docs/BACKUP_RESTORE.md` § 6.1, tests Local + Cloud, jsdom et E2E). Reste ouvert : perte de l'annulation au rechargement / à la fermeture de l'onglet (le fichier téléchargé est alors le seul recours) | atténué |
| P19 | Constat de revue A1 : le protocole `ChangeSet` (étape 4.3) transmet la ligne complète ; avec `MemoryTransport`, le `blob` des pièces jointes est transmis et stocké (préexistant, `addAttachment` compris). Le futur transport HTTP doit appliquer `toCloudRow()` / `serializeRow()` pour que le fichier ne quitte jamais l'appareil (`docs/BACKUP_RESTORE.md` § 5). **Requalifié (Lot 0)** : rattaché initialement à « 4.5–4.6 », non traité au Lot 0 car aucun transport réseau n'existe ; il relève de l'écriture du transport HTTP. **Réalisé en V3.3 (plan directeur V1, 19/11/2026)** : `HttpTransport` convertit chaque ligne par le mapping (`serializeRow()`) ; le fichier joint (`blob`, champ local) n'est jamais transmis par le transport HTTP (tests validés : contenu du fichier absent de toutes les requêtes, colonnes envoyées = colonnes SQL de `attachments`). **Ne couvre pas le stockage distant des pièces jointes**, prévu ultérieurement (V5 / migration M10, avec P23). `MemoryTransport`, double de test, conserve la ligne TS complète | transport HTTP (V3.3) : réalisé ; stockage distant : V5 / M10 |

## Points ouverts ajoutés au Lot 0 (`docs/LOT0_QUALIFICATION.md`)

| # | Point | Lot |
|---|---|---|
| P20 | Dans `apply_changeset`, toute erreur survenant pendant les écritures d'un lot (hors conflit et erreurs du protocole) est rapportée `invalid_row`, donc comme un refus définitif, y compris une erreur transitoire (ressources, verrou) ; le SQLSTATE d'origine figure dans `details.sqlstate`. Le transport HTTP devra distinguer ces cas, ou la fonction limiter `invalid_row` aux classes 22 / 23 et au refus du déclencheur. **Réalisé en V3.3 (plan directeur V1, 19/11/2026)**, côté transport (fonction serveur inchangée) : `HttpTransport` distingue les erreurs temporaires des refus définitifs — `invalid_row` dont `details.sqlstate` est passager (classes 08, 40, 53, 58 ; `55P03`, `55006`, `57014`, `57P01` à `57P03`) et HTTP 429 → `CloudTransientRejectionError` (lot refusé, rien appliqué, soumissible à nouveau) ; réseau, délai dépassé, HTTP 5xx, `changeset_pending` et réponse illisible → issue inconnue (`CloudTransportError`, lot résolu ensuite). Aucune nouvelle tentative automatique non prévue (`retry(false)`, une seule requête par appel) | transport HTTP (V3.3) : réalisé |
| P21 | **Corrigé au Lot 0 (en attente de validation)** : un lot pouvait écrire deux fois la même ligne sous deux écritures de sa clé (UUID en majuscules, date non normalisée, nombre pour une clé texte). `apply_changeset` exige désormais la forme canonique de la clé (`invalid_key`) ; 8 assertions dans la suite 11 | corrigé |
| P22 | Qualification hébergée : projet de développement **NEXORA-DEV** disponible ; niveaux 1 et 2 (lecture seule) réalisés les 17 et 18/11/2026 (`docs/LOT0_QUALIFICATION.md` § 13). Restent les écritures, les migrations et les suites ; P9, P10, P11, P13 restent ouverts | avant le Lot 1 |

## Points ouverts ajoutés par la revue contradictoire et la remédiation du Lot 0

Statuts au 14/11/2026. Ces points ne sont pas des objectifs du Lot 0 sauf mention contraire ;
ils sont consignés pour être traités dans le lot indiqué.

| # | Point | Statut | Lot |
|---|---|---|---|
| P23 | `transactions.attachment_id` n'a pas de clé étrangère (exception de la migration 4 : restauration sans pièces jointes). Conséquence : un utilisateur peut y inscrire l'identifiant d'une pièce jointe d'un autre. Sans effet tant qu'aucun fichier n'est servi ; le futur stockage de fichiers ne devra **jamais** autoriser un accès sur la seule base de cette référence (contrôle du propriétaire de la pièce jointe obligatoire) | ouvert, documenté | stockage des pièces jointes (Lot 7 du dépôt) |
| P24 | GraphQL : sur la pile Supabase locale, l'extension n'est pas activée ; les assertions GraphQL de `rls.mjs` acceptent la réponse d'erreur « extension non activée » et ne prouvent donc rien. À rendre strictes (échec ou « non applicable » explicite). GraphQL est **également désactivé sur NEXORA-DEV** (constaté le 17/11/2026) : le cas « non applicable » est nécessaire aussi sur l'hébergé | ouvert | avant le Niveau 3 (E5) |
| P25 | `service_role` conserve tous les privilèges (suppression physique et `TRUNCATE` compris) et contourne la RLS ; aucun test ne l'encadre. Sa clé ne doit jamais atteindre le frontend ni un dépôt | ouvert, risque à encadrer | qualification hébergée / Lot 8 |
| P26 | Profil PostgreSQL 17 **éphémère** (binaires du paquet npm, comme à l'étape 3b) non exécuté au Lot 0 ; PostgreSQL 17 n'est couvert que par l'image 17.11 de la pile Supabase locale | ouvert, à clarifier (exécuter ou retirer de l'étape 4.5) | Lot 0 (avant validation technique) |
| P27 | Couverture HTTP des clés étrangères composites : 6 sur 25 par l'API ; les 25 sont couvertes par la suite SQL 02 | ouvert, non bloquant | optionnel |
| P28 | Synchronisation incrémentale : aucune fonction serveur de lecture des changements n'existe (seul un prototype figure dans l'outillage de test) ; une nouvelle migration et sa qualification seront nécessaires | **levé (V4.1)** : fonction `public.pull_changes` livrée (migration 9), qualifiée sur la pile Supabase **locale** (22/11/2026) et **appliquée sur NEXORA-DEV** (23/11/2026, P52 levé) ; validation fonctionnelle sur DEV distincte (P55) — voir section V4.1 | récupération des changements (Plan directeur V1, V4.1) |
| P29 | Contrôles de sécurité par mutation (10) : **versionnés par la remédiation** (`scripts/security-mutations/`, portage vérifié identique à l'original ; 10 / 10 détectées, mêmes nombres d'échecs qu'au Lot 0). Restent : pas d'automatisation côté HTTP ; exige les binaires PostgreSQL 16 | traité, en attente de validation | Lot 0 |
| P30 | Délai d'exécution (`statement_timeout` d'`authenticated` = 8 s) : lot de 5 000 opérations appliqué en 3,09 s sur la pile locale du Codespace (2,2 s dans la session cloud) ; mesure hébergée manquante (voir P13) | partiellement traité | qualification hébergée |
| P31 | Quotas et purge : aucun quota par utilisateur ; purges des lignes supprimées (P5) et de `private.changesets` (P14) non définies | ouvert, à traiter avant l'ouverture publique | Lot 8 |

Les erreurs transitoires classées comme refus définitifs restent suivies par P20 (transport HTTP) — réalisé en V3.3, voir P20.

## Points ouverts ajoutés par la qualification hébergée (17 et 18/11/2026)

| # | Point | Statut | Lot |
|---|---|---|---|
| P32 | Déclencheur d'événement `ensure_rls` de NEXORA-DEV (`public.rls_auto_enable()`, `SECURITY DEFINER`, propriétaire `postgres`) : active la RLS, sans la forcer, sur les tables créées dans `public` uniquement ; erreurs interceptées et seulement journalisées. Compatible avec les migrations 1 à 8 (la migration 6 active et force la RLS ; `private` et `tests` non concernés) | constaté, compatible | Niveau 4 (à observer) |
| P33 | Migration 7 : `postgres` détient l'option ADMIN sur `anon`, `authenticated`, `service_role`, mais ces rôles sont réservés par `supautils` et `extra_float_digits` n'est pas dans `supautils.privileged_role_allowed_configs` ; l'hébergé a `extra_float_digits = 0` (P11 confirmé). Réussite de la migration 7 incertaine | ouvert | Niveau 4 |
| P34 | Privilèges par défaut de NEXORA-DEV plus restrictifs que la pile locale (tables créées par `postgres` : `Dxtm` seulement pour `anon`, `authenticated`, `service_role` ; fonctions et séquences réservées à `postgres`). Les migrations procèdent par `revoke all` puis par des droits explicites ; l'effet sur les assertions des suites (notamment `service_role`) reste à vérifier | ouvert | Niveau 3 |

## Plan directeur V1 — V3.3 : transport HTTP vers les fonctions d'écriture (19/11/2026)

Périmètre (ligne V3.3 du plan directeur V1) : `HttpTransport` vers `apply_changeset` et
`resolve_changeset` (P19, P20), tests de contrat communs avec `MemoryTransport` (P15).
Aucun branchement dans l'application (V3.4 et V3.5 non commencées).

| Contrôle | Résultat |
|---|---|
| Suite complète (tests simulés) | 1 669 / 1 669 |
| Contrat commun `MemoryTransport` / `HttpTransport` (P15, simulé) | 24 / 24 (12 scénarios × 2 transports) |
| Tests du transport HTTP `src/data/cloud/HttpTransport.test.ts` (simulé) | 41 / 41 |
| Défauts introduits volontairement (contrôle par mutation) | 6 / 6 détectés |
| TypeScript et build | réussis |
| **Essais réels sur NEXORA-DEV — refus uniquement** | 10 / 10 ; 13 requêtes ; les 9 appels des fonctions refusés (409, 403, 400, 401), aucune écriture ; ligne `accounts` du compte de test B relue identique (versions comprises) ; session Auth du compte B ouverte puis fermée |
| Schéma, migrations, RLS, configuration Auth | aucun changement |
| Git | aucun commit ni push à la date de cette clôture documentaire |

Rapport des essais réels (hors dépôt, sans secret) :
`/workspaces/nexora-n2/v3-3/resultats/transport-dev-20261119T122258Z.json`,
SHA-256 `04009962781f55bf49ef7f946775b58d932a9c6fbefbe91d67e7acc1d1475a6b`.

Réserves de V3.3 : **P15** (levée complète conditionnée à la suppression du mode `legacy`,
obligatoire avant V3.5) et **P35** ci-dessous.

| # | Point | Statut | Lot |
|---|---|---|---|
| P35 | **Chemin de succès non validé réellement sur NEXORA-DEV** : V3.3 n'a exécuté sur DEV que des refus (décision du 19/11/2026 : aucune donnée des comptes de test modifiée) ; le chemin de succès n'est couvert qu'en simulation et **ne doit pas être considéré comme acquis**. Critère restant : exécuter réellement un `apply_changeset` accepté ; appeler ensuite `resolve_changeset` sur le même lot ; vérifier le résultat `replayed` ; vérifier que les données persistées correspondent exactement au lot soumis | **levée (V3.7, 21/11/2026)** : lot accepté puis `replayed`, voir section V3.7 | **V3.7** (report acté en V3.5, arbitrage A6 : essai dédié sous autorisation d'écriture sur DEV) |

## Plan directeur V1 — V3.4 : chargement initial des données Cloud (19 et 20/11/2026)

Périmètre (ligne V3.4 du plan directeur V1) : lecture des tables filtrée par la RLS,
conversion par `deserializeRow`, écriture des lignes et de leurs versions dans le cache en une
seule transaction, à l'ouverture de session et au rechargement. `CloudRepository` n'est pas
branché (V3.5). Aucune modification du schéma, des migrations, de la RLS ni de l'Auth.

| Sous-étape | Contenu | Fichiers principaux |
|---|---|---|
| V3.4-a — lecture | Lecture des 18 tables sans filtre `deleted_at`, filtre sur le propriétaire, tri sur la clé, pages de 1 000 lignes avancées du nombre de lignes reçues, nombre total exact à chaque page et contre-vérification HEAD des 18 tables (preuve d'intégralité), `.retry(false)`, délai de 30 s, requêtes séquentielles ; contrôles : propriétaire, version ≥ 1, P-7 (exactement 1 profil actif, 0 ou 1 ligne de paramètres) | `src/data/cloud/CloudReader.ts`, `HttpReadSource.ts` ; `MemoryTransport.readSource` ; lecture GET / HEAD du simulateur |
| V3.4-b — chargeur | Préparation complète (utilisateur, clés, versions, totaux), puis une transaction IndexedDB sur les 18 tables métier et `serverVersions` : vidage, lignes actives, toutes les versions (clés supprimées : `deleted: true`, sans contenu) ; `meta` et la base locale `nexora` jamais touchées | `src/data/cloud/CloudLoader.ts` |
| V3.4-c — cycle de vie | Chargement déclenché sur l'identifiant de l'utilisateur ; ordre : ouverture du cache, vérification de session, purge des caches des autres utilisateurs (P-3), lecture, préparation, vérification juste avant l'écriture, écriture, revérification ; invalidation des chargements caducs ; D6 (suppression du cache à la déconnexion, au changement de compte, sur session refusée par Auth ; jamais sur panne réseau) ; écrans de chargement et d'erreur (« Réessayer », « Se déconnecter » utilisable hors ligne) ; révocation du cache supprimé par un autre onglet (`CloudCacheDB`, gestionnaire `versionchange` qui renvoie `false`) | `cloudLoadCycle.ts`, `cloudCaches.ts`, `CloudCacheDB.ts`, `useCloudData.ts`, `useCloudSession.ts` (`endedUserId`), `CloudApp.tsx`, 24 dictionnaires (5 clés, `cloud.pending` corrigé) |
| V3.4-d — P15 | Cinq suites migrées en mode aligné, mode `legacy` supprimé, `unknown_changeset` retiré du contrat, test D6 ajouté | `MemoryTransport.ts`, `transport.ts`, 5 suites, `transportContract.test.ts` |

Décisions actées pendant le cadrage et l'exécution : D-1 (versions des clés supprimées
conservées), D-2 (déclenchement avec écrans), D-3 (règles de suppression du cache), D-4 (P15 en
V3.4-d), P-1 (une requête par table sans filtre `deleted_at`), P-2 (deux écarts au texte du
plan : lecture des lignes supprimées pour leurs versions ; D6 réalisée en V3.4 au lieu de V3.2,
étendue au changement de compte et à la session invalide), P-3 (purge), P-4 (« Se déconnecter »
sur l'écran d'erreur), P-5 (réglages de lecture), P-6 (résidu accepté : base vide recréée puis
supprimée aussitôt, sans requête ni donnée), P-7 (contrôle profil / paramètres), contrôle
« version ≥ 1 » dans le lecteur, routes Auth ajoutées au simulateur de test (V3.4-c), port de
données instantané injecté dans les tests V2.5, arbitrages A1 à A3 de V3.4-d (dont l'extension
ponctuelle d'A3 au test `resetToEmpty` de `backup.test.ts`).

| Contrôle (20/11/2026) | Résultat |
|---|---|
| Suite complète (tests simulés) | 1 779 / 1 779 (58 fichiers) |
| Tests ajoutés | V3.4-a 44 ; V3.4-b 23 ; V3.4-c 41 ; V3.4-d 2 (test D6 sur les deux transports) |
| Cinq suites migrées (P15) | 171 / 171 ; assertions 444 → 448 |
| Défauts introduits volontairement | V3.4-a 12 / 12 ; V3.4-b 12 / 12 ; V3.4-c 15 / 15 ; V3.4-d 7 / 8 détectés, le 8ᵉ (D2) étant une mutation équivalente |
| TypeScript et build | réussis ; mode local fonctionnellement inchangé (différences du build limitées aux traductions, à la constante `PRIMARY_KEYS`, à deux exports et à des renommages du minificateur ; le code Cloud n'est livré que dans le module `CloudApp` chargé à la demande) |
| Essais réels sur NEXORA-DEV | aucun en V3.4 (voir P39) |
| Schéma, migrations, RLS, configuration Auth | aucun changement |
| Git | aucun commit ni push à la date de cette clôture documentaire |

Points consignés en clôture de V3.4 :

| # | Point | Statut | Lot |
|---|---|---|---|
| P36 | **D2 — mutation équivalente** (V3.4-d) : dans `MemoryTransport`, la comparaison « clé non canonique » est inatteignable, la conversion préalable par le mapping refusant déjà toute clé non canonique (UUID en minuscules exigés) ; ce refus est couvert par `transportContract.test.ts` (clé en majuscules → `invalid_key`) | acté, sans action | — |
| P37 | **Validation dans un vrai navigateur** : ordre « fin de la transaction, puis suppression » prévu par la norme IndexedDB (fake-indexeddb 6.0.0 supprime d'abord ; seul l'état final est vérifié), comportement multi-onglets (`BroadcastChannel` du SDK : testé sous jsdom avec le vrai SDK et le `BroadcastChannel` de Node, non dans un navigateur), quota IndexedDB réel (simulé), réouverture du cache après suppression | **levée (V3.7)**, une limite consignée (suppression pendant une écriture en cours non testée) | V3.7 |
| P38 | **Hypothèse H1** (preuve d'intégralité de la lecture) : aucune ligne métier n'est effacée physiquement pendant un chargement (`authenticated` sans `DELETE`, suppression logique par `apply_changeset`, clés jamais modifiées). À réexaminer avant toute purge (P5, P14, P31) ou toute suppression de compte | ouvert | avant V7 |
| P39 | **Lecture et chargement non validés sur NEXORA-DEV** : lecture seule, sans aucune écriture — distinct de **P35**, qui porte sur l'écriture (lot accepté, puis `replayed`). les essais réels en lecture seule prévus au cadrage (chargement du compte B comparé à une lecture directe, profil du compte A, isolation, conversion des 18 tables réelles, jeton falsifié, déconnexion réelle) n'ont pas été réalisés ; seule une ligne `accounts` réelle a été convertie (V3.3) | **levée (V3.7)** après la correction C1 | **V3.7**, sur autorisation (report acté en V3.5, arbitrage A6) |
| P40 | **Lecture non transactionnelle entre les 18 tables** : une modification sur place pendant un chargement laisse une version antérieure dans le cache (sans danger : l'écriture suivante est refusée par conflit) ; un instantané exact relève de V4 (M9, borne P8). Pièces jointes chargées sans fichier (`blob` local, jamais transmis) : sans effet tant qu'elles sont désactivées en mode Cloud | accepté ; **atténué par V4.2 (qualifié en local, 24/11/2026)** : la borne de récupération est prise AVANT la lecture complète, donc une version antérieure laissée par le chargement est remplacée à la synchronisation suivante (test R2) ; non vérifié sur DEV (P57) ; pièces jointes : inchangé | V4 / V5 |
| P41 | Comportements de V3.2 conservés : une déconnexion faite dans un autre onglet s'affiche « session expirée » dans les onglets restants ; un `SIGNED_IN` venu d'un autre onglet est accepté sans nouvelle vérification (le changement de compte entre onglets repose sur ce comportement). Suppression du cache en arrière-plan, bornée à 5 s ; un cache dont la suppression est bloquée est purgé à l'ouverture de session suivante. Traductions des 5 nouvelles clés et de `cloud.pending` non relues par des locuteurs natifs | comportements **constatés en vrai navigateur et acceptés (V3.7, B4)** ; traductions : ouvert | V6 |
| P42 | **SMTP personnalisé** (réserve de clôture de V2, 19/11/2026) : NEXORA-DEV exige la confirmation de l'e-mail (V2.3) et utilise le serveur d'e-mail par défaut de Supabase, limité ; l'inscription réelle d'un nouvel utilisateur requiert un SMTP personnalisé, à configurer avant l'étape 2 (confirmation de l'e-mail) du parcours de V3.7 | **levée (V3.7)** : SMTP sandbox actif, inscription réelle confirmée | avant l'étape 2 de V3.7 |

Réserves toujours ouvertes après V3.4 : **P35** (chemin de succès réel sur DEV, au plus tard
V3.5 ou V3.7), **P42** (SMTP, avant l'étape 2 du parcours V3.7), P37, P39, P41.

## Plan directeur V1 — V3.5 : branchement de `CloudRepository` et onboarding Cloud (20/11/2026)

Périmètre (ligne V3.5 du plan directeur V1) : en mode Cloud avec session,
`CloudRepository(uid, HttpTransport)` remplace le dépôt local ; l'onboarding Cloud
(`ensureUser` après le chargement) crée profil, paramètres et catégories en un seul lot ; démo,
pièces jointes et restauration désactivées en mode Cloud jusqu'à V5. Aucun accès à DEV ni à
PROD, aucune modification du schéma, des migrations, de la RLS ni de l'Auth.
`CloudRepository`, `CloudStorage`, les transports et le chargement (V3.3, V3.4) sont inchangés
(seul l'en-tête de `CloudRepository.ts` est mis à jour).

**Option O1 (décision du 20/11/2026, après l'échec du test décisif T3)** : les lectures faites
à travers `CloudRepository` sortent de la zone de suivi de Dexie (file d'appels sérialisés) ;
`useLiveQuery` ne recalculait donc jamais l'instantané. L'affichage lit désormais le cache par un
lecteur en lecture seule (`CloudSnapshotReader` : règles de `RepositoryCore.snapshot` sur
`DexieStorage(cache)`, seul `snapshot()` exposé) ; toutes les écritures passent par
`CloudRepository`. Le cache ne reçoit que le chargement initial et les lots confirmés par le
serveur : le lecteur n'affiche jamais une écriture en cours, refusée, à l'issue inconnue, ni un
lot accepté dont l'écriture dans le cache a échoué (vérifié cas par cas).

| Élément | Contenu | Fichiers principaux |
|---|---|---|
| Espace de travail | Contenu de `Root` extrait dans `Workspace` (instantané → onboarding ou application), partagé par les deux modes ; sans import Cloud | `src/app/Workspace.tsx`, `src/App.tsx` |
| Branchement | Après chargement réussi : espace de données de la session (`CloudCacheDB(uid)`, `CloudRepository(uid, HttpTransport)` derrière une garde, lecteur O1), recréé à chaque changement de compte, fermé au démontage ; erreur de l'espace contenue dans la session | `src/data/cloud/cloudWorkspace.ts`, `CloudSnapshotReader.ts`, `src/features/auth/CloudApp.tsx` |
| Capacités | Compte Cloud transmis à l'application (`AppProvider`, `Onboarding`) ; `useSnapshot` accepte le lecteur | `src/app/AppContext.tsx` |
| Désactivations (A5) | Interface : démo (accueil, paramètres), restauration, champ de pièce jointe masqués (export conservé, note `cloud.limited`) ; dépôt : `addAttachment`, `restoreBackup`, `replaceWithSnapshot` refusés (`CloudFeatureUnavailableError`) par une garde extérieure à `CloudRepository`, sans requête | `Onboarding.tsx`, `Settings.tsx`, `TransactionForm.tsx`, `cloudWorkspace.ts` |
| Compte (A4) | Section minimale : adresse et « Se déconnecter » dans les paramètres, et sur l'accueil Cloud ; section complète en V4.5 | `Settings.tsx`, `Onboarding.tsx` |
| Fin de session | États d'interface mémorisés (filtres, mois, dernier compte) effacés à la déconnexion et au changement de compte ; langue et thème conservés | `src/app/uiState.ts`, `CloudApp.tsx` |
| Erreurs (A2) | Erreurs d'écriture Cloud traduites, sans détail technique (conflit, issue inconnue, indisponibilité, session refusée, refus, cache non mis à jour, fonction indisponible) ; 8 clés dans les 24 langues, `cloud.pending` retirée | `src/components/ui/Toast.tsx`, 24 dictionnaires |
| Sélection | `effective = supabase` en mode Cloud correctement configuré ; diagnostic mis à jour | `src/data/backend.ts` |

Adaptations de tests existants : la barrière (`CloudApp`, `CloudData`, `CloudMultiTab`) reçoit
un espace factice reproduisant l'ancien écran d'attente (`src/test/cloudWorkspaceStub.ts`) ; le
parcours sans réseau de `CloudApp.test.ts` utilise un espace de données factice et vérifie
l'accueil Cloud ; le test de source de Decision Lab lit `Workspace.tsx` ; le test de sélection
attend `effective = supabase`. Le test de contrat « `CloudRepository` ne redéfinit aucune méthode
métier » est conservé tel quel (la garde de A5 a été déplacée hors de la classe pour le
respecter).

| Contrôle (20/11/2026) | Résultat |
|---|---|
| Suite complète (tests simulés) | 1 812 / 1 812 (62 fichiers) |
| Tests ajoutés | 33 : lecteur O1 10 ; parcours de bout en bout simulé (vrai SDK, serveur simulé, fake-indexeddb) 8 ; messages d'erreur et 24 langues 13 ; graphe d'imports du mode local 2 |
| T3 (rafraîchissement) | réussi : onboarding → application sans rechargement ; écriture appliquée par le serveur mais non confirmée → invisible, puis affichée après confirmation |
| Défauts introduits volontairement | 9 / 10 détectés ; le 10ᵉ (dépendance de l'effet de l'espace sur l'utilisateur) est une mutation équivalente, la clé par utilisateur recréant déjà l'espace |
| Mode local | aucun module Cloud dans le graphe statique ; bundle principal sans `apply_changeset`, `resolve_changeset` ni `nexora-cache` (code Cloud dans le seul module `CloudApp` chargé à la demande) |
| TypeScript et build | réussis |
| Essais réels sur NEXORA-DEV | aucun (P35 et P39 reportés en V3.7, arbitrage A6) |
| Git | aucun commit ni push à la date de cette clôture documentaire |

Points consignés en clôture de V3.5 :

| # | Point | Statut | Lot |
|---|---|---|---|
| P43 | **Onboarding Cloud en 4 lots** (A1, parcours inchangé) : profil + paramètres + catégories ; paramètres ; premier compte ; fin d'onboarding. Une interruption laisse un état repris par l'accueil (`ensureUser` n'écrit rien la seconde fois, testé) ; cas résiduel : compte en double si le 3ᵉ lot est accepté et le 4ᵉ échoue | accepté | — |
| P44 | **Date de création du profil** : après `ensureUser`, le cache porte la date du client, le serveur conserve la sienne (`profiles.created_at` jamais écrit par le client) ; écart corrigé au chargement suivant (A3) | accepté | — |
| P45 | **Lots volumineux** en mode Cloud (« Effacer toutes les données », « Repartir de zéro », import CSV) : un seul lot, soumis aux limites du serveur (5 000 opérations, 4 Mio) ; sans effet sur un compte récent | ouvert | V5 (P30) |
| P46 | Traductions des 8 nouvelles clés non relues par des locuteurs natifs ; comportement réel du lecteur O1 (suivi de Dexie, multi-onglets) à confirmer dans un vrai navigateur | lecteur O1 **validé en vrai navigateur (V3.7)** ; traductions : ouvert | V6 |

Réserves toujours ouvertes après V3.5 : **P35** et **P39** (V3.7, sur autorisation), **P42**
(SMTP, avant l'étape 2 du parcours V3.7), P37, P41, P45, P46.

## Plan directeur V1 — V3.7 : validation de bout en bout sur NEXORA-DEV (20 et 21/11/2026)

Périmètre (ligne V3.7 du plan directeur V1) : test de bout en bout du parcours 1 à 9 sur DEV ;
non-régression du mode local. Chaque opération sur DEV a été faite sur autorisation explicite
et bornée (lecture A3 ; écritures A4 limitées à un compte, une table et un volume maximal ;
inscriptions et lots du parcours plafonnés avant envoi par les scripts). Aucune opération sur
PROD ; aucune modification du schéma, des migrations ni de la RLS. Configuration Auth de DEV
faite par l'utilisateur dans le tableau de bord (SMTP sandbox, adresse de retour
`http://localhost:5173/**`). Outils (Playwright, Chromium) installés hors dépôt ; preuves hors
dépôt (dossier de travail V3.7 : index `LISEZMOI.txt`, empreintes `SHA256SUMS.txt`), sans
secret ni adresse e-mail.

Corrections apportées au dépôt pendant V3.7 :

| Correction | Cause constatée | Contenu | Fichiers |
|---|---|---|---|
| C1 — horodatages du serveur | Premier essai P39 sur DEV : `profiles.created_at` (`DEFAULT now()`) relu en **microsecondes**, refusé par la conversion (précision milliseconde) ; le serveur simulé ne produisait que des millisecondes (écart de simulation) | À la lecture seulement, les colonnes `timestamptz` **non modifiables par le client** sont tronquées à la milliseconde avant conversion ; les colonnes modifiables restent refusées au-delà ; serveur simulé aligné (horodatages serveur en microsecondes) ; 6 tests | `src/data/cloud/mapping.ts`, `MemoryTransport.ts`, `src/test/postgrestSimulator.ts`, `mapping.test.ts`, `CloudReader.test.ts` |
| Test smoke daté | Défaut antérieur (reproduit sur `ee8def0`) : le relevé CSV de test est daté d'octobre 2026, le test dépendait de la date du jour | Horloge du navigateur fixée au 15/10/2026 (`SMOKE_NOW` pour la changer) | `e2e/smoke.cjs` |
| Flux PKCE (P47) | Constaté sur DEV (P42) : lien de confirmation revenu avec `#access_token=…` (flux implicite, défaut du SDK) alors que le plan (V3.1, V3.2) exige PKCE | `createClient(url, clé, { auth: { flowType: 'pkce' } })` ; test (défi S256 envoyé à l'inscription) | `src/data/cloud/supabaseClient.ts`, `supabaseClient.test.ts` |
| Ordre de démarrage (P47) | Le `HashRouter` était monté (dans `App`) avant la fin de l'échange du code | Mode Cloud : `App` ne crée plus de routeur ; `CloudBoot` attend `auth.initialize()` (échange du code PKCE par le SDK), nettoie l'adresse (`code`, `error*`, fragment non-route → `#/`), puis monte le `HashRouter` et la barrière de session. Lien ouvert ailleurs (code non échangé) ou expiré / refusé : message sur l'écran de connexion (2 clés, 24 langues). Mode local : arbre inchangé | `src/App.tsx`, `src/features/auth/CloudApp.tsx`, `authCallback.ts`, `src/data/cloud/auth.ts`, 24 dictionnaires |
| Script du parcours | — | Parcours 1 à 9 dans un vrai navigateur contre DEV, sans secret (environnement) ; garde-fou avant envoi : 1 inscription, 7 lots au plus (constante), `resolve_changeset` et toute autre écriture bloqués ; comparaison des instantanés hors horodatages (`undefined` ≡ absent) | `e2e/parcours-cloud.cjs` |

| Contrôle | Résultat |
|---|---|
| Suite complète (tests simulés) | 1 834 / 1 834 (63 fichiers) ; typage et build réussis |
| Tests ajoutés en V3.7 | 22 : horodatages serveur et alignement du simulateur 6 ; PKCE 1 ; ordre de démarrage et retour de lien 15 (application entière en mode Cloud, initialisation retenue, `HashRouter` instrumenté : ordre vérifié par journal) |
| Défauts introduits volontairement | horodatages : arrondi détecté ; PKCE : option retirée détectée ; ordre de démarrage : 5 / 5 détectés (routeur avant `CloudBoot`, routeur remis dans `App`, adresse non nettoyée, message non transmis, initialisation non attendue) |
| Mode local | smoke 11 / 11 ; journal réseau : 68 requêtes, 0 hors origine, **0 vers Supabase**, 0 WebSocket ; module Cloud jamais chargé ; seule base `nexora` |
| Build | aucune clé `service_role` ; build Cloud : seule la clé publique (`anon`) |
| P39 (lecture, compte B) | API 4 / 4 : 18 tables, 27 lignes et 27 versions identiques à une lecture directe ; conversion des 18 tables réelles ; 0 ligne d'autrui ; jeton falsifié → 401 ; 0 appel de fonction d'écriture |
| Vrai navigateur, lecture (compte B) | 17 / 17 : route protégée sans session → connexion ; cache = serveur ; base `nexora` jamais créée ; rechargement et réouverture ; deux onglets (déconnexion dans l'un : retour à la connexion dans l'autre, cache supprimé en 6 ms malgré la connexion ouverte) ; reconnexion suivie par l'autre onglet ; quota observé |
| Vrai navigateur, écritures bornées (A4, compte B) | 21 / 21 : 2 lots sur `user_settings.privacy_mode` (false → true → false, version 1 → 3) ; réponse retenue 1,2 s : rien d'affiché avant confirmation alors que le serveur avait appliqué le lot ; rafraîchissement sans rechargement dans les deux onglets ; valeur initiale restaurée |
| P42 (SMTP) | inscription réelle unique ; message reçu dans le sandbox (API en lecture seule) ; adresse de retour d'abord refusée par Auth (repli sur l'URL du site) puis autorisée par l'utilisateur ; renvoi pour le même compte : 18 / 18 (confirmation, connexion, déconnexion) |
| Démarrage Cloud en vrai navigateur, sans écriture | 11 / 11 : code sans vérificateur, lien expiré, sans lien |
| **Parcours 1 à 8, 3 fois de suite** | **S2 34 / 34, S3 34 / 34, S4 étapes 1 à 8 réussies** : inscription avec défi PKCE, retour `?code=`, échange, code retiré ; onboarding (4 lots, P43) ; dépense, second compte, transfert (3 lots) ; 7 lots `applied` ; cache = serveur ; rechargement et second appareil : instantané identique (hors horodatages) ; 0 contenu de pièce jointe ; 0 envoi bloqué ; 0 erreur JavaScript |
| **Étape 9 (S4 = A, compte B)** | déconnexion de A : cache et session supprimés ; B dans le même navigateur : aucune donnée de A (4 écrans), seul le cache de B ; API avec le jeton de B : 0 ligne de A et 0 ligne d'autrui sur les 18 tables ; écriture de B sur le compte « Épargne » de A refusée (HTTP 403, `unauthorized` : ligne attribuée à un autre utilisateur) ; comptes de A inchangés (2 comptes, version 1) |
| **P35** (compte S4) | 16 / 16 : `apply_changeset` accepté (`privacy_mode` → true, version 3 → 4, seule colonne modifiée) ; `resolve_changeset` du même lot → `replayed`, résultat identique ; ligne DEV identique après le rejeu ; persistance après rechargement |
| Exécutions interrompues (non comptées) | exécution 1 : défaut d'attente du script (étape 3) ; S1 : comparaison trop stricte du script (étape 7 : champ `undefined` écrit par le client ≡ champ absent relu du serveur) ; S4 étape 9 : prédicat « clé de A » erroné (clé SQL de `accounts` = `{id}`). Aucune anomalie de l'application ; scripts corrigés |
| Git | aucun commit ni push à la date de cette clôture documentaire |

Critères du § 7 : **« SaaS Cloud fonctionnel »** atteint (parcours 1 à 8 automatisé, 3 fois de
suite ; instantané identique après rechargement ; mode local ≥ 1 512 tests, test de bout en bout
11 / 11, 0 requête vers Supabase ; 0 contenu de pièce jointe) ; **« multi-utilisateurs
sécurisé »** atteint (étape 9 interface et API ; cache de A supprimé après sa déconnexion ;
0 clé `service_role` ; aucune route sans session).

Points consignés en clôture de V3.7 :

| # | Point | Statut | Lot |
|---|---|---|---|
| P47 | **Flux PKCE absent jusqu'à V3.7** (écart à V3.1 / V3.2, constaté sur DEV) : corrigé (client PKCE, échange terminé avant le montage du `HashRouter`, adresse nettoyée, liens ouverts ailleurs ou expirés traités) ; validé en réel dans les 3 exécutions | clos | — |
| P48 | Messages de retour de lien (`auth.link.noSession`, `auth.link.invalid`) : traductions non relues par des locuteurs natifs ; le message « session non ouverte » s'affiche pour tout code sans vérificateur (y compris un code forgé), sans affirmer la confirmation ; aucun renvoi d'e-mail dans l'application (mot de passe oublié : V4.5) | ouvert | V6 / V4.5 |
| P49 | **Comptes de test sur NEXORA-DEV** (A6, à décider) : compte P42 (confirmé, sans données), exécution 1 (confirmé, sans données), S1 à S4 (données du parcours ; S4 : `privacy_mode` = true) ; messages du sandbox ; sessions Auth de S1 et de B restées ouvertes côté serveur (déconnexion finale non atteinte), sans effet sur les données | ouvert | décision A6 |
| P50 | Représentation dans le cache : une propriété facultative écrite par le client avec la valeur `undefined` est absente après rechargement depuis le serveur (même donnée ; aucun effet sur l'instantané) | accepté | — |
| P51 | Étape 9 : l'absence de ligne « Intrusion » chez B après la tentative refusée n'a pas été relue (le refus annule le lot entier, réponse 403) ; la tentative portait sur une ligne attribuée à A (refus par l'attribution de la ligne) | accepté | — |

Réserves toujours ouvertes après V3.7 : P38 (avant V7), P41 et P46 (traductions, V6), P45 (V5),
P48, P49 (décision A6).

## Plan directeur V1 — V4.1 : récupération des changements (M9), développement et qualification locale (22/11/2026)

Périmètre (ligne V4.1 du plan directeur V1) : fonction serveur de récupération des changements
(P28), avec une borne sûre (P8) ; **qualification locale réalisée** (22/11/2026) ; **application sur
DEV réalisée le 23/11/2026** (autorisation distincte, voir « Application sur NEXORA-DEV » ci-dessous).
Décision A3 : `SECURITY INVOKER`, RLS existante. Aucun code client de synchronisation (V4.2) ; partie
locale : aucun accès à DEV ni à PROD ; aucune modification d'Auth ni de la RLS ; les migrations 1 à 8
sont inchangées.

| Élément | Contenu | Fichiers |
|---|---|---|
| Migration 9 | `public.pull_changes(p_cursor text = '0', p_bound text = null, p_after jsonb = null, p_limit integer = 1000) → jsonb` : lignes de l'utilisateur authentifié sur les 18 tables, **actives et supprimées**, telles que `curseur ≤ sync_txid < borne` ; borne `pg_snapshot_xmin(pg_current_snapshot())` au premier appel, imposée aux pages suivantes (jamais postérieure à la borne sûre) ; pages de 1 à 1 000 lignes triées par `(sync_txid, table, clé)` en collation « C », reprise par `next` ; `xid8` en texte ; clés SQL de la liste blanche de la migration 8. `SECURITY INVOKER`, `STABLE`, `search_path` vide, propriétaire `nexora_writer`, `EXECUTE` à `authenticated` seulement ; aucun accès à `private`, aucune écriture. Refus `PT403 unauthorized` (sans utilisateur) et `PT400 invalid_pull` (paramètre invalide). Réponse : `{ bound, rows: [{ table, key, row }], next }` ; `next` nul → nouveau curseur = `bound` | `supabase/migrations/20261101000900_pull_changes.sql` |
| Suites SQL | `07_sync.sql` : les 16 scénarios (transactions concurrentes, annulations, suppressions, entrelacements aléatoires) exécutés contre la **vraie fonction** sous le rôle `authenticated`, par pages de 3 (assertions préfixées « M9 ») ; nouvelle suite `12_pull_changes.sql` (51 assertions : catalogue, accès, 16 refus de paramètres, couverture des 18 tables = lecture directe sous la RLS, isolation, suppression logique et réactivation, pagination de 2 500 lignes dont 1 500 d'une même transaction, modification et insertion pendant la pagination sans perte, lecture seule) ; `01_catalog.sql` et `P1_supabase_platform.sql` : inventaire **exact** des trois fonctions publiques ; `08_lifecycle.sql` (non modifiée) contrôle automatiquement la nouvelle fonction (5 assertions : droits, propriétaire, `search_path`) | `supabase/db-tests/` |
| Suite HTTP | 18 assertions « M9 » avec de vrais jetons GoTrue (18 tables, isolation, pages de 97 = pages de 1 000, récupération incrémentale d'une création et d'une suppression, refus anon, jeton falsifié et paramètres invalides) | `supabase/db-tests/http/rls.mjs` |
| Serveur simulé | `MemoryTransport.pull` et route `/rpc/pull_changes` : même contrat ; un `sync_txid` croissant par lot accepté (auparavant égal à la version). **Non modélisé** : transactions en cours retenant la borne (qualifié seulement sur PostgreSQL, suites 07 et 12) | `src/data/cloud/MemoryTransport.ts`, `src/test/postgrestSimulator.ts`, `src/data/cloud/pullChanges.sim.test.ts` (15 tests) |
| Outillage de qualification | Comparateur : option `--declared` (écarts déclarés, contrôle exact : écart non déclaré, déclaration périmée ou remplacement absent → échec ; sans l'option, comportement inchangé) ; script de qualification : transmet la liste des écarts déclarés ; contrôleur de preuves : préfixe `v41-local` (9 migrations, traçabilité exigée), référence épinglée | `supabase/db-tests/compare-results.mjs`, `scripts/qualify-supabase.sh`, `scripts/check-qualification-evidence.mjs` (+ tests), `scripts/qualification-reference/` |

**Critère « Backend DEV opérationnel » (§ 7 du plan directeur), actualisé** : le texte du plan
(« `authenticated` : lecture + exécution des 2 RPC uniquement ») est conservé tel quel ; depuis la
migration 9, prévue par le plan (V4.1), la lecture se lit **« lecture + exécution des 3 RPC
uniquement »** : `apply_changeset` et `resolve_changeset` (écriture, `SECURITY DEFINER`) et
`pull_changes` (lecture seule, `SECURITY INVOKER`), vérifiées par l'inventaire exact des suites 01
et P1. Sur NEXORA-DEV, depuis l'application de la migration 9 (23/11/2026), les 3 RPC applicatives
sont présentes : `apply_changeset`, `pull_changes`, `resolve_changeset` ; le schéma `public` de DEV
contient en outre `rls_auto_enable()`, fonction de la **plateforme** préexistante (déclencheur
`ensure_rls`, P32), qui n'est pas une RPC applicative de NEXORA ; ses droits ne relèvent pas de la
migration 9 : ACL par défaut constatée le 18/11/2026 (preuves V2.1 / V2.2, donc privilège PostgreSQL
`EXECUTE` accordé à `PUBLIC`), non revérifiée depuis. Ce privilège ne dit rien, à lui seul, de
l'invocation directe de la fonction (fonction de déclencheur d'événement) ni de son exposition comme
RPC par PostgREST : aucun de ces deux points n'a été vérifié, et ce constat ne fait pas d'elle une
quatrième RPC utilisable. La formule « 3 RPC uniquement » s'applique aux RPC applicatives de NEXORA ;
le cas de cette fonction de plateforme relève de P32.

**Qualification locale** (`EVIDENCE=v41-local bash scripts/qualify-supabase.sh local`, GitHub
Codespaces, pile recréée puis détruite : 0 conteneur, 0 volume restants ; CLI Supabase 2.122.0 ;
code testé : commit `a56fe36` + modifications non commitées de V4.1 ; empreinte des migrations
`385ced586c63efd2…` ; preuves `docs/qualification/v41-local-*`, référence
`scripts/qualification-reference/v41-local.json`, empreinte `e21d3f237f32d94e…`) :

| Résultat | Valeur |
|---|---|
| **Obtenu sur PostgreSQL 17.11** (pile Supabase locale), 9 migrations | SQL **1 905 / 1 905** (01 : 809, 02 : 402, 03 : 34, 04 : 122, 05 : 10, 06 : 28, 07 : 16, 08 : 83, 09 : 15, 10 : 17, 11 : 266, 12 : 51, P1 : 52) ; HTTP **320 / 320** ; précision 4 / 4 ; chaîne numérique exacte 4 / 4 ; codes de sortie 0 / 0 / 0 |
| Comparaison avec la référence PostgreSQL 16 (`baseline/pg16.json`, **inchangée**, 1 793 assertions) | identiques : **1 776** · régressions : **0** |
| **Écarts déclarés** par rapport à PostgreSQL 16 (`baseline/pg16-declared-deltas.json`) | **17** assertions remplacées : les 16 de `07_sync.sql` (même scénario, vraie fonction, préfixe « M9 ») et l'inventaire des fonctions de `01_catalog.sql` (étendu à `pull_changes`) |
| **Non requalifiées sur PostgreSQL 16** | les 17 remplacements ci-dessus et les **129** assertions sans référence PG16 : **75 apportées par V4.1** (12 : 51 ; 07 : 16 et 01 : 1, remplacements ; 08 : 5 et P1 : 2, ajoutées automatiquement par les boucles de ces suites sur les fonctions de `public` — droits, propriétaire, `search_path` de `pull_changes`) et **54 déjà sans référence PG16 au Lot 0** (P1 : 50, propre à la plateforme Supabase ; 10 : 4). La fonction `pull_changes` n'a **jamais** été exécutée sur PostgreSQL 16 (binaires absents du Codespace ; option A du 22/11/2026) |
| Contrôleur de preuves | « propres, cohérents et complets » pour `v41-local` ; 22 / 22 tests du contrôleur ; références `3b-local` et `lot4-local` toujours acceptées |
| Défauts introduits volontairement | fonction SQL : 6 / 7 détectés (borne `xmax`, borne haute retirée, lignes supprimées exclues, reprise sans clé de tri, `SECURITY DEFINER`, curseur ignoré) ; le 7ᵉ (filtre utilisateur explicite retiré) est équivalent : la RLS seule garantit l'isolation, le filtre ne sert qu'aux index ; serveur simulé : 4 / 4 |
| Suite applicative | `npm run check` : 64 fichiers, **1 849 / 1 849** tests, typage et build réussis |
| Essais sur NEXORA-DEV | aucun pendant la qualification locale (application sur DEV le 23/11/2026 : voir ci-dessous) |
| Git | aucun commit ni push à la date de cette clôture documentaire |

Points consignés en clôture de V4.1 (partie locale) :

| # | Point | Statut | Lot |
|---|---|---|---|
| P52 | **Migration 9 non appliquée sur NEXORA-DEV** : application (`db push`), comparaison des migrations entre local et DEV, contrôles en lecture seule de `pull_changes` (inventaire des 3 fonctions, isolation, pagination). Sur DEV, les privilèges par défaut diffèrent de la pile locale (P34) : propriétaire et droits de la fonction à vérifier | **levé (23/11/2026)** pour l'application et les contrôles en lecture seule de la structure : migration 9 appliquée sur DEV par le mécanisme atomique qualifié, `COMMIT` confirmé, constat APPLIQUÉ, inventaire des 3 RPC applicatives, propriétaire et droits conformes (voir « Application sur NEXORA-DEV ») ; **isolation et pagination non vérifiées sur DEV**, reportées en P55 | V4.1 (partie DEV) |
| P53 | **Qualification PostgreSQL 16 non refaite** : 17 écarts déclarés et 129 assertions sans référence PG16 (dont 75 apportées par V4.1) ; référence `pg16.json` non régénérée (binaires absents). Seule la pile Supabase locale (PostgreSQL 17.11, version de la plateforme) qualifie la migration 9 | accepté (option A), à reconsidérer à la qualification complète | V6 (E5) |
| P54 | Prototype `tests.pull` conservé dans l'outillage de test (`_setup.sql`) mais plus appelé par les suites | accepté, sans effet | — |

**Application sur NEXORA-DEV (23/11/2026, autorisation explicite)** — projet `nmrjwyfloqnypaawlqxd`,
pooler en mode session, TLS `verify-full` (certificat épinglé). Méthode : application **atomique** dérivée
de la procédure V2.2 (une seule transaction : contrôle de l'état de départ, migration 9 telle quelle, ligne
d'historique identique à celle de Supabase CLI 2.122.0, contrôles, `COMMIT` conditionné), qualifiée au
préalable sur une pile locale jetable partant des migrations 1 à 8 (30 / 30 : nominal, erreur dans la
transaction, contrôle faux, interruption du client, refus avant connexion et avant `BEGIN`, relance
refusée ; état final identique à `supabase db push` du CLI 2.122.0, `migration list` Local = Remote).
Scripts et preuves hors dépôt : `/workspaces/nexora-n2/v4-1/` (manifeste des scripts `ca239a79…`,
manifeste des preuves DEV `resultats/SHA256SUMS-DEV-M9` `2a666f25…`).

| Contrôle sur DEV | Résultat |
|---|---|
| Préflight en lecture seule, juste avant (transaction `READ ONLY` vérifiée par le serveur) | 8 migrations (1 à 8, historique identique à V2.2), `pull_changes` absente, empreintes identiques au préflight du 23/11/2026 00:13 (`resultats/preflight-avant-application-20261123T184013Z.txt`) |
| Application (`run-m9.sh --appliquer`, profil `nexora-dev`) | pré-contrôle INITIAL-CONFORME ; 7 déclencheurs d'événements, tous autorisés ; **18 / 18 contrôles transactionnels vrais** ; **un seul `COMMIT`, confirmé par le serveur** ; constat en lecture seule **APPLIQUÉ** ; code 0 ; aucune relance (`resultats/dev-20261123T184029Z-appliquer/`) |
| Historique | **9 migrations** ; ligne `20261101000900` identique à la référence CLI (`md5` de la ligne `067bd23d…`) ; lignes 1 à 8 inchangées |
| `pull_changes` | fonction unique, signature `(p_cursor text, p_bound text, p_after jsonb, p_limit integer)`, retour `jsonb` ; `SECURITY INVOKER`, `STABLE`, `search_path` vide ; propriétaire `nexora_writer` ; ACL exacte `{nexora_writer=X/nexora_writer,authenticated=X/nexora_writer}` (ni `anon`, ni `service_role`, ni `PUBLIC`) |
| Empreintes avant / après (session distincte en lecture seule) | politiques RLS (108) `fed8d71f…` = `fed8d71f…` ; RLS activée et forcée (18 tables) `2b167013…` = `2b167013…` ; droits des tables `b32d17e3…` = `b32d17e3…` ; fonctions : 7 → 8 (seule `pull_changes` ajoutée, les 7 autres vérifiées inchangées dans la transaction) (`resultats/preflight-apres-application-20261123T184050Z.txt`) |
| Appels de contrôle minimaux (lecture seule, aucune donnée métier lue ; **ne valent pas validation fonctionnelle**, voir P55) | identité inexistante : borne renvoyée, 0 ligne, `next` nul ; `authenticated` sans utilisateur : `unauthorized` ; `anon` : `permission denied` (`resultats/verification-fonctionnelle-20261123T184050Z.txt`) |
| Auth, politiques RLS, données métier, PROD | non modifiés ; aucun accès à PROD |

Point consigné après l'application sur DEV :

| # | Point | Statut | Lot |
|---|---|---|---|
| P55 | **Validation fonctionnelle de `pull_changes` sur NEXORA-DEV non réalisée** : isolation entre utilisateurs réels, pagination et scénarios multi-utilisateurs complets ne sont qualifiés qu'en **local** (suites 07 et 12, suite HTTP) ; sur DEV, seuls la structure, les droits et des appels sans données ont été vérifiés. Une validation sur DEV exige des appels sous l'identité de comptes de test (lecture de leurs données) : autorisation distincte | **levé (23/11/2026)** : campagne C1 + C2 + C3 sur DEV, 88 / 88 contrôles (voir « Validation fonctionnelle sur NEXORA-DEV ») ; **réserve** : pagination au-delà de 1 000 lignes non exercée sur DEV (qualifiée en local ; plafond de 1 000 lignes par page vérifié sur DEV par le refus de la limite 1 001) | hors plan directeur (non prévue explicitement : V4.1 = « qualification locale, puis application sur DEV ») ; campagne réalisée après l'application de M9 sur DEV et avant V4.2, sur autorisation explicite de chaque volet (C1, C2, C3) |

**Validation fonctionnelle sur NEXORA-DEV (P55, 23/11/2026, autorisation explicite pour chaque volet)** —
comptes **fictifs** uniquement (8 utilisateurs, tous confirmés, domaines `example`), identifiés par
l'empreinte de leur adresse ; aucune adresse, aucun mot de passe, aucun jeton ni aucune valeur métier dans
les preuves. Scripts et preuves hors dépôt : `/workspaces/nexora-n2/v4-1/p55/` (manifeste `SHA256SUMS`,
29 fichiers, `aeee4885…`).

| Volet | Méthode | Résultat |
|---|---|---|
| **C1** — lecture seule, 8 comptes | pooler épinglé, transactions `READ ONLY` (vérifiées par le serveur) puis annulées ; identité de chaque compte simulée comme PostgREST (rôle `authenticated` et revendications du jeton), RLS de la plateforme | **57 / 57** : récupération complète égale, table par table (18 tables), à la lecture sous RLS et au décompte administrateur ; partition **230 = 230** lignes sans doublon ; 0 ligne étrangère, y compris page par page ; pages de 1, 3 et 7 identiques à une page de 1 000 (même borne, même ordre strict, aucun doublon) ; récupération incrémentale vide ; refus `PT403`, `42501` et `PT400 invalid_pull` (9 paramètres invalides, limite 1 001 comprise) ; accès HTTP anonyme refusé (401). Contrôle négatif du détecteur de fuite : 45 / 45 lignes signalées. Aucune écriture |
| **C2** — chemin HTTP réel, comptes A et B | connexion par mot de passe (GoTrue), jeton réel, `/rest/v1/rpc/pull_changes`, lectures REST du même jeton, déconnexion `scope=local` | **14 / 14** : récupération complète égale aux lectures REST (A : 21 lignes, B : 27) ; pages de 3 identiques à une page de 1 000 ; isolation croisée (0 ligne de l'autre compte, par la fonction et par REST avec filtre explicite) ; refus (paramètres invalides : 400 `invalid_pull` ; jeton modifié : 401 ; sans jeton : 401 `42501`) ; session révoquée (204, puis 403 `session_not_found` sur `/auth/v1/user`). Écritures : Auth seulement (2 sessions créées puis révoquées, `last_sign_in_at`) |
| **C3** — écritures de test, compte S1 | connexion réelle de S1, **5 lots** `apply_changeset` (plafond imposé par le script ; `resolve_changeset` bloqué) sur **une** ligne `accounts` préfixée `P55-` | **17 / 17** : création, modification, suppression logique et réactivation, chacune renvoyée **seule** par la récupération incrémentale suivante, dans la version attendue (1 à 5) et avec `deleted_at` renseigné puis remis à nul ; la ligne supprimée figure dans la récupération complète ; **modification pendant une pagination par pages de 3** : la ligne, présente dans l'intervalle avant la modification, en sort (15 pages, 45 lignes, borne constante, autres lignes identiques et dans le même ordre) et revient dans sa dernière version à la récupération suivante (aucune perte) ; aucun retard de borne observé |
| Avant / après (sessions distinctes en lecture seule) | empreintes du schéma et des données | politiques `fed8d71f…`, RLS des tables `2b167013…`, droits des tables `b32d17e3…`, fonctions `96786c3f…` : **inchangées** ; historique : 9 migrations ; empreinte des versions **par compte** (8 comptes, S1 compris) hors ligne P55 : **inchangée** ; seule différence : la ligne P55 (`accounts` 14 → 15, total 230 → 231) ; 8 utilisateurs, 6 sessions (sessions préexistantes de A, B et S1 non touchées ; voir P49) ; aucun accès à PROD |

Reste sur DEV : la ligne de test `P55-…` du compte S1 (`accounts`, active, version 5). L'effacement
physique n'existe pas dans le schéma ; une suppression logique demanderait un lot supplémentaire, non
autorisé. Elle relève du sort des comptes de test sur DEV (P49, décision A6).

Point consigné pendant la validation fonctionnelle :

| # | Point | Statut | Lot |
|---|---|---|---|
| P56 | **Jeton d'accès accepté après la déconnexion** (constat C2, 23/11/2026) : après `logout` (`scope=local`, HTTP 204), GoTrue refuse l'ancien jeton (`/auth/v1/user` : 403 `session_not_found`), mais **PostgREST l'accepte encore** (`/rpc/pull_changes` : HTTP 200) jusqu'à son expiration, car il ne vérifie que la signature. Comportement normal de Supabase ; durée de vie du jeton d'accès sur DEV non vérifiée (1 heure par défaut). La révocation supprime la session et ses jetons de renouvellement, pas le jeton d'accès déjà émis | ouvert, non bloquant (aucune correction faite) | à prendre en compte avec la déconnexion hors ligne (décision A1-c', V4.4) et la sécurité du compte (V4.5) |

État global : **V4.1** : migration M9 appliquée sur DEV, contrôles après application conformes,
**validation fonctionnelle sur DEV réalisée (P55 levé, réserve > 1 000 lignes)** ;
**V4.2** : non commencée à cette date (développée et qualifiée en local le 24/11/2026 : voir la
section V4.2 ci-dessous).

Réserves toujours ouvertes après V4.1 : P56 (jeton d'accès après déconnexion), P53, P8 (propriété
assumée), P40 (lecture non transactionnelle du chargement complet, inchangée : décision A2-b), P38,
P41, P45, P46, P48, P49.

## Plan directeur V1 — V4.2 : synchronisation incrémentale, développement et qualification locale (24/11/2026)

Périmètre (ligne V4.2 du plan directeur V1 et cadrage V4 consolidé) : récupération des changements par
`pull_changes` (M9) au retour au premier plan, au retour du réseau et toutes les 60 s (D7) ;
suppressions propagées ; curseur pris **avant** le chargement complet (A2-b) ; règle de la version
la plus haute, y compris pour `applyConfirmed` (R1) ; application dans la file des opérations de
`CloudRepository` (A5) ; arrêt à la déconnexion et au changement de compte. **Développement et
qualification en local uniquement** : aucun accès à DEV ni à PROD ; aucune migration ; aucune
modification d'Auth ni de la RLS. Hors périmètre, inchangés : interface de conflit (V4.3), hors ligne
et indicateur (V4.4), compte (V4.5) ; lot non confirmé toujours résolu avant l'écriture suivante.

Décisions prises au lancement (24/11/2026) :
- **D1** : les valeurs renvoyées par `pull_changes` sont comparées à la lecture REST dans la suite
  HTTP locale (requalification, nouveau jeu de preuves `v42-local`) ;
- **D2** : minuterie de 60 s sans condition de visibilité (le navigateur la ralentit seul dans un
  onglet masqué) ; aucune synchronisation supplémentaire à l'ouverture de l'espace ;
- **D3** : en cas d'erreur (`unauthorized`, `invalid_pull`…), cycle abandonné sans écriture ni
  avancée du curseur ; aucune action sur la session, aucun rechargement, aucun message (indicateur :
  V4.4) ; reprise au déclencheur suivant, ou par le chargement complet d'un rechargement de page.

| Élément | Contenu | Fichiers |
|---|---|---|
| Version la plus haute (R1) | Une clé n'est écrite dans le cache que si la version reçue est **strictement** supérieure à celle connue (ou si la clé est inconnue) ; règle commune à `applyConfirmed` (lot confirmé ou résolu `replayed`) et à la synchronisation ; aucune fusion : la clé est écrite ou laissée entière | `src/data/cloud/CloudCacheDB.ts` (`isNewerVersion`), `src/data/cloud/CloudStorage.ts` |
| Curseur | Cache `nexora-cache-<uid>` en **version 3** : table annexe `syncState` (un enregistrement, curseur `xid8` en texte). Écrit par le chargement complet dans la **même** transaction que les données ; il **remplace** le curseur précédent (jamais un maximum : les données viennent toutes de cette lecture). Absent → aucune synchronisation | `src/data/cloud/CloudCacheDB.ts`, `src/data/cloud/CloudLoader.ts` |
| Borne avant le chargement (A2-b) | `readPullBound` : une page d'une ligne de `pull_changes` depuis `'0'`, AVANT les 36 lectures (un chargement envoie désormais 37 requêtes) ; session vérifiée avant l'envoi. Le client V4.2 exige donc la migration 9 sur le serveur (P58) | `src/data/cloud/CloudReader.ts`, `src/data/cloud/cloudLoadCycle.ts` |
| Source de récupération | `CloudReadSource.pull` : `POST /rest/v1/rpc/pull_changes` (une seule tentative, délai de 30 s ; erreurs classées comme les lectures : `rejected` / `PT400` pour `invalid_pull`) ; même contrat sur le serveur simulé | `src/data/cloud/HttpReadSource.ts`, `src/data/cloud/MemoryTransport.ts` |
| Moteur `CloudSync` | 1. curseur lu ; 2. toutes les pages de `[curseur, borne)` récupérées **hors** de la file (session vérifiée avant chaque requête) ; 3. contrôles en mémoire (forme, borne constante, progression, table connue, conversion stricte, **propriétaire = utilisateur**, version ≥ 1, `curseur ≤ sync_txid < borne`, une ligne par clé) ; 4. **dans** la file des opérations : dernière vérification (synchronisation d'actualité, cache non révoqué, session inchangée) puis **une** transaction Dexie (lignes actives écrites, lignes supprimées retirées, versions, curseur porté au maximum de lui-même et de la borne). Une seule synchronisation à la fois par instance (une demande pendant un cycle = une relance). Déclencheurs : `online`, `visibilitychange` (visible), minuterie de 60 s ; `stop()` définitif | `src/data/cloud/CloudSync.ts` |
| File partagée (A5) | File des opérations injectée dans `CloudRepository` et partagée avec `CloudSync` ; aucune méthode ajoutée au dépôt (test de contrat inchangé) | `src/data/cloud/CloudRepository.ts` |
| Branchement | L'espace de travail de la session crée et démarre la synchronisation sur son cache ; `close()` l'arrête PUIS ferme le cache (aucune réouverture automatique) : aucune écriture après une déconnexion ou un changement de compte | `src/data/cloud/cloudWorkspace.ts`, `src/features/auth/CloudApp.tsx` |
| Suite HTTP (D1) | 4 assertions « M9 » : valeurs de `pull_changes` identiques, colonne par colonne, à une lecture REST **complète** (paginée) des 18 tables pour A et pour B (6 030 lignes) ; flottants exacts (0.1 + 0.2, 1/3, 10.86, 4.123456789012345) | `supabase/db-tests/http/rls.mjs` |
| Outillage de qualification | Préfixe `v42-local` (9 migrations, 4 contrôles de précision, traçabilité exigée) ; référence `v42-local.json` = `v41-local.json` + les 4 assertions HTTP ci-dessus (aucune retirée ni renommée ; SQL, catégories et migrations identiques), empreinte épinglée `7cd227a6a76f887e…` | `scripts/check-qualification-evidence.mjs` (+ tests), `scripts/qualification-reference/` |

**Tests applicatifs** (`npm run check` : 65 fichiers, **1 881 / 1 881** tests, typage et build réussis ;
32 tests ajoutés) :
- version la plus haute (2 tests, contrôle négatif : sans la règle, ils échouent) ;
- moteur (`CloudSync.test.ts`, 23 tests) : création, modification, suppression, réactivation ;
  modification pendant le chargement (R2) ; 2 500 changements (3 pages, une transaction) ;
  réapplication sans effet ; R1 de bout en bout ; application après l'écriture en cours (R3) ; une
  seule synchronisation à la fois ; arrêt pendant la récupération, session changée, sans session
  (R6) ; ligne d'un autre utilisateur refusée ; réseau, `invalid_pull`, réponse illisible, quota
  (rien n'est écrit, curseur inchangé) ; deux onglets sur un même cache (curseur jamais en
  arrière) ; chargement complet qui remplace le curseur ; déclencheurs ;
- application réelle avec le vrai SDK (`CloudWorkspace.test.ts`, 4 tests) : création, modification et
  suppression faites ailleurs, affichées **sans rechargement** (aucune nouvelle lecture de table) ;
  retour au premier plan puis écriture sans conflit ; déconnexion (synchronisation arrêtée, cache
  jamais recréé) ; changement de compte (seules des requêtes du nouveau compte) ;
- source HTTP (3 tests) : forme de l'appel, refus `PT400`, 401, 503, réseau ;
- tests existants adaptés : 37 requêtes par chargement au lieu de 36 ; cache en version 3.

**Qualification locale** (`EVIDENCE=v42-local bash scripts/qualify-supabase.sh local`, GitHub
Codespaces, pile recréée puis détruite ; CLI Supabase 2.122.0 ; code testé : commit `f2a5fe6` +
modifications non commitées de V4.2 ; empreinte des migrations `385ced586c63efd2…`, inchangée ;
preuves `docs/qualification/v42-local-*`) : SQL **1 905 / 1 905** ; HTTP **324 / 324** ; précision
4 / 4 ; identiques à PostgreSQL 16 : 1 776, 17 écarts déclarés, 0 régression ; contrôleur de preuves :
« propres, cohérents et complets ». Une première exécution avait signalé un écart sur
`exchange_rates` pour B : défaut du **test** (comparaison à une lecture REST d'une seule requête,
plafonnée à 1 000 lignes par la pile), corrigé par une lecture complète paginée ; aucun écart de
valeur réel.

Points consignés en V4.2 :

| # | Point | Statut | Lot |
|---|---|---|---|
| P57 | **Recette de V4.2 sur NEXORA-DEV non réalisée** : critères du § 7 (« une création sur A apparaît sur B (ouvert) en ≤ 60 s sans rechargement », « suppressions propagées ») vérifiés seulement en local (serveur simulé, vrai SDK) ; la recette exige des écritures sur un compte de test, avec deux navigateurs : autorisation distincte | ouvert | V4.2 (recette sur DEV) |
| P58 | **Contraintes de déploiement du client V4.2** : (a) **la migration 9 (M9, `pull_changes`) doit être appliquée AVANT le déploiement du client V4.2** sur tout environnement : chaque chargement complet commence par un appel à `pull_changes` (borne, A2-b) ; sans la fonction, ce chargement échoue et l'espace Cloud reste inaccessible (écran d'échec du chargement — conséquence déduite du code, non testée contre un serveur sans M9). NEXORA-DEV est conforme (M9 appliquée le 23/11/2026) ; à respecter pour la production. (b) Onglets d'anciennes versions pendant un déploiement (**déduction, non testée**) : le cache passe en version 3 ; un onglet resté sur l'ancien code (version 2) serait fermé par la montée de version et ne pourrait plus lire son cache avant d'être rechargé (le cache est jetable : un rechargement suffit) | accepté, à documenter pour la mise en production | V7 |
| P59 | **Recul momentané de versions par un chargement complet dans un autre onglet** (comportement de V3, inchangé) : le chargement remplace tout le cache par sa propre lecture ; corrigé à la synchronisation suivante, puisque le curseur est remis à la borne de ce chargement | accepté | — |

État global : **V4.2** : développée et qualifiée en local (24/11/2026), aucun commit ; recette sur
DEV non réalisée (P57) ; **V4.3** : non commencée.

Réserves toujours ouvertes après la partie locale de V4.2 : P57 (recette sur DEV), P56, P53, P8
(propriété assumée), P40 (atténué), P58, P38, P41, P45, P46, P48, P49.
