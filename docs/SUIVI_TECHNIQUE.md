# NEXORA — Suivi technique (réserves et points ouverts)

Registre des réserves formulées lors des validations de lots. Une réserve est levée
uniquement par un lot validé qui la traite explicitement (test à l'appui).

## Réserves bloquantes pour l'activation du cloud en production

| # | Réserve | Origine | Traitement prévu | Condition de levée |
|---|---|---|---|---|
| R1 | **Restauration de sauvegardes entre utilisateurs** : `restoreBackup` réutilise les identifiants de la sauvegarde. En local (même base), restaurer chez u2 la sauvegarde de u1 réattribue les lignes de u1 ; côté PostgreSQL, la clé primaire globale provoquerait une collision. | Lot 2 (test `it.fails` dans `contract.test.ts`) | Lot 7 : remappage complet des identifiants (y compris références et clés textuelles d'échéances / notifications) | Le test `it.fails` devient un test normal et passe ; restauration d'une même sauvegarde dans deux comptes sans collision |
| R2 | **Atomicité de `saveAsset` et de la valorisation initiale** : l'actif et sa première valorisation sont écrits dans deux opérations distinctes. Constat complémentaire (audit Lot 4) : la valorisation était validée **après** l'écriture de l'actif (valorisation invalide → actif créé puis erreur, y compris en mode local) ; `resetToEmpty` enchaînait trois écritures non atomiques. | Lot 2 (§ 8.7 du rapport) | **Lot 4, étape 4.1** : `saveAsset` et `resetToEmpty` en une seule transaction, validations avant toute écriture | Panne simulée entre les deux écritures → ni actif ni valorisation (test sur les deux repositories) — **corrigée et testée à l'étape 4.1 (23 tests, contrôles par mutation, `docs/LOT4_PLAN.md` § 4) ; levée formelle à la validation du Lot 4** |
| R3 | **Concurrence entre plusieurs appareils** : `CloudRepository` sérialise les appels d'une instance, mais deux appareils peuvent modifier la même ligne. | Lot 2 (§ 8.1) | Lot 3 : colonne `version` et métadonnées de synchronisation ; Lot 4 : contrôle de version optimiste dans `apply_changeset` (rejet + rechargement, sans fusion automatique) ; Lot 5 : récupération des changements | Test à deux clients : la seconde écriture concurrente sur une ligne est rejetée avec un conflit, aucune donnée n'est perdue — **partiellement réalisé (étape 4.3)** : protocole ChangeSet v1 (versions attendues, `changesetId`), versions dans le cache, serveur simulé : la seconde écriture concurrente est rejetée en entier, rien n'est perdu (deux appareils, deux onglets, lecture hors transaction — `docs/LOT4_PLAN.md` § 6). **Étape 4.4 (implémentée, non qualifiée)** : contrôle optimiste dans PostgreSQL (`apply_changeset`, migration 8) — toutes les versions vérifiées avant écriture, verrou par utilisateur ; testé avec deux sessions réelles (seconde écriture → `version_conflict`, rien d'écrasé) sur PG 16/17 éphémères (`docs/LOT4_PLAN.md` § 7). ~~**Restent** : qualification 4.5 (suites adaptées) et 4.6 (HTTP), rechargement après conflit (Lot 5)~~ — **mis à jour (Lot 0)** : contrôle optimiste qualifié sur la pile Supabase **locale** (suites adaptées : SQL 1 847 / 1 847 ; HTTP 302 / 302 avec deux utilisateurs réels : seconde écriture concurrente → `version_conflict`, rien d'écrasé ; deux requêtes simultanées → une seule acceptée), reproduit à l'identique dans le Codespace (`docs/LOT0_QUALIFICATION.md` § 10). **Restent** : qualification hébergée, rechargement après conflit (Lot 5) |

## Points ouverts (non bloquants, à suivre)

| # | Point | Origine | Lot |
|---|---|---|---|
| P1 | Cache cloud en retard si l'écriture du cache échoue après acceptation du serveur. **Atténué à l'étape 4.3** : le résultat accepté est conservé et réappliqué avant toute nouvelle écriture (`CloudCacheWriteError`) ; perdu si l'application est fermée entre-temps → rattrapage par la récupération des changements | Lot 2 § 8.2 | 5 |
| P2 | `ChangeSet` sans version ; correspondance des tables `users` / `meta` vers le serveur. **Correspondance traitée à l'étape 4.2** (`src/data/cloud/mapping.ts` : `users` → `profiles` en mise à jour seule, `meta` exclue — `docs/LOT4_PLAN.md` § 5) ; **version du `ChangeSet` : traitée à l'étape 4.3** (protocole v1, `docs/LOT4_PLAN.md` § 6) ; `meta` exclue du protocole (locale, jamais transmise, refusée par le serveur simulé — § 6.10) | Lot 2 § 8.3 | 4 |
| P3 | Références orphelines possibles dans les données locales existantes (suppressions physiques en IndexedDB : compte supprimé encore référencé par un objectif, etc.) : à détecter et réparer avant toute migration des données Edge | Cadrage Lot 3 | lot « migration Edge » |
| P4 | Pièces jointes exclues des sauvegardes JSON alors que `transactions.attachmentId` est conservé. **Traité par le correctif Backup / Restore v2 (en attente de validation)** : pièces jointes exportées (base64) et restaurées ; une pièce jointe référencée mais absente du fichier (fichier v1) est conservée localement (`docs/BACKUP_RESTORE.md` § 5, tests « 14 » et « 20 ») | existant | v2 / 7 (stockage distant) |
| P5 | Purge des lignes supprimées logiquement (croissance des tombstones) | Cadrage Lot 3 | 8 |
| P6 | `restoreBackup` ne valide aucune ligne : une sauvegarde corrompue ou modifiée à la main peut contenir des valeurs que le schéma refuse. Valider les sauvegardes avant écriture. **Traité par le correctif Backup / Restore v2 (en attente de validation)** : migration et validation stricte (structure, types, identifiants, relations) avant toute écriture, transaction unique contrôlée après écriture (`docs/BACKUP_RESTORE.md` § 2–4 ; 51 tests Local + Cloud) | Lot 3 (rapport § 8) | v2 |
| P7 | Réutiliser l'UUID d'une ligne d'autrui provoque une collision de clé (23505) : révèle l'existence d'un UUID aléatoire, sans accès aux données | Lot 3 | 7 (avec R1) |
| P8 | Une transaction longue retient la borne de récupération (`pg_snapshot_xmin`) : aucune perte, mais retard de synchronisation | Lot 3 | 4–5 |
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
| P15 | Écarts `MemoryTransport` / serveur (périmètre de `changesetId`, création de profil, `changeset_pending`, codes d'erreur, **clé canonique exigée par le serveur depuis le Lot 0**) : aligner avec le transport HTTP (D4-13) | 5 |

## Points ouverts ajoutés par le correctif Backup / Restore v2 (`docs/BACKUP_RESTORE.md`)

| # | Point | Lot |
|---|---|---|
| P16 | Les liens historiques orphelins (avertissements non bloquants à la restauration : règle → compte supprimé, objectif → compte lié, etc.) sont acceptés en local et par `MemoryTransport`, mais le schéma PostgreSQL les refuse (clés étrangères différées, sauf `attachment_id`) : une restauration cloud serait rejetée en bloc. À traiter avec P3 (détection / réparation) avant toute restauration vers le cloud | 7 (avec P3) |
| P17 | Sauvegardes volumineuses : pièces jointes en base64 dans le JSON (+33 %), fichier lu intégralement en mémoire (limite d'interface 100 Mo). Format d'archive (ZIP : JSON + fichiers) proposé, non implémenté | 7 |
| P18 | La sauvegarde de sécurité est téléchargée avant le remplacement ; son enregistrement effectif sur le disque ne peut pas être vérifié par le navigateur. **Atténué (en attente de validation)** : annulation immédiate, sauvegarde de sécurité conservée en mémoire de l'onglet (`docs/BACKUP_RESTORE.md` § 6.1, tests Local + Cloud, jsdom et E2E). Reste ouvert : perte de l'annulation au rechargement / à la fermeture de l'onglet (le fichier téléchargé est alors le seul recours) | atténué |
| P19 | Constat de revue A1 : le protocole `ChangeSet` (étape 4.3) transmet la ligne complète ; avec `MemoryTransport`, le `blob` des pièces jointes est transmis et stocké (préexistant, `addAttachment` compris). Le futur transport HTTP doit appliquer `toCloudRow()` / `serializeRow()` pour que le fichier ne quitte jamais l'appareil (`docs/BACKUP_RESTORE.md` § 5). **Requalifié (Lot 0)** : rattaché initialement à « 4.5–4.6 », non traité au Lot 0 car aucun transport réseau n'existe ; il relève de l'écriture du transport HTTP | transport HTTP (Lot 5 du dépôt) |

## Points ouverts ajoutés au Lot 0 (`docs/LOT0_QUALIFICATION.md`)

| # | Point | Lot |
|---|---|---|
| P20 | Dans `apply_changeset`, toute erreur survenant pendant les écritures d'un lot (hors conflit et erreurs du protocole) est rapportée `invalid_row`, donc comme un refus définitif, y compris une erreur transitoire (ressources, verrou) ; le SQLSTATE d'origine figure dans `details.sqlstate`. Le transport HTTP devra distinguer ces cas, ou la fonction limiter `invalid_row` aux classes 22 / 23 et au refus du déclencheur | transport HTTP |
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
| P28 | Synchronisation incrémentale : aucune fonction serveur de lecture des changements n'existe (seul un prototype figure dans l'outillage de test) ; une nouvelle migration et sa qualification seront nécessaires | ouvert | récupération des changements (Lot 5 du dépôt) |
| P29 | Contrôles de sécurité par mutation (10) : **versionnés par la remédiation** (`scripts/security-mutations/`, portage vérifié identique à l'original ; 10 / 10 détectées, mêmes nombres d'échecs qu'au Lot 0). Restent : pas d'automatisation côté HTTP ; exige les binaires PostgreSQL 16 | traité, en attente de validation | Lot 0 |
| P30 | Délai d'exécution (`statement_timeout` d'`authenticated` = 8 s) : lot de 5 000 opérations appliqué en 3,09 s sur la pile locale du Codespace (2,2 s dans la session cloud) ; mesure hébergée manquante (voir P13) | partiellement traité | qualification hébergée |
| P31 | Quotas et purge : aucun quota par utilisateur ; purges des lignes supprimées (P5) et de `private.changesets` (P14) non définies | ouvert, à traiter avant l'ouverture publique | Lot 8 |

Les erreurs transitoires classées comme refus définitifs restent suivies par P20 (transport HTTP).

## Points ouverts ajoutés par la qualification hébergée (17 et 18/11/2026)

| # | Point | Statut | Lot |
|---|---|---|---|
| P32 | Déclencheur d'événement `ensure_rls` de NEXORA-DEV (`public.rls_auto_enable()`, `SECURITY DEFINER`, propriétaire `postgres`) : active la RLS, sans la forcer, sur les tables créées dans `public` uniquement ; erreurs interceptées et seulement journalisées. Compatible avec les migrations 1 à 8 (la migration 6 active et force la RLS ; `private` et `tests` non concernés) | constaté, compatible | Niveau 4 (à observer) |
| P33 | Migration 7 : `postgres` détient l'option ADMIN sur `anon`, `authenticated`, `service_role`, mais ces rôles sont réservés par `supautils` et `extra_float_digits` n'est pas dans `supautils.privileged_role_allowed_configs` ; l'hébergé a `extra_float_digits = 0` (P11 confirmé). Réussite de la migration 7 incertaine | ouvert | Niveau 4 |
| P34 | Privilèges par défaut de NEXORA-DEV plus restrictifs que la pile locale (tables créées par `postgres` : `Dxtm` seulement pour `anon`, `authenticated`, `service_role` ; fonctions et séquences réservées à `postgres`). Les migrations procèdent par `revoke all` puis par des droits explicites ; l'effet sur les assertions des suites (notamment `service_role`) reste à vérifier | ouvert | Niveau 3 |
