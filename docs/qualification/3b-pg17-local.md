# NEXORA — étape 3b-2 : qualification PostgreSQL 17 (locale, éphémère)

*Mise à jour du 01/11/2026 après la 1re exécution dans Codespaces (correction dblink). Clusters
temporaires dans `/tmp` (socket Unix uniquement), détruits après chaque exécution ; binaires
PostgreSQL 17.11 du paquet npm `@embedded-postgres/linux-x64@17.11.0-beta.19`, supprimés
ensuite. Aucune connexion à Supabase. Données fictives uniquement.*

## 1. Échec de la 1re exécution dans Codespaces : `permission denied for function dblink_connect_u`

**Cause.** L'erreur ne venait pas des connexions des tests de synchronisation (elles
n'utilisent que `dblink_connect`), mais de l'outillage `_setup.sql` :

1. l'extension `dblink` était installée **dans le schéma `tests`** ;
2. `_setup.sql` exécutait ensuite `grant execute on all functions in schema tests to anon, authenticated`,
   qui visait donc aussi les fonctions de dblink ;
3. sur Supabase, les extensions sont créées par le superutilisateur (`supabase_admin`, via
   supautils) : `postgres` n'en possède pas les fonctions ; et `dblink_connect_u` est
   révoquée de `PUBLIC` par le script de l'extension. `postgres` n'ayant aucun privilège sur
   elle, le `GRANT` échoue (sur `dblink_connect`, il n'émet qu'un avertissement).

En local, `postgres` était superutilisateur : le problème était masqué. Il cachait aussi un
**défaut de conception** : en local, ce `GRANT` donnait à `anon` et `authenticated` le droit
d'exécuter les fonctions dblink (base jetable, mais privilège excessif sur des rôles
applicatifs).

**Reproduction locale** : profil « supabase-like » (§ 3) avec l'ancien `_setup.sql` → même
erreur, même ligne (`_setup.sql:116`).

**Correction** (outillage de test uniquement ; les 6 migrations sont **inchangées**) :

| Avant | Après |
|---|---|
| dblink dans le schéma `tests`, ouvert à `anon` / `authenticated` | dblink dans un schéma dédié **`tests_dblink`**, `revoke all … from public`, **aucun accès** pour `anon` / `authenticated` ; accès accordé au seul rôle administrateur des tests, et seulement s'il n'est pas l'utilisateur de session |
| `grant execute on all functions in schema tests` incluait dblink | le schéma `tests` ne contient plus que les fonctions d'aide (aucune fonction de l'extension, vérifié) |
| appels directs `tests.dblink_*` | enveloppes `tests.db_connect / db_exec / db_value / db_disconnect` : schéma de l'extension résolu dynamiquement, **`dblink_connect` avec chaîne de connexion explicite** et identifiants locaux de test ; `dblink_connect_u` jamais utilisée |
| une seule chaîne de connexion | liste ordonnée de candidates (`|`) : boucle locale, puis adresse du conteneur de la base. Pour un non-superutilisateur, `dblink_connect` exige une connexion **réellement** authentifiée par mot de passe, ce que la boucle locale « trust » d'une pile Supabase pourrait ne pas fournir |

Les scénarios de concurrence, les assertions et les données de test sont **inchangés** (seuls
les appels dblink de `07_sync.sql` passent par les enveloppes). Nouvelle suite
`09_harness_security.sql` (15 assertions) : schéma dédié, aucun accès `anon` /
`authenticated` (privilèges **et** tentatives réelles refusées), `dblink_connect_u`
inexécutable par `anon`, `authenticated`, `service_role`, aucune fonction `SECURITY DEFINER`
dans l'outillage.

## 2. Résultats

| Exécution | Serveur | Profil | Assertions | Échecs | Écarts vs référence PG 16 |
|---|---|---|---|---|---|
| Référence (`baseline/pg16.json`, régénérée) | PostgreSQL 16.15 | standard | 1 072 | 0 | — |
| PG 17 | PostgreSQL 17.11 | standard | 1 072 | 0 | **0** |
| PG 17 « supabase-like », `postgres` avec `BYPASSRLS` | PostgreSQL 17.11 | `postgres` non superutilisateur, extensions créées par `supabase_admin`, SCRAM, 1re connexion candidate volontairement injoignable | 1 112 (dont 40 contrôles plateforme `P1`) | 0 | **0** (+ 40 en plus, attendus) |
| PG 16 « supabase-like », `postgres` avec `BYPASSRLS` | PostgreSQL 16.15 | idem | 1 112 | 0 | **0** (+ 40) |
| PG 17 / 16 « supabase-like », `postgres` **sans** `BYPASSRLS` | — | idem | — | — | **arrêt** : voir § 4 |

### Comparaison détaillée PG 16 → PG 17 (profil standard)

| | Référence | Cible |
|---|---|---|
| Version PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | 17.11 |
| Assertions | 1072 | 1072 |
| Échecs | 0 | 0 |

Identiques : **1072** · manquantes : **0** · en plus : **0** · régressions : **0**

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
| 09_harness_security.sql | 15 | 0 |

Aucun écart.

Résultats bruts : `docs/qualification/3b-pg17-local.json`.

## 3. Profil local « supabase-like » (nouveau)

`PG_PROFILE=supabase-like bash scripts/db-test.sh` reproduit la répartition des privilèges
de Supabase qui a fait échouer la 1re exécution : superutilisateur `supabase_admin` ;
`postgres` **non superutilisateur**, propriétaire de la base, applique les migrations ;
dblink créé par le superutilisateur ; rôle `authenticator` ; privilèges par défaut de
Supabase sur `public`. Ce profil exécute aussi `platform/P1_supabase_platform.sql`.
Fichier d'émulation : `supabase/db-tests/shim/supabase_like.sql` (jamais appliqué à Supabase).

## 4. Constat nouveau (hors dblink) : inscription si `postgres` ne contourne pas la RLS

Dans le profil « supabase-like » **sans** `BYPASSRLS`, la première création d'utilisateur
échoue : `new row violates row-level security policy for table "profiles"`. Le déclencheur
d'inscription `private.handle_new_user` est `SECURITY DEFINER` et appartient à `postgres` ;
la RLS étant **forcée** sur `profiles` et aucune politique ne visant `postgres`, l'insertion
du profil est refusée. Conséquence possible sur Supabase : **inscription impossible**.

Tout dépend de la question Q1 (attribut `BYPASSRLS` du rôle `postgres` de Supabase), que
l'exécution dans Codespaces tranchera (contrôle `CONSTAT Q1` du rapport). **Les migrations ne
sont pas modifiées à ce stade** ; si Q1 est négative, une correction ciblée vous sera
proposée avant toute modification (par exemple une politique d'insertion limitée au
propriétaire de la fonction d'inscription).
