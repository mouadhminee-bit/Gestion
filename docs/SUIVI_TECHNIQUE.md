# NEXORA — Suivi technique (réserves et points ouverts)

Registre des réserves formulées lors des validations de lots. Une réserve est levée
uniquement par un lot validé qui la traite explicitement (test à l'appui).

## Réserves bloquantes pour l'activation du cloud en production

| # | Réserve | Origine | Traitement prévu | Condition de levée |
|---|---|---|---|---|
| R1 | **Restauration de sauvegardes entre utilisateurs** : `restoreBackup` réutilise les identifiants de la sauvegarde. En local (même base), restaurer chez u2 la sauvegarde de u1 réattribue les lignes de u1 ; côté PostgreSQL, la clé primaire globale provoquerait une collision. | Lot 2 (test `it.fails` dans `contract.test.ts`) | Lot 7 : remappage complet des identifiants (y compris références et clés textuelles d'échéances / notifications) | Le test `it.fails` devient un test normal et passe ; restauration d'une même sauvegarde dans deux comptes sans collision |
| R2 | **Atomicité de `saveAsset` et de la valorisation initiale** : l'actif et sa première valorisation sont écrits dans deux opérations distinctes. | Lot 2 (§ 8.7 du rapport) | Travaux de fiabilisation (à placer dans un lot, au plus tard avant la mise en production cloud) | Panne simulée entre les deux écritures → ni actif ni valorisation (test sur les deux repositories) |
| R3 | **Concurrence entre plusieurs appareils** : `CloudRepository` sérialise les appels d'une instance, mais deux appareils peuvent modifier la même ligne. | Lot 2 (§ 8.1) | Lot 3 : colonne `version` et métadonnées de synchronisation ; Lot 4 : contrôle de version optimiste dans `apply_changeset` (rejet + rechargement, sans fusion automatique) ; Lot 5 : récupération des changements | Test à deux clients : la seconde écriture concurrente sur une ligne est rejetée avec un conflit, aucune donnée n'est perdue |

## Points ouverts (non bloquants, à suivre)

| # | Point | Origine | Lot |
|---|---|---|---|
| P1 | Cache cloud en retard si l'écriture du cache échoue après acceptation du serveur | Lot 2 § 8.2 | 5 |
| P2 | `ChangeSet` sans version ; correspondance des tables `users` / `meta` vers le serveur | Lot 2 § 8.3 | 4 |
| P3 | Références orphelines possibles dans les données locales existantes (suppressions physiques en IndexedDB : compte supprimé encore référencé par un objectif, etc.) : à détecter et réparer avant toute migration des données Edge | Cadrage Lot 3 | lot « migration Edge » |
| P4 | Pièces jointes exclues des sauvegardes JSON alors que `transactions.attachmentId` est conservé | existant | 7 |
| P5 | Purge des lignes supprimées logiquement (croissance des tombstones) | Cadrage Lot 3 | 8 |
| P6 | `restoreBackup` ne valide aucune ligne : une sauvegarde corrompue ou modifiée à la main peut contenir des valeurs que le schéma refuse. Valider les sauvegardes avant écriture | Lot 3 (rapport § 8) | 7 |
| P7 | Réutiliser l'UUID d'une ligne d'autrui provoque une collision de clé (23505) : révèle l'existence d'un UUID aléatoire, sans accès aux données | Lot 3 | 7 (avec R1) |
| P8 | Une transaction longue retient la borne de récupération (`pg_snapshot_xmin`) : aucune perte, mais retard de synchronisation | Lot 3 | 4–5 |
| P9 | Validation du schéma sur la vraie pile Supabase (`supabase start` dans Codespaces, puis projet de développement) ; aligner `major_version` de `supabase/config.toml` | Lot 3 (étape 3b) | 3b / 4 |
| P10 | Si le rôle `postgres` de Supabase n'a pas `BYPASSRLS`, le déclencheur d'inscription `handle_new_user` (`SECURITY DEFINER`, propriétaire `postgres`) ne peut pas insérer dans `profiles` (RLS forcée) : inscription impossible. Reproduit en local (profil « supabase-like » sans `BYPASSRLS`) ; à trancher par Q1 | Étape 3b | 3b / 4 |
