# NEXORA — résultats bruts de la qualification sur la pile Supabase locale (lot4-local)

*Généré par `scripts/qualify-supabase.sh local` le 2026-11-14T14:58:35Z (UTC). Données fictives uniquement ; jetons et clés masqués.*

| Élément | Valeur |
|---|---|
| Serveur | `PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit` |
| CLI Supabase | `2.122.0` |
| Migrations appliquées | `20261101000100 20261101000200 20261101000300 20261101000400 20261101000500 20261101000600 20261101000700 20261101000800` |
| Rôle administrateur des tests (Q1) | `postgres` |
| Fichiers SQL interrompus | aucun |
| Code de sortie HTTP / chaîne numérique / comparaison | 0 / 0 / 0 |

## Composants de la pile

| Conteneur | Image |
|---|---|
| `supabase_auth_nexora` | `public.ecr.aws/supabase/gotrue:v2.197.0` |
| `supabase_db_nexora` | `public.ecr.aws/supabase/postgres:17.11.0.006` |
| `supabase_inbucket_nexora` | `public.ecr.aws/supabase/mailpit:v1.31.3` |
| `supabase_kong_nexora` | `public.ecr.aws/supabase/kong:2.8.1` |
| `supabase_rest_nexora` | `public.ecr.aws/supabase/postgrest:v16.5` |
| `supabase_storage_nexora` | `public.ecr.aws/supabase/storage-api:v1.84.19` |

## Suites SQL : comparaison avec PostgreSQL 16 local

| | Référence | Cible |
|---|---|---|
| Version PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | 17.11 |
| Assertions | 1793 | 1847 |
| Échecs | 0 | 0 |

Identiques : **1793** · manquantes : **0** · en plus : **54** · régressions : **0**

| Fichier | Réussies | Échecs |
|---|---|---|
| 01_catalog.sql | 809 | 0 |
| 02_isolation.sql | 402 | 0 |
| 03_triggers.sql | 34 | 0 |
| 04_constraints.sql | 122 | 0 |
| 05_relations.sql | 10 | 0 |
| 06_soft_delete.sql | 28 | 0 |
| 07_sync.sql | 16 | 0 |
| 08_lifecycle.sql | 78 | 0 |
| 09_harness_security.sql | 15 | 0 |
| 10_api_serialization.sql | 17 | 0 |
| 11_apply_changeset.sql | 266 | 0 |
| P1_supabase_platform.sql | 50 | 0 |

| Écart | Assertion | Détail |
|---|---|---|
| en plus | 10_api_serialization.sql :: CONSTAT taux 0.1 + 0.2 sans réglage de rôle (session à 0) | ok |
| en plus | 10_api_serialization.sql :: CONSTAT taux 1/3 sans réglage de rôle (session à 0) | ok |
| en plus | 10_api_serialization.sql :: CONSTAT taux 10.86 sans réglage de rôle (session à 0) | ok |
| en plus | 10_api_serialization.sql :: CONSTAT taux d'intérêt 4.123456789012345 sans réglage de rôle (session à 0) | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT version du serveur | ok |
| en plus | P1_supabase_platform.sql :: rôle anon présent | ok |
| en plus | P1_supabase_platform.sql :: rôle authenticated présent | ok |
| en plus | P1_supabase_platform.sql :: rôle service_role présent | ok |
| en plus | P1_supabase_platform.sql :: rôle authenticator présent | ok |
| en plus | P1_supabase_platform.sql :: anon : pas de connexion directe | ok |
| en plus | P1_supabase_platform.sql :: authenticated : pas de connexion directe | ok |
| en plus | P1_supabase_platform.sql :: anon : soumis à la RLS | ok |
| en plus | P1_supabase_platform.sql :: authenticated : soumis à la RLS | ok |
| en plus | P1_supabase_platform.sql :: service_role : contourne la RLS (clé serveur uniquement) | ok |
| en plus | P1_supabase_platform.sql :: authenticator (PostgREST) peut endosser anon | ok |
| en plus | P1_supabase_platform.sql :: authenticator (PostgREST) peut endosser authenticated | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT Q1 rôle postgres et RLS forcée | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT propriétaire des tables | ok |
| en plus | P1_supabase_platform.sql :: Q2 déclencheur on_auth_user_created présent sur auth.users | ok |
| en plus | P1_supabase_platform.sql :: Q3 utilisateurs fictifs créés directement dans auth.users | ok |
| en plus | P1_supabase_platform.sql :: base de qualification : aucun utilisateur autre que les comptes fictifs | ok |
| en plus | P1_supabase_platform.sql :: Q4 dblink disponible (suite de synchronisation exécutée) | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT extra_float_digits de la session d'administration | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT réglages par base / par rôle (pg_db_role_setting) | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT extensions installées | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT déclencheurs d'événements | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT Q5 privilèges par défaut sur public (révoqués table par table par la migration 6) | ok |
| en plus | P1_supabase_platform.sql :: Q5 user_settings : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 accounts : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 transactions : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 attachments : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 budgets : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 savings_goals : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 recurring_rules : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 recurring_occurrences : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 debts : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 debt_payments : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 categories : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 import_batches : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 goal_contributions : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 assets : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 asset_valuations : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 exchange_rates : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 notification_states : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 profiles : invisible pour anon (API REST et GraphQL) | ok |
| en plus | P1_supabase_platform.sql :: Q5 fonctions RPC dans public : apply_changeset et resolve_changeset uniquement | ok |
| en plus | P1_supabase_platform.sql :: Q5 apply_changeset : exécutable par authenticated seulement | ok |
| en plus | P1_supabase_platform.sql :: Q5 apply_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | ok |
| en plus | P1_supabase_platform.sql :: Q5 resolve_changeset : exécutable par authenticated seulement | ok |
| en plus | P1_supabase_platform.sql :: Q5 resolve_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT P13 rôle nexora_writer | ok |
| en plus | P1_supabase_platform.sql :: P13 nexora_writer : ni superutilisateur, ni BYPASSRLS, ni connexion | ok |
| en plus | P1_supabase_platform.sql :: P13 ni authenticator, ni authenticated, ni anon ne sont membres de nexora_writer | ok |
| en plus | P1_supabase_platform.sql :: CONSTAT P13 réglages des rôles de l'API (statement_timeout, lock_timeout…) | ok |

## Constats plateforme (Q1–Q5)

| Constat | Valeur |
|---|---|
| CONSTAT sérialisation des flottants de la session | extra_float_digits = 0 (source : configuration file) ; texte de 0.30000000000000004 dans cette session : 0.3 |
| CONSTAT taux 0.1 + 0.2 sans réglage de rôle (session à 0) | JSON [{"rate":0.3}] → bits 3fd3333333333333 (ARRONDI) |
| CONSTAT taux 1/3 sans réglage de rôle (session à 0) | JSON [{"rate":0.333333333333333}] → bits 3fd555555555554f (ARRONDI) |
| CONSTAT taux 10.86 sans réglage de rôle (session à 0) | JSON [{"rate":10.86}] → bits 4025b851eb851eb8 (exact) |
| CONSTAT taux d'intérêt 4.123456789012345 sans réglage de rôle (session à 0) | JSON [{"rate":4.12345678901235}] → bits 40107e6b74dd1bde (ARRONDI) |
| CONSTAT extra_float_digits hérité par les sessions | 0 (source : configuration file, fichier : /etc/postgresql/postgresql.conf) |
| CONSTAT version du serveur | PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit |
| CONSTAT Q1 rôle postgres et RLS forcée | postgres : superuser=f, bypassrls=t ; rôle administrateur des tests = postgres |
| CONSTAT propriétaire des tables | postgres |
| Q2 déclencheur on_auth_user_created présent sur auth.users |  |
| Q3 utilisateurs fictifs créés directement dans auth.users |  |
| Q4 dblink disponible (suite de synchronisation exécutée) |  |
| CONSTAT extra_float_digits de la session d'administration | valeur=0, source=configuration file, fichier=/etc/postgresql/postgresql.conf:673, défaut compilé=1 |
| CONSTAT réglages par base / par rôle (pg_db_role_setting) | toutes bases / postgres : search_path="\$user", public, extensions ; toutes bases / supabase_admin : search_path="\$user", public, auth, extensions, log_statement=none ; toutes bases / supabase_auth_admin : search_path=auth, idle_in_transaction_session_timeout=60000, log_statement=none ; toutes bases / supabase_storage_admin : search_path=storage, log_statement=none ; toutes bases / supabase_read_only_user : default_transaction_read_only=on ; toutes bases / authenticator : session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; postgres / tous rôles : app.settings.jwt_secret=super-secret-jwt-token-with-at-least-32-characters-long, app.settings.jwt_exp=3600 ; toutes bases / supabase_functions_admin : search_path=supabase_functions ; toutes bases / supabase_realtime_admin : search_path=public, extensions, realtime ; toutes bases / anon : statement_timeout=3s, extra_float_digits=1 ; toutes bases / authenticated : statement_timeout=8s, extra_float_digits=1 ; toutes bases / service_role : extra_float_digits=1 |
| CONSTAT extensions installées | dblink 1.2, pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1 |
| CONSTAT déclencheurs d'événements | issue_graphql_placeholder, issue_pg_cron_access, issue_pg_graphql_access, issue_pg_net_access, pgrst_ddl_watch, pgrst_drop_watch |
| CONSTAT Q5 privilèges par défaut sur public (révoqués table par table par la migration 6) | postgres → public ({postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}) ; postgres → public ({postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}) ; postgres → public ({postgres=rwU/postgres,anon=rwU/postgres,authenticated=rwU/postgres,service_role=rwU/postgres}) ; supabase_admin → public ({postgres=rwU/supabase_admin,anon=rwU/supabase_admin,authenticated=rwU/supabase_admin,service_role=rwU/supabase_admin}) ; supabase_admin → public ({postgres=arwdDxtm/supabase_admin,anon=arwdDxtm/supabase_admin,authenticated=arwdDxtm/supabase_admin,service_role=arwdDxtm/supabase_admin}) ; supabase_admin → public ({postgres=X/supabase_admin,anon=X/supabase_admin,authenticated=X/supabase_admin,service_role=X/supabase_admin}) |
| Q5 user_settings : invisible pour anon (API REST et GraphQL) |  |
| Q5 accounts : invisible pour anon (API REST et GraphQL) |  |
| Q5 transactions : invisible pour anon (API REST et GraphQL) |  |
| Q5 attachments : invisible pour anon (API REST et GraphQL) |  |
| Q5 budgets : invisible pour anon (API REST et GraphQL) |  |
| Q5 savings_goals : invisible pour anon (API REST et GraphQL) |  |
| Q5 recurring_rules : invisible pour anon (API REST et GraphQL) |  |
| Q5 recurring_occurrences : invisible pour anon (API REST et GraphQL) |  |
| Q5 debts : invisible pour anon (API REST et GraphQL) |  |
| Q5 debt_payments : invisible pour anon (API REST et GraphQL) |  |
| Q5 categories : invisible pour anon (API REST et GraphQL) |  |
| Q5 import_batches : invisible pour anon (API REST et GraphQL) |  |
| Q5 goal_contributions : invisible pour anon (API REST et GraphQL) |  |
| Q5 assets : invisible pour anon (API REST et GraphQL) |  |
| Q5 asset_valuations : invisible pour anon (API REST et GraphQL) |  |
| Q5 exchange_rates : invisible pour anon (API REST et GraphQL) |  |
| Q5 notification_states : invisible pour anon (API REST et GraphQL) |  |
| Q5 profiles : invisible pour anon (API REST et GraphQL) |  |
| Q5 fonctions RPC dans public : apply_changeset et resolve_changeset uniquement | obtenu=apply_changeset, resolve_changeset attendu=apply_changeset, resolve_changeset |
| Q5 apply_changeset : exécutable par authenticated seulement | {nexora_writer=X/nexora_writer,authenticated=X/nexora_writer} |
| Q5 apply_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | obtenu=nexora_writer attendu=nexora_writer |
| Q5 resolve_changeset : exécutable par authenticated seulement | {nexora_writer=X/nexora_writer,authenticated=X/nexora_writer} |
| Q5 resolve_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | obtenu=nexora_writer attendu=nexora_writer |
| CONSTAT P13 rôle nexora_writer | superuser=f, bypassrls=f, login=f, inherit=f |
| CONSTAT P13 réglages des rôles de l'API (statement_timeout, lock_timeout…) | anon : statement_timeout=3s, extra_float_digits=1 ; authenticated : statement_timeout=8s, extra_float_digits=1 ; authenticator : session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; service_role : extra_float_digits=1 |

## Chaîne numérique (taux de change et d'intérêt)

* Étape 5 — réglage du serveur hérité par les sessions : `extra_float_digits = 0 (source : configuration file, fichier : /etc/postgresql/postgresql.conf)`
* Étape 5 — réglages des rôles endossés par PostgREST : anon → statement_timeout=3s, extra_float_digits=1 ; authenticated → statement_timeout=8s, extra_float_digits=1 ; authenticator → session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; service_role → extra_float_digits=1
* Étape 2 — PostgREST lit le corps JSON par `json_to_recordset` ; lecture vérifiée sur les bits par `10_api_serialization.sql`.

| Valeur | 1. JSON envoyé (bits JS) | 3. Bits stockés | 4. SQL : session / `extra_float_digits = 1` | 6. Réponse écriture / lecture (brutes) | 7. Valeur JS relue (bits) | Verdict |
|---|---|---|---|---|---|---|
| taux 0.1 + 0.2 | `{"rate":0.30000000000000004}` (`3fd3333333333334`) | `3fd3333333333334` | `0.3` / `0.30000000000000004` | `{"status":"applied","versions":[{"key":{"id":"d3ed7ebc-81fc-4e2c-96da-17c3dc18d297"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"e561eddc-b52f-4b3d-a001-db987c2b5479"}` / `[{"rate":0.30000000000000004}]` | `0.30000000000000004` (`3fd3333333333334`) | exact de bout en bout |
| taux 1/3 | `{"rate":0.3333333333333333}` (`3fd5555555555555`) | `3fd5555555555555` | `0.333333333333333` / `0.3333333333333333` | `{"status":"applied","versions":[{"key":{"id":"950dde19-2c30-4d45-b9bb-e2d4dcd56e51"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"28ed468f-c04e-444d-9c57-2a39a2ff58df"}` / `[{"rate":0.3333333333333333}]` | `0.3333333333333333` (`3fd5555555555555`) | exact de bout en bout |
| taux 10.86 | `{"rate":10.86}` (`4025b851eb851eb8`) | `4025b851eb851eb8` | `10.86` / `10.86` | `{"status":"applied","versions":[{"key":{"id":"8a15148c-515d-4534-9eec-669a20a364ba"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"e8f4ec05-70b5-488c-a00b-c75284a421f4"}` / `[{"rate":10.86}]` | `10.86` (`4025b851eb851eb8`) | exact de bout en bout |
| taux d'intérêt | `{"interest_rate":4.123456789012345}` (`40107e6b74dd1bd9`) | `40107e6b74dd1bd9` | `4.12345678901235` / `4.123456789012345` | `{"status":"applied","versions":[{"key":{"id":"ca4e7650-bc23-4880-b1c5-54230ddb895e"},"table":"debts","deleted":false,"version":2}],"changesetId":"52a2cf7e-d35a-4e43-a246-295fd84cf004"}` / `[{"interest_rate":4.123456789012345}]` | `4.123456789012345` (`40107e6b74dd1bd9`) | exact de bout en bout |

## Suite HTTP (deux utilisateurs authentifiés)

```
PASS  deux utilisateurs distincts inscrits via GoTrue
PASS  jeton JWT réel émis par GoTrue (rôle authenticated)
PASS  profil de A créé à l'inscription et seul visible par A
PASS  nom du profil repris des métadonnées d'inscription
PASS  aucun user_settings pré-créé à l'inscription
PASS  profiles : écriture directe refusée (A sur le profil de B)
PASS  profiles : écriture directe refusée même sur son propre profil
PASS  profiles : A ne renomme pas le profil de B par le protocole (unauthorized)
PASS  A : jeu complet (18 tables, références circulaires) appliqué en un lot
PASS  B : jeu complet (18 tables, références circulaires) appliqué en un lot
PASS  chaque utilisateur relit ses lignes dans les 18 tables
PASS  profil renommé par le protocole (version 2)
PASS  user_settings : B ne lit que ses propres lignes
PASS  user_settings : filtrer sur A ne renvoie rien à B
PASS  user_settings : PATCH direct refusé (lignes de A)
PASS  user_settings : PATCH direct refusé même sur ses lignes
PASS  user_settings : POST direct (insertion / upsert) refusé
PASS  user_settings : DELETE refusé (privilège)
PASS  user_settings : DELETE refusé même sur ses lignes
PASS  user_settings : B ne modifie pas la ligne de A (protocole)
PASS  user_settings : B ne supprime pas la ligne de A (protocole)
PASS  user_settings : B ne peut pas écrire au nom de A
PASS  user_settings : B ne peut pas soumettre un lot au nom de A
PASS  user_settings : B ne peut pas transférer sa ligne à A
PASS  accounts : B ne lit que ses propres lignes
PASS  accounts : filtrer sur A ne renvoie rien à B
PASS  accounts : PATCH direct refusé (lignes de A)
PASS  accounts : PATCH direct refusé même sur ses lignes
PASS  accounts : POST direct (insertion / upsert) refusé
PASS  accounts : DELETE refusé (privilège)
PASS  accounts : DELETE refusé même sur ses lignes
PASS  accounts : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  accounts : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  accounts : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  accounts : B ne peut pas écrire au nom de A
PASS  accounts : B ne peut pas soumettre un lot au nom de A
PASS  accounts : B ne peut pas transférer sa ligne à A
PASS  categories : B ne lit que ses propres lignes
PASS  categories : filtrer sur A ne renvoie rien à B
PASS  categories : PATCH direct refusé (lignes de A)
PASS  categories : PATCH direct refusé même sur ses lignes
PASS  categories : POST direct (insertion / upsert) refusé
PASS  categories : DELETE refusé (privilège)
PASS  categories : DELETE refusé même sur ses lignes
PASS  categories : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  categories : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  categories : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  categories : B ne peut pas écrire au nom de A
PASS  categories : B ne peut pas soumettre un lot au nom de A
PASS  categories : B ne peut pas transférer sa ligne à A
PASS  transactions : B ne lit que ses propres lignes
PASS  transactions : filtrer sur A ne renvoie rien à B
PASS  transactions : PATCH direct refusé (lignes de A)
PASS  transactions : PATCH direct refusé même sur ses lignes
PASS  transactions : POST direct (insertion / upsert) refusé
PASS  transactions : DELETE refusé (privilège)
PASS  transactions : DELETE refusé même sur ses lignes
PASS  transactions : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  transactions : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  transactions : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  transactions : B ne peut pas écrire au nom de A
PASS  transactions : B ne peut pas soumettre un lot au nom de A
PASS  transactions : B ne peut pas transférer sa ligne à A
PASS  attachments : B ne lit que ses propres lignes
PASS  attachments : filtrer sur A ne renvoie rien à B
PASS  attachments : PATCH direct refusé (lignes de A)
PASS  attachments : PATCH direct refusé même sur ses lignes
PASS  attachments : POST direct (insertion / upsert) refusé
PASS  attachments : DELETE refusé (privilège)
PASS  attachments : DELETE refusé même sur ses lignes
PASS  attachments : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  attachments : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  attachments : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  attachments : B ne peut pas écrire au nom de A
PASS  attachments : B ne peut pas soumettre un lot au nom de A
PASS  attachments : B ne peut pas transférer sa ligne à A
PASS  import_batches : B ne lit que ses propres lignes
PASS  import_batches : filtrer sur A ne renvoie rien à B
PASS  import_batches : PATCH direct refusé (lignes de A)
PASS  import_batches : PATCH direct refusé même sur ses lignes
PASS  import_batches : POST direct (insertion / upsert) refusé
PASS  import_batches : DELETE refusé (privilège)
PASS  import_batches : DELETE refusé même sur ses lignes
PASS  import_batches : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  import_batches : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  import_batches : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  import_batches : B ne peut pas écrire au nom de A
PASS  import_batches : B ne peut pas soumettre un lot au nom de A
PASS  import_batches : B ne peut pas transférer sa ligne à A
PASS  budgets : B ne lit que ses propres lignes
PASS  budgets : filtrer sur A ne renvoie rien à B
PASS  budgets : PATCH direct refusé (lignes de A)
PASS  budgets : PATCH direct refusé même sur ses lignes
PASS  budgets : POST direct (insertion / upsert) refusé
PASS  budgets : DELETE refusé (privilège)
PASS  budgets : DELETE refusé même sur ses lignes
PASS  budgets : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  budgets : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  budgets : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  budgets : B ne peut pas écrire au nom de A
PASS  budgets : B ne peut pas soumettre un lot au nom de A
PASS  budgets : B ne peut pas transférer sa ligne à A
PASS  savings_goals : B ne lit que ses propres lignes
PASS  savings_goals : filtrer sur A ne renvoie rien à B
PASS  savings_goals : PATCH direct refusé (lignes de A)
PASS  savings_goals : PATCH direct refusé même sur ses lignes
PASS  savings_goals : POST direct (insertion / upsert) refusé
PASS  savings_goals : DELETE refusé (privilège)
PASS  savings_goals : DELETE refusé même sur ses lignes
PASS  savings_goals : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  savings_goals : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  savings_goals : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  savings_goals : B ne peut pas écrire au nom de A
PASS  savings_goals : B ne peut pas soumettre un lot au nom de A
PASS  savings_goals : B ne peut pas transférer sa ligne à A
PASS  goal_contributions : B ne lit que ses propres lignes
PASS  goal_contributions : filtrer sur A ne renvoie rien à B
PASS  goal_contributions : PATCH direct refusé (lignes de A)
PASS  goal_contributions : PATCH direct refusé même sur ses lignes
PASS  goal_contributions : POST direct (insertion / upsert) refusé
PASS  goal_contributions : DELETE refusé (privilège)
PASS  goal_contributions : DELETE refusé même sur ses lignes
PASS  goal_contributions : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  goal_contributions : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  goal_contributions : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  goal_contributions : B ne peut pas écrire au nom de A
PASS  goal_contributions : B ne peut pas soumettre un lot au nom de A
PASS  goal_contributions : B ne peut pas transférer sa ligne à A
PASS  recurring_rules : B ne lit que ses propres lignes
PASS  recurring_rules : filtrer sur A ne renvoie rien à B
PASS  recurring_rules : PATCH direct refusé (lignes de A)
PASS  recurring_rules : PATCH direct refusé même sur ses lignes
PASS  recurring_rules : POST direct (insertion / upsert) refusé
PASS  recurring_rules : DELETE refusé (privilège)
PASS  recurring_rules : DELETE refusé même sur ses lignes
PASS  recurring_rules : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  recurring_rules : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  recurring_rules : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  recurring_rules : B ne peut pas écrire au nom de A
PASS  recurring_rules : B ne peut pas soumettre un lot au nom de A
PASS  recurring_rules : B ne peut pas transférer sa ligne à A
PASS  recurring_occurrences : B ne lit que ses propres lignes
PASS  recurring_occurrences : filtrer sur A ne renvoie rien à B
PASS  recurring_occurrences : PATCH direct refusé (lignes de A)
PASS  recurring_occurrences : PATCH direct refusé même sur ses lignes
PASS  recurring_occurrences : POST direct (insertion / upsert) refusé
PASS  recurring_occurrences : DELETE refusé (privilège)
PASS  recurring_occurrences : DELETE refusé même sur ses lignes
PASS  recurring_occurrences : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  recurring_occurrences : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  recurring_occurrences : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  recurring_occurrences : B ne peut pas écrire au nom de A
PASS  recurring_occurrences : B ne peut pas soumettre un lot au nom de A
PASS  recurring_occurrences : B ne peut pas transférer sa ligne à A
PASS  debts : B ne lit que ses propres lignes
PASS  debts : filtrer sur A ne renvoie rien à B
PASS  debts : PATCH direct refusé (lignes de A)
PASS  debts : PATCH direct refusé même sur ses lignes
PASS  debts : POST direct (insertion / upsert) refusé
PASS  debts : DELETE refusé (privilège)
PASS  debts : DELETE refusé même sur ses lignes
PASS  debts : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  debts : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  debts : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  debts : B ne peut pas écrire au nom de A
PASS  debts : B ne peut pas soumettre un lot au nom de A
PASS  debts : B ne peut pas transférer sa ligne à A
PASS  debt_payments : B ne lit que ses propres lignes
PASS  debt_payments : filtrer sur A ne renvoie rien à B
PASS  debt_payments : PATCH direct refusé (lignes de A)
PASS  debt_payments : PATCH direct refusé même sur ses lignes
PASS  debt_payments : POST direct (insertion / upsert) refusé
PASS  debt_payments : DELETE refusé (privilège)
PASS  debt_payments : DELETE refusé même sur ses lignes
PASS  debt_payments : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  debt_payments : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  debt_payments : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  debt_payments : B ne peut pas écrire au nom de A
PASS  debt_payments : B ne peut pas soumettre un lot au nom de A
PASS  debt_payments : B ne peut pas transférer sa ligne à A
PASS  assets : B ne lit que ses propres lignes
PASS  assets : filtrer sur A ne renvoie rien à B
PASS  assets : PATCH direct refusé (lignes de A)
PASS  assets : PATCH direct refusé même sur ses lignes
PASS  assets : POST direct (insertion / upsert) refusé
PASS  assets : DELETE refusé (privilège)
PASS  assets : DELETE refusé même sur ses lignes
PASS  assets : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  assets : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  assets : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  assets : B ne peut pas écrire au nom de A
PASS  assets : B ne peut pas soumettre un lot au nom de A
PASS  assets : B ne peut pas transférer sa ligne à A
PASS  asset_valuations : B ne lit que ses propres lignes
PASS  asset_valuations : filtrer sur A ne renvoie rien à B
PASS  asset_valuations : PATCH direct refusé (lignes de A)
PASS  asset_valuations : PATCH direct refusé même sur ses lignes
PASS  asset_valuations : POST direct (insertion / upsert) refusé
PASS  asset_valuations : DELETE refusé (privilège)
PASS  asset_valuations : DELETE refusé même sur ses lignes
PASS  asset_valuations : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  asset_valuations : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  asset_valuations : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  asset_valuations : B ne peut pas écrire au nom de A
PASS  asset_valuations : B ne peut pas soumettre un lot au nom de A
PASS  asset_valuations : B ne peut pas transférer sa ligne à A
PASS  exchange_rates : B ne lit que ses propres lignes
PASS  exchange_rates : filtrer sur A ne renvoie rien à B
PASS  exchange_rates : PATCH direct refusé (lignes de A)
PASS  exchange_rates : PATCH direct refusé même sur ses lignes
PASS  exchange_rates : POST direct (insertion / upsert) refusé
PASS  exchange_rates : DELETE refusé (privilège)
PASS  exchange_rates : DELETE refusé même sur ses lignes
PASS  exchange_rates : B ne modifie pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  exchange_rates : B ne supprime pas la ligne de A (protocole : conflit, aucune version révélée)
PASS  exchange_rates : B ne crée pas de ligne sur la clé d'une ligne de A (duplicate_key, aucun détail)
PASS  exchange_rates : B ne peut pas écrire au nom de A
PASS  exchange_rates : B ne peut pas soumettre un lot au nom de A
PASS  exchange_rates : B ne peut pas transférer sa ligne à A
PASS  notification_states : B ne lit que ses propres lignes
PASS  notification_states : filtrer sur A ne renvoie rien à B
PASS  notification_states : PATCH direct refusé (lignes de A)
PASS  notification_states : PATCH direct refusé même sur ses lignes
PASS  notification_states : POST direct (insertion / upsert) refusé
PASS  notification_states : DELETE refusé (privilège)
PASS  notification_states : DELETE refusé même sur ses lignes
PASS  notification_states : B ne modifie pas la ligne de A (protocole)
PASS  notification_states : B ne supprime pas la ligne de A (protocole)
PASS  notification_states : B ne peut pas écrire au nom de A
PASS  notification_states : B ne peut pas soumettre un lot au nom de A
PASS  notification_states : B ne peut pas transférer sa ligne à A
PASS  lignes de A strictement inchangées après les tentatives de B (18 tables, versions comprises)
PASS  aucune tentative refusée de B n'a modifié ses propres lignes
PASS  transactions : B ne peut pas référencer compte de A (clé composite)
PASS  transactions : B ne peut pas référencer catégorie de A (clé composite)
PASS  transactions : B ne peut pas référencer dette de A (clé composite)
PASS  goal_contributions : B ne peut pas référencer objectif de A (clé composite)
PASS  asset_valuations : B ne peut pas référencer actif de A (clé composite)
PASS  recurring_occurrences : B ne peut pas référencer règle récurrente de A (clé composite)
PASS  contrôle positif : B référence sa propre catégorie
PASS  Q6 référence pendante : erreur différée (23503) renvoyée à la validation
PASS  dette ↔ transaction en deux lots séparés : le premier est refusé (un lot = une transaction)
PASS  dette ↔ transaction dans le MÊME lot : appliqué (écriture multi-tables atomique)
PASS  unicité différée (budget en double) renvoyée par PostgREST
PASS  atomicité : lot refusé (invalid_row, CHECK 23514, opération désignée)
PASS  atomicité : l'opération valide du lot refusé n'a pas été écrite
PASS  API : métadonnée serveur version envoyée par le client → lot refusé
PASS  API : métadonnée serveur sync_txid envoyée par le client → lot refusé
PASS  API : métadonnée serveur server_updated_at envoyée par le client → lot refusé
PASS  API : métadonnée serveur deleted_at envoyée par le client → lot refusé
PASS  API : création confirmée en version 1
PASS  API : version imposée par le serveur
PASS  API : sync_txid et server_updated_at imposés par le serveur
PASS  API : created_at métier du client conservé à la milliseconde
PASS  API : suppression logique confirmée (version + 1, supprimée)
PASS  API : ligne supprimée logiquement, horodatée par le serveur, toujours lisible par son propriétaire
PASS  API : réécriture d'une ligne supprimée = réactivation (version + 1)
PASS  API : ligne réactivée (deleted_at null)
PASS  R3 : première écriture acceptée (version 1 → 2)
PASS  R3 : seconde écriture sur la version périmée refusée (version_conflict, version réelle indiquée)
PASS  R3 : l'écriture acceptée n'est pas écrasée
PASS  R3 : deux requêtes simultanées sur la même version → exactement une acceptée, une en conflit
PASS  R3 : une seule des deux écritures simultanées est enregistrée (version 3)
PASS  idempotence : le même lot rejoué renvoie le résultat d'origine (replayed), sans nouvelle version
PASS  idempotence : le lot rejoué n'a été appliqué qu'une fois
PASS  idempotence : même identifiant, autre contenu → changeset_id_reused
PASS  résolution : lot appliqué → résultat d'origine (replayed)
PASS  résolution : l'identifiant de lot de B est inconnu pour A (périmètre utilisateur, aucune fuite)
PASS  résolution : lot inconnu → abandonné
PASS  résolution : un lot abandonné n'est jamais appliqué ensuite
PASS  API taux 0.1 + 0.2 : écriture par lot appliquée
PASS  API taux 0.1 + 0.2 : valeur relue identique (0.30000000000000004)
PASS  API taux 1/3 : écriture par lot appliquée
PASS  API taux 1/3 : valeur relue identique (0.3333333333333333)
PASS  API taux 10.86 : écriture par lot appliquée
PASS  API taux 10.86 : valeur relue identique (10.86)
PASS  API taux d'intérêt : écriture par lot appliquée
PASS  API taux d'intérêt : valeur relue identique (4.123456789012345)
PASS  limites : lot de 1 000 opérations appliqué par l'API
PASS  CONSTAT durée d'un lot de 1 000 opérations par l'API
PASS  CONSTAT lot de 5 000 opérations (taille maximale) par l'API
PASS  limites : lot de 5 000 opérations appliqué en entier ou refusé en entier
PASS  limites : lecture possible après les gros lots
PASS  limites : plus de 5 000 opérations → changeset_too_large (HTTP 413)
PASS  limites : lot de plus de 4 Mio refusé
PASS  CONSTAT refus d'un lot de plus de 4 Mio (fonction : 413 changeset_too_large ; sinon limite de la passerelle)
PASS  limites : rien n'est écrit par un lot trop volumineux
PASS  anon (clé publique sans session) : lecture refusée
PASS  anon : écriture directe refusée
PASS  anon : apply_changeset refusé (privilège)
PASS  anon : resolve_changeset refusé (privilège)
PASS  fonction privée handle_new_user non exposée par l'API
PASS  fonction privée tg_sync_metadata non exposée par l'API
PASS  fonction privée request_uid non exposée par l'API
PASS  fonction privée changeset_error non exposée par l'API
PASS  jeton modifié (sub remplacé, signature invalide) : lecture refusée
PASS  jeton modifié (sub remplacé, signature invalide) : écriture refusée
PASS  GraphQL (anon) : aucune table NEXORA exposée
PASS  GraphQL (B) : uniquement ses propres comptes
PASS  GraphQL (B) : aucune mutation d'écriture directe sur les tables
PASS  CONSTAT mutations GraphQL exposées à un utilisateur authentifié
PASS  fin de suite : lignes de A strictement inchangées (18 tables, versions comprises)
Bilan HTTP : 302 assertions, 0 échec(s)
```
