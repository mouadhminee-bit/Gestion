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
| P28 | Synchronisation incrémentale : aucune fonction serveur de lecture des changements n'existe (seul un prototype figure dans l'outillage de test) ; une nouvelle migration et sa qualification seront nécessaires | ouvert | récupération des changements (Lot 5 du dépôt) |
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
| P35 | **Chemin de succès non validé réellement sur NEXORA-DEV** : V3.3 n'a exécuté sur DEV que des refus (décision du 19/11/2026 : aucune donnée des comptes de test modifiée) ; le chemin de succès n'est couvert qu'en simulation et **ne doit pas être considéré comme acquis**. Critère restant : exécuter réellement un `apply_changeset` accepté ; appeler ensuite `resolve_changeset` sur le même lot ; vérifier le résultat `replayed` ; vérifier que les données persistées correspondent exactement au lot soumis | ouvert | **V3.7** (report acté en V3.5, arbitrage A6 : essai dédié sous autorisation d'écriture sur DEV) |

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
| P37 | **Validation dans un vrai navigateur** : ordre « fin de la transaction, puis suppression » prévu par la norme IndexedDB (fake-indexeddb 6.0.0 supprime d'abord ; seul l'état final est vérifié), comportement multi-onglets (`BroadcastChannel` du SDK : testé sous jsdom avec le vrai SDK et le `BroadcastChannel` de Node, non dans un navigateur), quota IndexedDB réel (simulé), réouverture du cache après suppression | ouvert | V3.7 |
| P38 | **Hypothèse H1** (preuve d'intégralité de la lecture) : aucune ligne métier n'est effacée physiquement pendant un chargement (`authenticated` sans `DELETE`, suppression logique par `apply_changeset`, clés jamais modifiées). À réexaminer avant toute purge (P5, P14, P31) ou toute suppression de compte | ouvert | avant V7 |
| P39 | **Lecture et chargement non validés sur NEXORA-DEV** : lecture seule, sans aucune écriture — distinct de **P35**, qui porte sur l'écriture (lot accepté, puis `replayed`). les essais réels en lecture seule prévus au cadrage (chargement du compte B comparé à une lecture directe, profil du compte A, isolation, conversion des 18 tables réelles, jeton falsifié, déconnexion réelle) n'ont pas été réalisés ; seule une ligne `accounts` réelle a été convertie (V3.3) | ouvert | **V3.7**, sur autorisation (report acté en V3.5, arbitrage A6) |
| P40 | **Lecture non transactionnelle entre les 18 tables** : une modification sur place pendant un chargement laisse une version antérieure dans le cache (sans danger : l'écriture suivante est refusée par conflit) ; un instantané exact relève de V4 (M9, borne P8). Pièces jointes chargées sans fichier (`blob` local, jamais transmis) : sans effet tant qu'elles sont désactivées en mode Cloud | accepté | V4 / V5 |
| P41 | Comportements de V3.2 conservés : une déconnexion faite dans un autre onglet s'affiche « session expirée » dans les onglets restants ; un `SIGNED_IN` venu d'un autre onglet est accepté sans nouvelle vérification (le changement de compte entre onglets repose sur ce comportement). Suppression du cache en arrière-plan, bornée à 5 s ; un cache dont la suppression est bloquée est purgé à l'ouverture de session suivante. Traductions des 5 nouvelles clés et de `cloud.pending` non relues par des locuteurs natifs | ouvert | V3.7 / V6 |
| P42 | **SMTP personnalisé** (réserve de clôture de V2, 19/11/2026) : NEXORA-DEV exige la confirmation de l'e-mail (V2.3) et utilise le serveur d'e-mail par défaut de Supabase, limité ; l'inscription réelle d'un nouvel utilisateur requiert un SMTP personnalisé, à configurer avant l'étape 2 (confirmation de l'e-mail) du parcours de V3.7 | ouvert | avant l'étape 2 de V3.7 |

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
| P46 | Traductions des 8 nouvelles clés non relues par des locuteurs natifs ; comportement réel du lecteur O1 (suivi de Dexie, multi-onglets) à confirmer dans un vrai navigateur | ouvert | V3.7 / V6 |

Réserves toujours ouvertes après V3.5 : **P35** et **P39** (V3.7, sur autorisation), **P42**
(SMTP, avant l'étape 2 du parcours V3.7), P37, P41, P45, P46.
