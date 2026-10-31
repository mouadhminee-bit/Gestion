# NEXORA — étape 3b-2 : qualification PostgreSQL 17 (locale, éphémère)

*Exécutée le 01/11/2026 dans la session de préparation, sur des clusters temporaires
(`/tmp`, socket Unix uniquement, détruits après chaque exécution). Binaires PostgreSQL 17.11
du paquet npm `@embedded-postgres/linux-x64@17.11.0-beta.19` (installés dans `/tmp`, supprimés
ensuite). Aucune connexion à Supabase. Données fictives uniquement.*

## Résultats

| Exécution | Serveur | Rôle administrateur des tests | Assertions | Échecs | Écarts vs référence PG 16 |
|---|---|---|---|---|---|
| Référence (`supabase/db-tests/baseline/pg16.json`) | PostgreSQL 16.15 | `postgres` (superutilisateur) | 1 057 | 0 | — |
| PG 17 | PostgreSQL 17.11 | `postgres` (superutilisateur) | 1 057 | 0 | **0** |
| PG 17, administrateur non superutilisateur | PostgreSQL 17.11 | `service_role` (authentification SCRAM, dblink par mot de passe) | 1 057 | 0 | **0** |
| PG 16, administrateur non superutilisateur | PostgreSQL 16.15 | `service_role` | 1 057 | 0 | **0** |

Les deux dernières lignes simulent le cas où le rôle `postgres` de Supabase ne contournerait
pas la RLS forcée (question Q1) : l'outillage bascule alors sur `service_role`, et les suites
restent identiques.

## Comparaison détaillée PG 16 → PG 17

| | Référence | Cible |
|---|---|---|
| Version PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | 17.11 |
| Assertions | 1057 | 1057 |
| Échecs | 0 | 0 |

Identiques : **1057** · manquantes : **0** · en plus : **0** · régressions : **0**

| Fichier | Réussies | Échecs |
|---|---|---|
| 01_catalog.sql | 556 | 0 |
| 02_isolation.sql | 297 | 0 |
| 03_triggers.sql | 20 | 0 |
| 04_constraints.sql | 101 | 0 |
| 05_relations.sql | 7 | 0 |
| 06_soft_delete.sql | 16 | 0 |
| 07_sync.sql | 16 | 0 |
| 08_lifecycle.sql | 44 | 0 |

Aucun écart.

Résultats bruts : `docs/qualification/3b-pg17-local.json`.

## Défauts d'outillage révélés et corrigés pendant la préparation

| Défaut | Correction |
|---|---|
| `'private.tg_sync_metadata'::regproc` exige l'accès au schéma `private`, refusé (à juste titre) à un administrateur non superutilisateur | recherche par nom dans `pg_proc` |
| `dblink` lancé par un non-superutilisateur exige une connexion authentifiée par mot de passe | DSN avec mot de passe (pile Supabase locale) ; mode SCRAM du cluster éphémère pour la simulation |
| `pg_has_role('authenticator', …)` échoue si le rôle n'existe pas | test d'existence préalable |
| Instructions de test exécutées avec l'utilisateur de session | session ouverte avec le rôle administrateur ; seules les opérations sur `auth.users` reviennent à l'utilisateur de session |

Aucun de ces défauts ne concerne les migrations : le schéma est **identique** sur PG 16 et PG 17.
