# NEXORA — résultats bruts de la qualification sur la pile Supabase locale (v42-local)

*Généré par `scripts/qualify-supabase.sh local` le 2026-11-24T22:53:34Z (UTC). Données fictives uniquement ; jetons et clés masqués.*

| Élément | Valeur |
|---|---|
| Environnement | GitHub Codespaces |
| Commit testé | `f2a5fe6ad15273daaa61d349884abfe73f568b3d` (25 fichier(s) modifié(s) ou non suivi(s) au lancement) |
| Empreinte des migrations | `385ced586c63efd2dcad180adacb23970c0e266472e5c1459928eee3f6260802` |
| Registre d'images | défaut du CLI Supabase |
| Serveur | `PostgreSQL 17.11 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 15.2.0, 64-bit` |
| CLI Supabase | `2.122.0` |
| Migrations appliquées | `20261101000100 20261101000200 20261101000300 20261101000400 20261101000500 20261101000600 20261101000700 20261101000800 20261101000900` |
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
| Assertions | 1793 | 1905 |
| Échecs | 0 | 0 |

Identiques : **1776** · manquantes : **17** (dont déclarées : **17**) · en plus : **129** · régressions : **0**

Écarts déclarés : **17** (`supabase/db-tests/baseline/pg16-declared-deltas.json`). Ils ne sont **pas** requalifiés sur PostgreSQL 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1), pas plus que les 129 assertions « en plus » : celles-ci ne sont qualifiées que sur la cible (PostgreSQL 17.11).

| Fichier | Réussies | Échecs |
|---|---|---|
| 01_catalog.sql | 809 | 0 |
| 02_isolation.sql | 402 | 0 |
| 03_triggers.sql | 34 | 0 |
| 04_constraints.sql | 122 | 0 |
| 05_relations.sql | 10 | 0 |
| 06_soft_delete.sql | 28 | 0 |
| 07_sync.sql | 16 | 0 |
| 08_lifecycle.sql | 83 | 0 |
| 09_harness_security.sql | 15 | 0 |
| 10_api_serialization.sql | 17 | 0 |
| 11_apply_changeset.sql | 266 | 0 |
| 12_pull_changes.sql | 51 | 0 |
| P1_supabase_platform.sql | 52 | 0 |

| Écart | Assertion | Détail |
|---|---|---|
| écart déclaré (non requalifié) | 01_catalog.sql :: fonctions de public : exactement apply_changeset et resolve_changeset (aucun autre appel RPC exposé) | remplacée par « 01_catalog.sql :: fonctions de public : exactement apply_changeset, pull_changes et resolve_changeset (aucun autre appel RPC exposé) » : Migration 9 (V4.1, M9) : troisième fonction publique autorisée, pull_changes ; inventaire exact étendu (décision de validation des gardes-fous du catalogue, 22/11/2026). |
| écart déclaré (non requalifié) | 07_sync.sql :: S1 ordre inversé : la ligne de la transaction en cours n'est pas visible | remplacée par « 07_sync.sql :: M9 S1 ordre inversé : la ligne de la transaction en cours n'est pas visible » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S1 ordre inversé : la borne reste ≤ à la transaction en cours ; la ligne validée APRÈS elle est différée | remplacée par « 07_sync.sql :: M9 S1 ordre inversé : la borne reste ≤ à la transaction en cours ; la ligne validée APRÈS elle est différée » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S1 ordre inversé : après validation, la récupération suivante renvoie A1 et A2 (aucune perte) | remplacée par « 07_sync.sql :: M9 S1 ordre inversé : après validation, la récupération suivante renvoie A1 et A2 (aucune perte) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S1 contrôle négatif : un curseur sur l'horodatage aurait PERDU A1 (justifie sync_txid) | remplacée par « 07_sync.sql :: M9 S1 contrôle négatif : un curseur sur l'horodatage aurait PERDU A1 (justifie sync_txid) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S1b démarrage ≠ première écriture : B1 et B2 récupérées | remplacée par « 07_sync.sql :: M9 S1b démarrage ≠ première écriture : B1 et B2 récupérées » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S2 annulation : la ligne insérée par la transaction annulée n'apparaît jamais | remplacée par « 07_sync.sql :: M9 S2 annulation : la ligne insérée par la transaction annulée n'apparaît jamais » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S2 annulation : la modification annulée n'apparaît jamais | remplacée par « 07_sync.sql :: M9 S2 annulation : la modification annulée n'apparaît jamais » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S2 annulation : le curseur avance après l'annulation (pas de blocage) | remplacée par « 07_sync.sql :: M9 S2 annulation : le curseur avance après l'annulation (pas de blocage) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S3 modifications successives : pendant la transaction en cours, le client a la dernière version VALIDÉE (v3) | remplacée par « 07_sync.sql :: M9 S3 modifications successives : pendant la transaction en cours, le client a la dernière version VALIDÉE (v3) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S3 modifications successives : état final v5 et version identique au serveur | remplacée par « 07_sync.sql :: M9 S3 modifications successives : état final v5 et version identique au serveur » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S4 suppression logique : la suppression est récupérée (tombstone) | remplacée par « 07_sync.sql :: M9 S4 suppression logique : la suppression est récupérée (tombstone) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S4 restauration : la réactivation est récupérée | remplacée par « 07_sync.sql :: M9 S4 restauration : la réactivation est récupérée » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S5 récupération complète depuis 0 = état du serveur | remplacée par « 07_sync.sql :: M9 S5 récupération complète depuis 0 = état du serveur » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S5 cache incrémental = état du serveur après actualisations successives du curseur | remplacée par « 07_sync.sql :: M9 S5 cache incrémental = état du serveur après actualisations successives du curseur » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: S6 entrelacements aléatoires : cache = serveur (216 écritures, 72 validations, 15 annulations, 143 récupérations) | remplacée par « 07_sync.sql :: M9 S6 entrelacements aléatoires : cache = serveur (216 écritures, 72 validations, 15 annulations, 143 récupérations) » : Même scénario, exécuté contre la vraie fonction public.pull_changes (migration 9, rôle authenticated, RLS, pages de 3) au lieu du prototype tests.pull ; renommée « M9 » pour ne pas être comptée identique à la référence PostgreSQL 16. |
| écart déclaré (non requalifié) | 07_sync.sql :: récupération sous l'identité de A pour l'utilisateur B : aucune ligne (RLS) | remplacée par « 07_sync.sql :: M9 récupération sous l'identité de A : aucune ligne de l'utilisateur B (RLS) » : Vraie fonction public.pull_changes (sans paramètre utilisateur, identité du jeton) au lieu du prototype tests.pull(uid, curseur). |
| en plus (sans référence) | 01_catalog.sql :: fonctions de public : exactement apply_changeset, pull_changes et resolve_changeset (aucun autre appel RPC exposé) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S1 ordre inversé : la ligne de la transaction en cours n'est pas visible | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S1 ordre inversé : la borne reste ≤ à la transaction en cours ; la ligne validée APRÈS elle est différée | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S1 ordre inversé : après validation, la récupération suivante renvoie A1 et A2 (aucune perte) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S1 contrôle négatif : un curseur sur l'horodatage aurait PERDU A1 (justifie sync_txid) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S1b démarrage ≠ première écriture : B1 et B2 récupérées | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S2 annulation : la ligne insérée par la transaction annulée n'apparaît jamais | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S2 annulation : la modification annulée n'apparaît jamais | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S2 annulation : le curseur avance après l'annulation (pas de blocage) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S3 modifications successives : pendant la transaction en cours, le client a la dernière version VALIDÉE (v3) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S3 modifications successives : état final v5 et version identique au serveur | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S4 suppression logique : la suppression est récupérée (tombstone) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S4 restauration : la réactivation est récupérée | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S5 récupération complète depuis 0 = état du serveur | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S5 cache incrémental = état du serveur après actualisations successives du curseur | ok |
| en plus (sans référence) | 07_sync.sql :: M9 S6 entrelacements aléatoires : cache = serveur (216 écritures, 72 validations, 15 annulations, 143 récupérations) | ok |
| en plus (sans référence) | 07_sync.sql :: M9 récupération sous l'identité de A : aucune ligne de l'utilisateur B (RLS) | ok |
| en plus (sans référence) | 08_lifecycle.sql :: public.pull_changes : search_path fixé | ok |
| en plus (sans référence) | 08_lifecycle.sql :: public.pull_changes : non exécutable par anon | ok |
| en plus (sans référence) | 08_lifecycle.sql :: public.pull_changes : aucun droit PUBLIC | ok |
| en plus (sans référence) | 08_lifecycle.sql :: public.pull_changes : exécutable par authenticated seulement | ok |
| en plus (sans référence) | 08_lifecycle.sql :: public.pull_changes : propriétaire nexora_writer sans superutilisateur, sans BYPASSRLS, sans connexion | ok |
| en plus (sans référence) | 10_api_serialization.sql :: CONSTAT taux 0.1 + 0.2 sans réglage de rôle (session à 0) | ok |
| en plus (sans référence) | 10_api_serialization.sql :: CONSTAT taux 1/3 sans réglage de rôle (session à 0) | ok |
| en plus (sans référence) | 10_api_serialization.sql :: CONSTAT taux 10.86 sans réglage de rôle (session à 0) | ok |
| en plus (sans référence) | 10_api_serialization.sql :: CONSTAT taux d'intérêt 4.123456789012345 sans réglage de rôle (session à 0) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : signature exacte | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : renvoie jsonb | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : SECURITY INVOKER (droits de l'appelant, RLS appliquée) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : STABLE (lecture seule) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : search_path vide fixé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : propriétaire nexora_writer | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : exécutable par authenticated | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : non exécutable par anon | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : non exécutable par service_role | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : aucun droit PUBLIC | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pull_changes : corps sans accès au schéma private ni écriture (insert / update) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: anon : exécution refusée | ok |
| en plus (sans référence) | 12_pull_changes.sql :: authenticated sans utilisateur (sub absent) : refus PT403 | ok |
| en plus (sans référence) | 12_pull_changes.sql :: borne renvoyée en texte décimal (xid8) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_cursor nul : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_cursor négatif : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_cursor non numérique : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_cursor de plus de 20 chiffres : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_bound non numérique : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_bound postérieure à la borne sûre : refusée | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_cursor supérieur à la borne : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_after sans p_bound : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_after non objet : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_after avec un champ inconnu : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_after.txid non textuel : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_after hors de l'intervalle : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_limit = 0 : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_limit = 1001 : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: p_limit nul : refusé | ok |
| en plus (sans référence) | 12_pull_changes.sql :: récupération complète : les 18 tables sont couvertes | ok |
| en plus (sans référence) | 12_pull_changes.sql :: récupération complète : toutes les lignes appartiennent à l'utilisateur | ok |
| en plus (sans référence) | 12_pull_changes.sql :: sync_txid transmis en texte, toujours < borne | ok |
| en plus (sans référence) | 12_pull_changes.sql :: chaque ligne porte ses métadonnées serveur (version, deleted_at, server_updated_at) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: clé SQL de chaque ligne conforme à la liste blanche de la migration 8 | ok |
| en plus (sans référence) | 12_pull_changes.sql :: ordre strict (sync_txid, table, clé) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: récupération complète = lecture directe sous la RLS, table par table (lignes supprimées comprises) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: isolation : A et B récupèrent chacun leurs propres lignes | ok |
| en plus (sans référence) | 12_pull_changes.sql :: isolation : aucune ligne de B dans la récupération de A | ok |
| en plus (sans référence) | 12_pull_changes.sql :: isolation : aucune ligne de A dans la récupération de B | ok |
| en plus (sans référence) | 12_pull_changes.sql :: suppression logique : la ligne supprimée est récupérée (deleted_at renseigné) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: réactivation : la ligne réactivée est récupérée | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pagination : les 2 500 lignes nouvelles sont récupérées | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pagination : 3 pages de 1 000 lignes au plus | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pagination : aucune ligne en double entre les pages | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pagination : ordre strict (sync_txid, table, clé) d'une page à l'autre, y compris à sync_txid égal | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pendant la pagination : une ligne insérée n'apparaît pas dans l'intervalle en cours (sync_txid ≥ borne) | ok |
| en plus (sans référence) | 12_pull_changes.sql :: pendant la pagination : une ligne modifiée avant d'être renvoyée sort de l'intervalle en cours | ok |
| en plus (sans référence) | 12_pull_changes.sql :: récupération suivante : ligne insérée, ligne modifiée en cours de pagination et ligne déjà renvoyée puis modifiée, chacune dans sa dernière version | ok |
| en plus (sans référence) | 12_pull_changes.sql :: aucune perte : cache modèle (version la plus haute par clé) = état validé du serveur, 18 tables | ok |
| en plus (sans référence) | 12_pull_changes.sql :: lecture seule : aucune version ni sync_txid modifié par les récupérations | ok |
| en plus (sans référence) | 12_pull_changes.sql :: récupération sans changement : aucune ligne, une seule page, next nul | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT version du serveur | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: rôle anon présent | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: rôle authenticated présent | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: rôle service_role présent | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: rôle authenticator présent | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: anon : pas de connexion directe | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: authenticated : pas de connexion directe | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: anon : soumis à la RLS | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: authenticated : soumis à la RLS | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: service_role : contourne la RLS (clé serveur uniquement) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: authenticator (PostgREST) peut endosser anon | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: authenticator (PostgREST) peut endosser authenticated | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT Q1 rôle postgres et RLS forcée | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT propriétaire des tables | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q2 déclencheur on_auth_user_created présent sur auth.users | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q3 utilisateurs fictifs créés directement dans auth.users | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: base de qualification : aucun utilisateur autre que les comptes fictifs | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q4 dblink disponible (suite de synchronisation exécutée) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT extra_float_digits de la session d'administration | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT réglages par base / par rôle (pg_db_role_setting) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT extensions installées | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT déclencheurs d'événements | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT Q5 privilèges par défaut sur public (révoqués table par table par la migration 6) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 user_settings : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 accounts : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 transactions : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 attachments : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 budgets : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 savings_goals : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 recurring_rules : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 recurring_occurrences : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 debts : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 debt_payments : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 categories : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 import_batches : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 goal_contributions : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 assets : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 asset_valuations : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 exchange_rates : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 notification_states : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 profiles : invisible pour anon (API REST et GraphQL) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 fonctions RPC dans public : apply_changeset, pull_changes et resolve_changeset uniquement | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 apply_changeset : exécutable par authenticated seulement | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 apply_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 resolve_changeset : exécutable par authenticated seulement | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 resolve_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 pull_changes : exécutable par authenticated seulement | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: Q5 pull_changes : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT P13 rôle nexora_writer | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: P13 nexora_writer : ni superutilisateur, ni BYPASSRLS, ni connexion | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: P13 ni authenticator, ni authenticated, ni anon ne sont membres de nexora_writer | ok |
| en plus (sans référence) | P1_supabase_platform.sql :: CONSTAT P13 réglages des rôles de l'API (statement_timeout, lock_timeout…) | ok |

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
| Q5 fonctions RPC dans public : apply_changeset, pull_changes et resolve_changeset uniquement | obtenu=apply_changeset, pull_changes, resolve_changeset attendu=apply_changeset, pull_changes, resolve_changeset |
| Q5 apply_changeset : exécutable par authenticated seulement | {nexora_writer=X/nexora_writer,authenticated=X/nexora_writer} |
| Q5 apply_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | obtenu=nexora_writer attendu=nexora_writer |
| Q5 resolve_changeset : exécutable par authenticated seulement | {nexora_writer=X/nexora_writer,authenticated=X/nexora_writer} |
| Q5 resolve_changeset : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | obtenu=nexora_writer attendu=nexora_writer |
| Q5 pull_changes : exécutable par authenticated seulement | {nexora_writer=X/nexora_writer,authenticated=X/nexora_writer} |
| Q5 pull_changes : propriétaire nexora_writer (rôle créé par la migration sur cette plateforme) | obtenu=nexora_writer attendu=nexora_writer |
| CONSTAT P13 rôle nexora_writer | superuser=f, bypassrls=f, login=f, inherit=f |
| CONSTAT P13 réglages des rôles de l'API (statement_timeout, lock_timeout…) | anon : statement_timeout=3s, extra_float_digits=1 ; authenticated : statement_timeout=8s, extra_float_digits=1 ; authenticator : session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; service_role : extra_float_digits=1 |

## Chaîne numérique (taux de change et d'intérêt)

* Étape 5 — réglage du serveur hérité par les sessions : `extra_float_digits = 0 (source : configuration file, fichier : /etc/postgresql/postgresql.conf)`
* Étape 5 — réglages des rôles endossés par PostgREST : anon → statement_timeout=3s, extra_float_digits=1 ; authenticated → statement_timeout=8s, extra_float_digits=1 ; authenticator → session_preload_libraries=supautils, safeupdate, statement_timeout=8s, lock_timeout=8s ; service_role → extra_float_digits=1
* Étape 2 — PostgREST lit le corps JSON par `json_to_recordset` ; lecture vérifiée sur les bits par `10_api_serialization.sql`.

| Valeur | 1. JSON envoyé (bits JS) | 3. Bits stockés | 4. SQL : session / `extra_float_digits = 1` | 6. Réponse écriture / lecture (brutes) | 7. Valeur JS relue (bits) | Verdict |
|---|---|---|---|---|---|---|
| taux 0.1 + 0.2 | `{"rate":0.30000000000000004}` (`3fd3333333333334`) | `3fd3333333333334` | `0.3` / `0.30000000000000004` | `{"status":"applied","versions":[{"key":{"id":"8c9f0305-7455-47fd-8f4a-34b35e8415b5"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"582c2a5b-e684-44f7-85e5-bbffadce39e4"}` / `[{"rate":0.30000000000000004}]` | `0.30000000000000004` (`3fd3333333333334`) | exact de bout en bout |
| taux 1/3 | `{"rate":0.3333333333333333}` (`3fd5555555555555`) | `3fd5555555555555` | `0.333333333333333` / `0.3333333333333333` | `{"status":"applied","versions":[{"key":{"id":"b71f4bec-d73e-4db5-9efd-63f77a42b93c"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"5e49a0d9-ba98-4fb4-ab2e-d99e1a5c4413"}` / `[{"rate":0.3333333333333333}]` | `0.3333333333333333` (`3fd5555555555555`) | exact de bout en bout |
| taux 10.86 | `{"rate":10.86}` (`4025b851eb851eb8`) | `4025b851eb851eb8` | `10.86` / `10.86` | `{"status":"applied","versions":[{"key":{"id":"adb55815-5dcd-4d63-8dd6-8d26f812a578"},"table":"exchange_rates","deleted":false,"version":1}],"changesetId":"51def818-a388-4122-a703-bf1015fbffb5"}` / `[{"rate":10.86}]` | `10.86` (`4025b851eb851eb8`) | exact de bout en bout |
| taux d'intérêt | `{"interest_rate":4.123456789012345}` (`40107e6b74dd1bd9`) | `40107e6b74dd1bd9` | `4.12345678901235` / `4.123456789012345` | `{"status":"applied","versions":[{"key":{"id":"476f5bee-4724-475f-a5a1-475926959d79"},"table":"debts","deleted":false,"version":2}],"changesetId":"adc16cd4-0252-468e-b899-1e641763e450"}` / `[{"interest_rate":4.123456789012345}]` | `4.123456789012345` (`40107e6b74dd1bd9`) | exact de bout en bout |

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
PASS  M9 A : borne renvoyée en texte (xid8)
PASS  M9 A : les 18 tables récupérées
PASS  M9 A : uniquement ses propres lignes (aucune de B)
PASS  M9 A : sync_txid en texte, toujours < borne
PASS  M9 A : récupération = lecture REST, table par table
PASS  M9 A : ordre strict (sync_txid, table, clé)
PASS  M9 B : uniquement ses propres lignes (aucune de A)
PASS  M9 A : valeurs récupérées identiques à la lecture REST (18 tables, toutes colonnes)
PASS  M9 B : valeurs récupérées identiques à la lecture REST (18 tables, toutes colonnes)
PASS  M9 B : flottants exacts dans pull_changes (0.1 + 0.2, 1/3, 10.86)
PASS  M9 B : taux d'intérêt exact dans pull_changes (4.123456789012345)
PASS  M9 B : pagination par 97 (plusieurs pages, borne constante)
PASS  M9 B : pages de 97 = pages de 1 000 (mêmes lignes, même ordre, aucune en double)
PASS  M9 B : lot de changements (création + suppression) appliqué
PASS  M9 B : récupération incrémentale = exactement la création et la suppression (deleted_at renseigné)
PASS  M9 B : la borne ne recule pas
PASS  M9 A : les changements de B n'apparaissent pas dans la récupération de A
PASS  M9 anon : pull_changes refusé (privilège)
PASS  M9 jeton modifié (sub remplacé, signature invalide) : récupération refusée
PASS  M9 curseur invalide : 400 invalid_pull
PASS  M9 limite > 1 000 : 400 invalid_pull
PASS  M9 borne future : 400 invalid_pull
PASS  fin de suite : lignes de A strictement inchangées (18 tables, versions comprises)
Bilan HTTP : 324 assertions, 0 échec(s)
```
