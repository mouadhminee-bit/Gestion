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
| Référence (`baseline/pg16.json`, régénérée) | PostgreSQL 16.15 | standard | 1 093 | 0 | — |
| PG 17 | PostgreSQL 17.11 | standard | 1 093 | 0 | **0** |
| PG 16 et PG 17, `extra_float_digits = 0` (condition de la pile Supabase) | 16.15 / 17.11 | standard | 1 093 | 0 | **0** |
| PG 17 « supabase-like », `postgres` avec `BYPASSRLS` | PostgreSQL 17.11 | `postgres` non superutilisateur, extensions créées par `supabase_admin`, SCRAM, 1re connexion candidate volontairement injoignable | 1 135 (dont 42 contrôles plateforme `P1`) | 0 | **0** (+ 42 en plus, attendus) |
| PG 16 « supabase-like », `postgres` avec `BYPASSRLS` | PostgreSQL 16.15 | idem | 1 135 | 0 | **0** (+ 42) |
| PG 17 / 16 « supabase-like », `postgres` **sans** `BYPASSRLS` | — | idem | — | — | **arrêt** : voir § 4 |

### Comparaison détaillée PG 16 → PG 17 (profil standard)

| | Référence | Cible |
|---|---|---|
| Version PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) | 17.11 |
| Assertions | 1093 | 1093 |
| Échecs | 0 | 0 |

Identiques : **1093** · manquantes : **0** · en plus : **0** · régressions : **0**

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

*Mise à jour : la 2e exécution dans Codespaces a montré que `postgres` dispose de `BYPASSRLS`
sur la pile locale (Q1 positive) : l'inscription fonctionne, P10 est résolu pour cette
configuration.*

## 5. Écarts PG 16 / PG 17 de la 2e exécution Codespaces : `0.1 + 0.2` et taux d'intérêt

**Observation** (pile Supabase locale, PostgreSQL 17.11) : `0.3` au lieu de
`0.30000000000000004`, et `4.12345678901235` au lieu de `4.123456789012345`.

**Analyse** (clusters éphémères PG 16.15 et PG 17.11, valeurs vérifiées indépendamment en Python) :

| Valeur | Bits IEEE-754 (`float8send`) PG 16 = PG 17 | Texte, `extra_float_digits = 1` (défaut) | Texte, `extra_float_digits = 0` | Relu depuis le texte à 0 |
|---|---|---|---|---|
| `0.30000000000000004` (`0.1 + 0.2`, calculé ou saisi) | `3fd3333333333334` | `0.30000000000000004` | `0.3` | **autre valeur** (`3fd3333333333333`) |
| `4.123456789012345` | `40107e6b74dd1bd9` | `4.123456789012345` | `4.12345678901235` | **autre valeur** |

* **Stockage** : bits identiques sur PG 16 et PG 17 — aucune perte.
* **Calcul** : `0.1::float8 + 0.2::float8` donne les mêmes bits sur les deux versions.
* **Sérialisation** : avec `extra_float_digits = 0`, PostgreSQL affiche 15 chiffres
  significatifs (`%.15g`) ; c'est **exactement** le texte observé. Reproduit à l'identique en
  local : `EXTRA_FLOAT_DIGITS=0 bash scripts/db-test.sh` (anciens tests) → les deux mêmes
  échecs, mêmes valeurs. La pile Supabase applique donc `extra_float_digits = 0` à la session
  des tests ; l'origine précise (fichier, base ou rôle) est désormais consignée par `P1`.
* Les anciens tests comparaient `valeur::text` : ils mesuraient la **sérialisation de la
  session**, pas la précision stockée. La différence est une différence de représentation.

**Attention** : cette représentation n'est pas anodine. À 15 chiffres, le texte ne se relit
pas à l'identique (`'0.3'::float8 ≠ 0.30000000000000004`), et `to_jsonb` hérite du réglage.
Un client qui lirait les taux en texte ou en JSON dans une session réglée à 0 recevrait des
valeurs arrondies. D'où le contrôle ajouté côté API (ci-dessous).

**Adaptation des tests** (aucune migration, aucun type, aucune règle métier modifiés) :

| Contrôle | Avant | Après |
|---|---|---|
| Précision stockée | `valeur::text = '0.30000000000000004'` (dépend de la session) | **bits relus = constante IEEE-754 attendue** (`float8send`), pour `0.1 + 0.2`, `1/3`, `10.86`, `4.123456789012345` ; les deux assertions historiques gardent leur nom et deviennent binaires |
| Représentation | — | sous `extra_float_digits = 1` fixé explicitement : texte = forme la plus courte, **relu à l'identique**, et `to_jsonb` relu à l'identique |
| Réglage de la session | — | `CONSTAT` (valeur et source) ; `P1` : origine (fichier, `pg_db_role_setting`) |
| API (PostgREST) | — | `rls.mjs` : 8 assertions **strictes** (`===`, donc mêmes bits) sur les valeurs renvoyées à l'écriture et relues, avec le texte brut de la réponse consigné |

**Strictness conservée** (mutation, copie jetable, `extra_float_digits = 0`) : `rate` en `real`
→ 13 échecs (bits `3fd3333340000000` au lieu de `3fd3333333333334`) ; `interest_rate` en
`numeric(6,3)` → 5 échecs. Une perte réelle reste détectée, quel que soit le réglage de session.

## 6. Arrondi des taux dans les réponses de l'API (3e exécution Codespaces : 6 échecs HTTP)

**Observation** : `0.30000000000000004 → 0.3`, `0.3333333333333333 → 0.333333333333333`,
`4.123456789012345 → 4.12345678901235` dans les réponses PostgREST ; `10.86` exact.

**Origine** (code source public consulté, aucune connexion à Supabase) : l'image PostgreSQL de
Supabase fixe `extra_float_digits = 0` dans `postgresql.conf`
(`supabase/postgres`, `ansible/files/postgresql_config/postgresql.conf.j2`, ligne 675).
PostgREST ne modifie pas ce réglage ; ses sessions en héritent.

**Chaîne numérique** (sources PostgREST `Query/SqlFragment.hs`, `Query/PreQuery.hs`,
`Config/Database.hs`, et `10_api_serialization.sql`) :

| Étape | Mécanisme | Résultat |
|---|---|---|
| 1. JSON envoyé par JavaScript | `JSON.stringify` : forme la plus courte (`0.30000000000000004`) | exact |
| 2. Lecture par PostgREST | corps transmis en JSON, converti par `json_to_recordset` (lecture du nombre indépendante de `extra_float_digits`) | **exact** (bits vérifiés sous réglage 0) |
| 3. Stockage | `double precision` | **exact** (`float8send` = constante IEEE-754) |
| 4. Relecture SQL | texte selon le réglage de la session | `0.3` à 0 (affichage), exact à 1 |
| 5. Session de l'API | hérite de `extra_float_digits = 0` (fichier de configuration) | — |
| 6. Réponse JSON brute | `json_agg` convertit chaque `float8` en texte avec le réglage de la session | **PERTE : 15 chiffres** |
| 7. Valeur JavaScript | relit fidèlement le texte arrondi | valeur différente (`3fd3333333333333`) |

La perte a lieu **à la sérialisation de la réponse** (étape 6), jamais à l'écriture ni au
stockage. `10.86` passe car il est exact sur 15 chiffres.

**Correction** : 7e migration `20261101000700_api_float_serialization.sql` (les six autres
inchangées) — `alter role anon / authenticated / service_role set extra_float_digits = 1`.
PostgREST applique à chaque requête les réglages du rôle endossé, en paramètres locaux à la
transaction ; Supabase utilise ce mécanisme pour `statement_timeout`, et accorde à `postgres`
l'option ADMIN sur ces rôles (PostgreSQL ≥ 16). Aucun type, aucune valeur, aucun calcul
modifiés ; seule la représentation texte des flottants dans les réponses de l'API devient
exacte (forme la plus courte, relue à l'identique). Sans effet hors Supabase (1 = défaut).

**Validation locale** (émulation fidèle de la séquence PostgREST, profil « supabase-like » avec
`extra_float_digits = 0` dans `postgresql.conf`, PG 16.15 et 17.11) : avec la migration 7, les
réponses JSON se relisent bit à bit ; **sans** elle (mutation), exactement les trois valeurs
observées échouent et `10.86` passe — même signature que les 6 échecs HTTP de Codespaces.

**Validation finale requise** : la suite HTTP sur la vraie pile (143 assertions) et la chaîne
numérique complète, produites par `npm run qualify:supabase` (rapport § « Chaîne numérique »).

## 7. Résultat final sur la pile Supabase locale (exécution Codespaces de clôture)

| Contrôle | Résultat |
|---|---|
| SQL (PostgreSQL 17.11, suites 01–10 + P1) | 1 152 / 1 152 |
| Comparaison avec la référence PostgreSQL 16 | 1 106 identiques, 0 régression |
| HTTP (GoTrue + PostgREST, deux utilisateurs authentifiés) | 143 / 143 |
| Précision des taux par l'API | 8 / 8 — la migration 7 rend la réponse JSON exacte |
| Nettoyage | 0 conteneur, 0 volume |

Résultats communiqués ; fichiers bruts non versionnés (`docs/LOT3B_CLOTURE.md` § 4.1).
P10 et P11 : clos (`docs/SUIVI_TECHNIQUE.md`, « Points clos »).
