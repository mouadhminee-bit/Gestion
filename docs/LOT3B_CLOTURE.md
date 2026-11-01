# NEXORA — Clôture formelle de l'étape 3b (qualification sur la pile Supabase locale)

*Clôture du 01/11/2026 sur `claude/stoic-edison-8s0vhq`, commit `ea45a41`. Aucune étape du
Lot 4 n'est engagée.*

## 1. Décision

**L'étape 3b est close : le schéma NEXORA (7 migrations) est qualifié sur la pile Supabase
locale complète** (PostgreSQL 17.11, GoTrue, PostgREST, Kong), avec deux utilisateurs
réellement authentifiés, sans régression par rapport à PostgreSQL 16.

La qualification sur un **projet Supabase hébergé** (3b-4) reste **reportée** et hors
périmètre de cette clôture.

## 2. État du dépôt (vérifié)

| Élément | État |
|---|---|
| Branche de travail | `claude/stoic-edison-8s0vhq`, `HEAD` = `ea45a41`, identique au dépôt distant |
| Production (`claude/nexora-finance-platform-81blaa`) | `5fd37c3`, **inchangée** depuis le début de la session |
| `nexora-dev` | `341f3da`, **inchangée** |
| `src/` | **aucune modification** depuis la validation du Lot 2 (`d1c789e`) ; aucun fichier `src/` touché par l'étape 3b |
| `netlify.toml`, `package-lock.json` | inchangés ; aucun déploiement déclenché |
| Base IndexedDB `nexora` (Edge) | jamais ouverte : tests sur fake-indexeddb, clusters PostgreSQL éphémères et pile Supabase locale jetable, données fictives (`@example.test`) uniquement |
| Projet Supabase hébergé | aucun créé, aucune connexion distante |

## 3. Migrations

| Migration | Lignes | Empreinte SHA-256 (16 premiers caractères) | État |
|---|---|---|---|
| `20261101000100_conventions.sql` | 54 | `187f8c5d6c83ce0a` | validée Lot 3, **identique** au commit `46b83b4` |
| `20261101000200_profiles_settings.sql` | 50 | `7bd6926f59165fbd` | idem |
| `20261101000300_core_tables.sql` | 352 | `be23a37551c092e4` | idem |
| `20261101000400_relations.sql` | 149 | `db238e97eda8ab5c` | idem |
| `20261101000500_triggers.sql` | 69 | `348d3f49f7155239` | idem |
| `20261101000600_rls_grants.sql` | 53 | `50e1aa1f1ba2d934` | idem |
| `20261101000700_api_float_serialization.sql` | 28 | `b21d26dc7291c629` | **ajoutée en 3b** : `alter role anon / authenticated / service_role set extra_float_digits = 1` + rechargement de PostgREST |

La migration 7 ne modifie ni table, ni type, ni donnée, ni règle métier : elle fixe la
représentation texte des `double precision` dans les sessions de l'API.

## 4. Preuves

### 4.1 Pile Supabase locale (Codespaces, exécution finale)

Résultats communiqués par le responsable de la qualification :

| Contrôle | Résultat |
|---|---|
| Serveur | PostgreSQL 17.11 (image Supabase) |
| Migrations | 7/7 appliquées par le CLI Supabase |
| Assertions SQL (suites 01–10 + contrôles plateforme P1) | **1 152 / 1 152** |
| Comparaison avec la référence PostgreSQL 16 | **1 106 identiques**, 0 manquante, 0 régression |
| Suite HTTP (GoTrue + PostgREST, deux utilisateurs authentifiés) | **143 / 143** |
| Isolation | 18 tables couvertes |
| Précision numérique par l'API | **8 / 8** (0.1 + 0.2, 1/3, 10.86, 4.123456789012345 ; écriture et relecture, égalité stricte) |
| Destruction | 0 conteneur, 0 volume restants |

⚠ Les fichiers bruts de cette exécution (`docs/qualification/3b-local-report.md`,
`3b-local-sql.json`, `3b-local-http.json`) **ne sont pas versionnés** dans le dépôt. La
clôture repose sur les résultats communiqués et sur les preuves locales ci-dessous. Pour une
traçabilité complète, il est recommandé de les pousser (commandes au § 5 de
`docs/LOT3B_QUALIFICATION.md`) — non bloquant.

### 4.2 Preuves reproductibles dans le dépôt

| Preuve | Où |
|---|---|
| Référence PostgreSQL 16 (1 106 assertions) | `supabase/db-tests/baseline/pg16.json` |
| PostgreSQL 17.11 local, identique à la référence | `docs/qualification/3b-pg17-local.json`, `.md` |
| Cause de l'échec dblink reproduite puis corrigée (profil « supabase-like ») | `docs/qualification/3b-pg17-local.md` § 1, § 3 |
| Écarts de représentation des flottants (SQL) reproduits avec `extra_float_digits = 0` | idem § 5 |
| Arrondi par l'API : origine (`postgresql.conf` de l'image Supabase), chaîne numérique, correction, **mutation sans migration 7 = mêmes 3 valeurs en échec** | idem § 6 ; `supabase/db-tests/10_api_serialization.sql` |
| Exécution de clôture locale | `npm run check` 314/314 + build ; `npm run test:db` 1 106/1 106 ; profil supabase-like 1 152/1 152 |

## 5. Questions de qualification (Q1–Q6)

| # | Question | Réponse |
|---|---|---|
| Q1 | Le rôle `postgres` contourne-t-il la RLS forcée ? | **Oui** sur la pile locale (`BYPASSRLS`) : inscription fonctionnelle |
| Q2 | Déclencheur sur `auth.users` accepté ? | **Oui** (migrations appliquées, profil créé à l'inscription) |
| Q3 | Création directe d'utilisateurs fictifs en SQL ? | **Oui** |
| Q4 | `dblink` disponible ? | **Oui**, dans un schéma dédié inaccessible aux rôles applicatifs, via `dblink_connect` uniquement |
| Q5 | Privilèges par défaut, GraphQL, RPC maîtrisés ? | **Oui** (contrôles plateforme et HTTP) |
| Q6 | Erreurs différées (`23503`, `23P01`) renvoyées par PostgREST ? | **Oui** (suite HTTP) |

## 6. Points clos

| # | Point | Preuve de clôture |
|---|---|---|
| P10 | Inscription impossible si `postgres` n'a pas `BYPASSRLS` | Q1 positive sur la pile locale ; création du profil vérifiée par la suite HTTP (143/143). **Clos pour la pile locale** ; la vérification sur un projet hébergé est rattachée à P9 |
| P11 | Arrondi des `double precision` dans les réponses de l'API | Origine démontrée (image Supabase, `extra_float_digits = 0`) ; perte localisée à la sérialisation de la réponse ; correction par la migration 7 ; 8/8 contrôles stricts et 143/143 sur la vraie pile ; mutation confirmant la causalité. **Clos** |
| Écarts PG 16 / 17 (`0.3`, `4.12345678901235`) | Différence de représentation, bits identiques | **Clos** (tests fondés sur `float8send`) |
| Échec `dblink_connect_u` | Outillage de test | **Clos** (schéma dédié, aucun privilège pour les rôles applicatifs) |

## 7. Ce qui reste hors périmètre ou ouvert

**Réserves (inchangées, bloquantes pour la mise en production du cloud)** : R1 (remappage des
identifiants à la restauration), R2 (atomicité `saveAsset` + valorisation initiale), R3
(concurrence entre appareils : contrôle de version au Lot 4, récupération au Lot 5).

**Points ouverts** : P1 à P8 (inchangés, voir `docs/SUIVI_TECHNIQUE.md`) ; **P9** partiellement
clos — pile locale qualifiée, **projet hébergé (3b-4) reporté**.

**Hors périmètre de l'étape 3b** : écriture applicative (`apply_changeset`, Lot 4),
synchronisation réelle (Lot 5), authentification dans l'application (Lot 6), Storage et
pièces jointes (Lot 7), purge et CI (Lot 8), migration des données Edge.

## 8. Limites de la qualification locale

1. **Pile locale ≠ plateforme hébergée.** Configuration serveur, restrictions `supautils`
   (rôles réservés), versions exactes de PostgREST / GoTrue, pooler Supavisor, réseau et TLS
   peuvent différer. En particulier, `alter role … set` sur `anon` / `authenticated` (migration
   7) et l'attribut `BYPASSRLS` de `postgres` (Q1) **doivent être revérifiés** sur un projet
   hébergé.
2. **Authentification simplifiée** : confirmation d'e-mail désactivée, clés locales par
   défaut ; politiques de mots de passe, limites de débit et signature des jetons de la
   plateforme non testées.
3. **Concurrence** : prouvée au niveau base (sessions concurrentes, 300 étapes aléatoires),
   pas via l'API sous charge ; aucune mesure de performance de la RLS sur gros volumes.
4. **Données** : uniquement fictives ; compatibilité des données Edge existantes non testée
   (P3).
5. **Écriture applicative absente** : les écritures HTTP testées sont des requêtes PostgREST
   unitaires ; l'atomicité multi-tables côté serveur relève du Lot 4.
6. **Traçabilité** : résultats Codespaces finaux communiqués, fichiers bruts non versionnés
   (§ 4.1) ; aucune CI ne rejoue automatiquement la qualification.
7. **PostgreSQL 17 local** : binaires d'un paquet npm (`@embedded-postgres`, version bêta de
   l'empaquetage) ; la référence de version reste celle de l'image Supabase.
