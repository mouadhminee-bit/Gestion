# NEXORA — étape 3b : résultats bruts de la qualification sur la pile Supabase locale

*Généré par `scripts/qualify-supabase.sh local` le 2026-11-01T01:02:12Z (UTC). Données fictives uniquement ; jetons et clés masqués.*

| Élément | Valeur |
|---|---|
| Serveur | `PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit` |
| CLI Supabase | `2.122.0` |
| Migrations appliquées | `20261101000100 20261101000200 20261101000300 20261101000400 20261101000500 20261101000600 20261101000700` |
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
| Assertions | 1106 | 1152 |
| Échecs | 0 | 0 |

Identiques : **1106** · manquantes : **0** · en plus : **46** · régressions : **0**

| Fichier | Réussies | Échecs |
|---|---|---|
| 01_catalog.sql | 556 | 0 |
| 02_isolation.sql | 297 | 0 |
| 03_triggers.sql | 20 | 0 |
| 04_constraints.sql | 122 | 0 |
| 05_relations.sql | 7 | 0 |
| 06_soft_delete.sql | 16 | 0 |
| 07_sync.sql | 16 | 0 |
| 08_lifecycle.sql | 44 | 0 |
| 09_harness_security.sql | 15 | 0 |
| 10_api_serialization.sql | 17 | 0 |
| P1_supabase_platform.sql | 42 | 0 |

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
| en plus | P1_supabase_platform.sql :: Q5 aucune fonction RPC dans public | ok |

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
| Q5 aucune fonction RPC dans public |  |

## Chaîne numérique (taux de change et d'intérêt)

* Étape 5 — réglage du serveur hérité par les sessions : `extra_float_digits = 0 (source : configuration file, fichier : /etc/postgresql/postgresql.conf)`
* Étape 5 — réglages des rôles endossés par PostgREST : anon → statement_timeout=3s, extra_float_digits=1 ; authenticated → statement_timeout=8s, extra_float_digits=1 ; authenticator → session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; service_role → extra_float_digits=1
* Étape 2 — PostgREST lit le corps JSON par `json_to_recordset` ; lecture vérifiée sur les bits par `10_api_serialization.sql`.

| Valeur | 1. JSON envoyé (bits JS) | 3. Bits stockés | 4. SQL : session / `extra_float_digits = 1` | 6. Réponse écriture / lecture (brutes) | 7. Valeur JS relue (bits) | Verdict |
|---|---|---|---|---|---|---|
| taux 0.1 + 0.2 | `{"rate":0.30000000000000004}` (`3fd3333333333334`) | `3fd3333333333334` | `0.3` / `0.30000000000000004` | `[{"id":"ed67d881-1d02-470a-abd2-77790c2e7fee","user_id":"f8dca7b4-f22a-4ca5-bae4-ffed190bcc6c","base":"USD","quote":"MAD","rate":0.30000000000000004,"date":"2026-03-02","source":"manual","created_at":"2026-10-31T12:00:00+00:00","version":1,"sync_txid":"1653","server_updated_at":"2026-11-01T01:02:11.150652+00:00","deleted_at":null}]` / `[{"rate":0.30000000000000004}]` | `0.30000000000000004` (`3fd3333333333334`) | exact de bout en bout |
| taux 1/3 | `{"rate":0.3333333333333333}` (`3fd5555555555555`) | `3fd5555555555555` | `0.333333333333333` / `0.3333333333333333` | `[{"id":"a707a6d3-a41d-4758-9784-2b988c30e444","user_id":"f8dca7b4-f22a-4ca5-bae4-ffed190bcc6c","base":"USD","quote":"MAD","rate":0.3333333333333333,"date":"2026-03-02","source":"manual","created_at":"2026-10-31T12:00:00+00:00","version":1,"sync_txid":"1654","server_updated_at":"2026-11-01T01:02:11.162616+00:00","deleted_at":null}]` / `[{"rate":0.3333333333333333}]` | `0.3333333333333333` (`3fd5555555555555`) | exact de bout en bout |
| taux 10.86 | `{"rate":10.86}` (`4025b851eb851eb8`) | `4025b851eb851eb8` | `10.86` / `10.86` | `[{"id":"59bbc258-fb31-4311-bcac-747f964d2533","user_id":"f8dca7b4-f22a-4ca5-bae4-ffed190bcc6c","base":"USD","quote":"MAD","rate":10.86,"date":"2026-03-02","source":"manual","created_at":"2026-10-31T12:00:00+00:00","version":1,"sync_txid":"1655","server_updated_at":"2026-11-01T01:02:11.170536+00:00","deleted_at":null}]` / `[{"rate":10.86}]` | `10.86` (`4025b851eb851eb8`) | exact de bout en bout |
| taux d'intérêt | `{"interest_rate":4.123456789012345}` (`40107e6b74dd1bd9`) | `40107e6b74dd1bd9` | `4.12345678901235` / `4.123456789012345` | `[{"id":"ed329c2b-2ef7-4f62-a2b1-33c84e14bdcb","user_id":"f8dca7b4-f22a-4ca5-bae4-ffed190bcc6c","label":"Crédit","type":"loan","direction":"payable","principal":1000000,"currency":"MAD","start_date":"2026-03-01","due_date":null,"counterparty":null,"interest_rate":4.123456789012345,"installment_amount":null,"installment_frequency":null,"status":"active","notes":null,"origin_transaction_id":"07608997-fc91-46dd-811f-a61daf8a4eef","created_at":"2026-10-31T12:00:00+00:00","updated_at":"2026-10-31T12:00:00+00:00","version":3,"sync_txid":"1656","server_updated_at":"2026-11-01T01:02:11.180449+00:00","deleted_at":null}]` / `[{"interest_rate":4.123456789012345}]` | `4.123456789012345` (`40107e6b74dd1bd9`) | exact de bout en bout |

## Suite HTTP (deux utilisateurs authentifiés)

```
PASS  deux utilisateurs distincts inscrits via GoTrue
PASS  jeton JWT réel émis par GoTrue (rôle authenticated)
PASS  profil de A créé à l'inscription et seul visible par A
PASS  nom du profil repris des métadonnées d'inscription
PASS  aucun user_settings pré-créé à l'inscription
PASS  A ne peut pas renommer le profil de B
PASS  jeu de données complet créé par chaque utilisateur via l'API (18 tables)
PASS  user_settings : B ne lit que ses propres lignes
PASS  user_settings : filtrer sur A ne renvoie rien à B
PASS  user_settings : B ne modifie aucune ligne de A
PASS  user_settings : DELETE refusé (privilège)
PASS  user_settings : DELETE refusé même sur ses lignes
PASS  user_settings : B ne peut pas transférer ses lignes à A
PASS  accounts : B ne lit que ses propres lignes
PASS  accounts : filtrer sur A ne renvoie rien à B
PASS  accounts : B ne modifie aucune ligne de A
PASS  accounts : DELETE refusé (privilège)
PASS  accounts : DELETE refusé même sur ses lignes
PASS  accounts : B ne peut pas transférer ses lignes à A
PASS  categories : B ne lit que ses propres lignes
PASS  categories : filtrer sur A ne renvoie rien à B
PASS  categories : B ne modifie aucune ligne de A
PASS  categories : DELETE refusé (privilège)
PASS  categories : DELETE refusé même sur ses lignes
PASS  categories : B ne peut pas transférer ses lignes à A
PASS  import_batches : B ne lit que ses propres lignes
PASS  import_batches : filtrer sur A ne renvoie rien à B
PASS  import_batches : B ne modifie aucune ligne de A
PASS  import_batches : DELETE refusé (privilège)
PASS  import_batches : DELETE refusé même sur ses lignes
PASS  import_batches : B ne peut pas transférer ses lignes à A
PASS  transactions : B ne lit que ses propres lignes
PASS  transactions : filtrer sur A ne renvoie rien à B
PASS  transactions : B ne modifie aucune ligne de A
PASS  transactions : DELETE refusé (privilège)
PASS  transactions : DELETE refusé même sur ses lignes
PASS  transactions : B ne peut pas transférer ses lignes à A
PASS  attachments : B ne lit que ses propres lignes
PASS  attachments : filtrer sur A ne renvoie rien à B
PASS  attachments : B ne modifie aucune ligne de A
PASS  attachments : DELETE refusé (privilège)
PASS  attachments : DELETE refusé même sur ses lignes
PASS  attachments : B ne peut pas transférer ses lignes à A
PASS  budgets : B ne lit que ses propres lignes
PASS  budgets : filtrer sur A ne renvoie rien à B
PASS  budgets : B ne modifie aucune ligne de A
PASS  budgets : DELETE refusé (privilège)
PASS  budgets : DELETE refusé même sur ses lignes
PASS  budgets : B ne peut pas transférer ses lignes à A
PASS  savings_goals : B ne lit que ses propres lignes
PASS  savings_goals : filtrer sur A ne renvoie rien à B
PASS  savings_goals : B ne modifie aucune ligne de A
PASS  savings_goals : DELETE refusé (privilège)
PASS  savings_goals : DELETE refusé même sur ses lignes
PASS  savings_goals : B ne peut pas transférer ses lignes à A
PASS  goal_contributions : B ne lit que ses propres lignes
PASS  goal_contributions : filtrer sur A ne renvoie rien à B
PASS  goal_contributions : B ne modifie aucune ligne de A
PASS  goal_contributions : DELETE refusé (privilège)
PASS  goal_contributions : DELETE refusé même sur ses lignes
PASS  goal_contributions : B ne peut pas transférer ses lignes à A
PASS  recurring_rules : B ne lit que ses propres lignes
PASS  recurring_rules : filtrer sur A ne renvoie rien à B
PASS  recurring_rules : B ne modifie aucune ligne de A
PASS  recurring_rules : DELETE refusé (privilège)
PASS  recurring_rules : DELETE refusé même sur ses lignes
PASS  recurring_rules : B ne peut pas transférer ses lignes à A
PASS  recurring_occurrences : B ne lit que ses propres lignes
PASS  recurring_occurrences : filtrer sur A ne renvoie rien à B
PASS  recurring_occurrences : B ne modifie aucune ligne de A
PASS  recurring_occurrences : DELETE refusé (privilège)
PASS  recurring_occurrences : DELETE refusé même sur ses lignes
PASS  recurring_occurrences : B ne peut pas transférer ses lignes à A
PASS  debts : B ne lit que ses propres lignes
PASS  debts : filtrer sur A ne renvoie rien à B
PASS  debts : B ne modifie aucune ligne de A
PASS  debts : DELETE refusé (privilège)
PASS  debts : DELETE refusé même sur ses lignes
PASS  debts : B ne peut pas transférer ses lignes à A
PASS  debt_payments : B ne lit que ses propres lignes
PASS  debt_payments : filtrer sur A ne renvoie rien à B
PASS  debt_payments : B ne modifie aucune ligne de A
PASS  debt_payments : DELETE refusé (privilège)
PASS  debt_payments : DELETE refusé même sur ses lignes
PASS  debt_payments : B ne peut pas transférer ses lignes à A
PASS  assets : B ne lit que ses propres lignes
PASS  assets : filtrer sur A ne renvoie rien à B
PASS  assets : B ne modifie aucune ligne de A
PASS  assets : DELETE refusé (privilège)
PASS  assets : DELETE refusé même sur ses lignes
PASS  assets : B ne peut pas transférer ses lignes à A
PASS  asset_valuations : B ne lit que ses propres lignes
PASS  asset_valuations : filtrer sur A ne renvoie rien à B
PASS  asset_valuations : B ne modifie aucune ligne de A
PASS  asset_valuations : DELETE refusé (privilège)
PASS  asset_valuations : DELETE refusé même sur ses lignes
PASS  asset_valuations : B ne peut pas transférer ses lignes à A
PASS  exchange_rates : B ne lit que ses propres lignes
PASS  exchange_rates : filtrer sur A ne renvoie rien à B
PASS  exchange_rates : B ne modifie aucune ligne de A
PASS  exchange_rates : DELETE refusé (privilège)
PASS  exchange_rates : DELETE refusé même sur ses lignes
PASS  exchange_rates : B ne peut pas transférer ses lignes à A
PASS  notification_states : B ne lit que ses propres lignes
PASS  notification_states : filtrer sur A ne renvoie rien à B
PASS  notification_states : B ne modifie aucune ligne de A
PASS  notification_states : DELETE refusé (privilège)
PASS  notification_states : DELETE refusé même sur ses lignes
PASS  notification_states : B ne peut pas transférer ses lignes à A
PASS  lignes de A intactes après les tentatives de B
PASS  B ne peut pas insérer une ligne au nom de A (RLS with check)
PASS  upsert de B sur l'identifiant d'un compte de A : refusé
PASS  compte de A inchangé après l'upsert de B
PASS  transactions : B ne peut pas référencer compte de A (clé composite)
PASS  transactions : B ne peut pas référencer catégorie de A (clé composite)
PASS  transactions : B ne peut pas référencer dette de A (clé composite)
PASS  goal_contributions : B ne peut pas référencer objectif de A (clé composite)
PASS  asset_valuations : B ne peut pas référencer actif de A (clé composite)
PASS  recurring_occurrences : B ne peut pas référencer règle récurrente de A (clé composite)
PASS  contrôle positif : B référence sa propre catégorie
PASS  Q6 référence pendante : erreur différée (23503) renvoyée à la validation
PASS  dette ↔ transaction en deux requêtes séparées : la première est refusée (chaque requête est une transaction)
PASS  unicité différée (budget en double) renvoyée par PostgREST
PASS  API : version imposée par le serveur (999 ignoré)
PASS  API : sync_txid et server_updated_at imposés par le serveur
PASS  API : created_at métier du client conservé à la milliseconde
PASS  API : suppression logique horodatée par le serveur, version + 1
PASS  API : ligne supprimée logiquement toujours lisible par son propriétaire
PASS  API taux 0.1 + 0.2 : valeur renvoyée à l'écriture identique (0.30000000000000004)
PASS  API taux 0.1 + 0.2 : valeur relue identique (0.30000000000000004)
PASS  API taux 1/3 : valeur renvoyée à l'écriture identique (0.3333333333333333)
PASS  API taux 1/3 : valeur relue identique (0.3333333333333333)
PASS  API taux 10.86 : valeur renvoyée à l'écriture identique (10.86)
PASS  API taux 10.86 : valeur relue identique (10.86)
PASS  API taux d'intérêt : valeur renvoyée identique (4.123456789012345)
PASS  API taux d'intérêt : valeur relue identique (4.123456789012345)
PASS  anon (clé publique sans session) : lecture refusée
PASS  anon : écriture refusée
PASS  fonction privée handle_new_user non exposée par l'API
PASS  fonction privée tg_sync_metadata non exposée par l'API
PASS  jeton modifié (sub remplacé, signature invalide) : refusé
PASS  GraphQL (anon) : aucune table NEXORA exposée
PASS  GraphQL (B) : uniquement ses propres comptes
Bilan HTTP : 143 assertions, 0 échec(s)
```
