# NEXORA — Suivi technique (réserves et points ouverts)

Registre des réserves formulées lors des validations de lots. Une réserve est levée
uniquement par un lot validé qui la traite explicitement (test à l'appui).

## Réserves bloquantes pour l'activation du cloud en production

| # | Réserve | Origine | Traitement prévu | Condition de levée |
|---|---|---|---|---|
| R1 | **Restauration de sauvegardes entre utilisateurs** : `restoreBackup` réutilise les identifiants de la sauvegarde. En local (même base), restaurer chez u2 la sauvegarde de u1 réattribue les lignes de u1 ; côté PostgreSQL, la clé primaire globale provoquerait une collision. | Lot 2 (test `it.fails` dans `contract.test.ts`) | Lot 7 : remappage complet des identifiants (y compris références et clés textuelles d'échéances / notifications) | Le test `it.fails` devient un test normal et passe ; restauration d'une même sauvegarde dans deux comptes sans collision |
| R2 | **Atomicité de `saveAsset` et de la valorisation initiale** : l'actif et sa première valorisation sont écrits dans deux opérations distinctes. Constat complémentaire (audit Lot 4) : la valorisation était validée **après** l'écriture de l'actif (valorisation invalide → actif créé puis erreur, y compris en mode local) ; `resetToEmpty` enchaînait trois écritures non atomiques. | Lot 2 (§ 8.7 du rapport) | **Lot 4, étape 4.1** : `saveAsset` et `resetToEmpty` en une seule transaction, validations avant toute écriture | Panne simulée entre les deux écritures → ni actif ni valorisation (test sur les deux repositories) — **corrigée et testée à l'étape 4.1 (23 tests, contrôles par mutation, `docs/LOT4_PLAN.md` § 4) ; levée formelle à la validation du Lot 4** |
| R3 | **Concurrence entre plusieurs appareils** : `CloudRepository` sérialise les appels d'une instance, mais deux appareils peuvent modifier la même ligne. | Lot 2 (§ 8.1) | Lot 3 : colonne `version` et métadonnées de synchronisation ; Lot 4 : contrôle de version optimiste dans `apply_changeset` (rejet + rechargement, sans fusion automatique) ; Lot 5 : récupération des changements | Test à deux clients : la seconde écriture concurrente sur une ligne est rejetée avec un conflit, aucune donnée n'est perdue — **partiellement réalisé (étape 4.3)** : protocole ChangeSet v1 (versions attendues, `changesetId`), versions dans le cache, serveur simulé : la seconde écriture concurrente est rejetée en entier, rien n'est perdu (deux appareils, deux onglets, lecture hors transaction — `docs/LOT4_PLAN.md` § 6). **Étape 4.4 (implémentée, non qualifiée)** : contrôle optimiste dans PostgreSQL (`apply_changeset`, migration 8) — toutes les versions vérifiées avant écriture, verrou par utilisateur ; testé avec deux sessions réelles (seconde écriture → `version_conflict`, rien d'écrasé) sur PG 16/17 éphémères (`docs/LOT4_PLAN.md` § 7). **Restent** : qualification 4.5 (suites adaptées) et 4.6 (HTTP), rechargement après conflit (Lot 5) |

## Points ouverts (non bloquants, à suivre)

| # | Point | Origine | Lot |
|---|---|---|---|
| P1 | Cache cloud en retard si l'écriture du cache échoue après acceptation du serveur. **Atténué à l'étape 4.3** : le résultat accepté est conservé et réappliqué avant toute nouvelle écriture (`CloudCacheWriteError`) ; perdu si l'application est fermée entre-temps → rattrapage par la récupération des changements | Lot 2 § 8.2 | 5 |
| P2 | `ChangeSet` sans version ; correspondance des tables `users` / `meta` vers le serveur. **Correspondance traitée à l'étape 4.2** (`src/data/cloud/mapping.ts` : `users` → `profiles` en mise à jour seule, `meta` exclue — `docs/LOT4_PLAN.md` § 5) ; **version du `ChangeSet` : traitée à l'étape 4.3** (protocole v1, `docs/LOT4_PLAN.md` § 6) ; `meta` exclue du protocole (locale, jamais transmise, refusée par le serveur simulé — § 6.10) | Lot 2 § 8.3 | 4 |
| P3 | Références orphelines possibles dans les données locales existantes (suppressions physiques en IndexedDB : compte supprimé encore référencé par un objectif, etc.) : à détecter et réparer avant toute migration des données Edge | Cadrage Lot 3 | lot « migration Edge » |
| P4 | Pièces jointes exclues des sauvegardes JSON alors que `transactions.attachmentId` est conservé | existant | 7 |
| P5 | Purge des lignes supprimées logiquement (croissance des tombstones) | Cadrage Lot 3 | 8 |
| P6 | `restoreBackup` ne valide aucune ligne : une sauvegarde corrompue ou modifiée à la main peut contenir des valeurs que le schéma refuse. Valider les sauvegardes avant écriture | Lot 3 (rapport § 8) | 7 |
| P7 | Réutiliser l'UUID d'une ligne d'autrui provoque une collision de clé (23505) : révèle l'existence d'un UUID aléatoire, sans accès aux données | Lot 3 | 7 (avec R1) |
| P8 | Une transaction longue retient la borne de récupération (`pg_snapshot_xmin`) : aucune perte, mais retard de synchronisation | Lot 3 | 4–5 |
| P9 | Qualification du schéma sur la vraie pile Supabase. **Pile Supabase locale : qualification réussie** (étape 3b, Codespaces : SQL 1 152/1 152, HTTP 143/143, 7 migrations, `major_version = 17` aligné). **Validation sur un projet hébergé : non réalisée** (3b-4 reportée) | Lot 3 (étape 3b) | 3b-4 |
| P10 | Inscription impossible si le rôle `postgres` n'a pas `BYPASSRLS` (déclencheur `handle_new_user`, RLS forcée sur `profiles`). **Résolu pour la pile Supabase locale testée** (Q1 positive ; profil créé à l'inscription vérifié par la suite HTTP 143/143). **Reste ouvert : vérification sur un projet hébergé** | Étape 3b | 3b-4 |

## Points clos

| # | Point | Clôture | Preuves |
|---|---|---|---|
| P11 | Arrondi des `double precision` dans les réponses de l'API (l'image Supabase fixe `extra_float_digits = 0`) | **Clos pour la pile Supabase locale** — étape 3b, 01/11/2026. Sur un projet hébergé, l'application des réglages de rôle de la migration 7 reste à vérifier dans le cadre de P9 | Perte localisée à la sérialisation de la réponse (écriture et stockage exacts, bits vérifiés) ; correction par la migration 7 ; **143/143 HTTP et 8/8 contrôles de précision** sur la pile locale ; mutation sans migration 7 = mêmes 3 valeurs en échec (`docs/qualification/3b-pg17-local.md` § 6) |

Archivage des preuves : `docs/LOT3B_CLOTURE.md` § 3 (les rapports bruts de l'exécution
Codespaces sont à contrôler par `scripts/check-qualification-evidence.mjs` avant ajout).

## Points ouverts ajoutés à l'étape 4.4 (décisions en attente : `docs/LOT4_PLAN.md` § 7.11)

| # | Point | Lot |
|---|---|---|
| P12 | Les suites SQL du Lot 3 (01–10) et la suite HTTP `rls.mjs` reposent sur des écritures directes d'`authenticated` et sur des invariants que la migration 8 rend faux (politiques du rôle d'écriture, 2 RPC dans `public`) : adaptation à décider (D4-9) avant la qualification 4.5 / 4.6 | 4.5–4.6 |
| P13 | Rôle `nexora_writer` : création et transfert de propriété des fonctions par `postgres`, `statement_timeout` d'`authenticated` et taille maximale des requêtes de la passerelle à vérifier sur la pile Supabase (D4-10, D4-12) | 4.6 |
| P14 | Croissance de `private.changesets` (une ligne par lot) : purge à définir | 8 |
| P15 | Écarts `MemoryTransport` / serveur (périmètre de `changesetId`, création de profil, `changeset_pending`, codes d'erreur) : aligner avec le transport HTTP (D4-13) | 5 |
