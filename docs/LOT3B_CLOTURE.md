# NEXORA — Conclusion formelle de l'étape 3b (qualification sur la pile Supabase locale)

*Version consolidée du 01/11/2026 sur `claude/stoic-edison-8s0vhq`. Remplace la version du
commit `0d9efbc`. Aucune étape du Lot 4 n'est engagée.*

## 1. Décision

**L'étape 3b est close.** Le schéma NEXORA (7 migrations) est qualifié sur la **pile
Supabase locale** complète, avec deux utilisateurs réellement authentifiés et sans régression
par rapport à PostgreSQL 16. La validation sur un **projet Supabase hébergé** n'a **pas** été
réalisée (3b-4 reportée).

## 2. Périmètre validé

| Domaine | Validé sur | Résultat |
|---|---|---|
| Application des 7 migrations | pile Supabase locale (CLI), PostgreSQL 16.15 et 17.11 éphémères | 7 / 7 |
| Schéma, contraintes, compatibilité avec le domaine TypeScript | PG 16.15, PG 17.11, pile locale | 1 106 assertions identiques PG 16 / PG 17 |
| RLS, isolation (18 tables, 25 clés composites), privilèges, rôles `anon` / `authenticated` | pile locale (SQL + HTTP) | SQL 1 152 / 1 152 ; HTTP 143 / 143 |
| Authentification réelle (GoTrue) et API (PostgREST) avec deux utilisateurs | pile locale | 143 / 143 |
| Contraintes différées et erreurs renvoyées par l'API (`23503`, `23P01`) | pile locale | conformes |
| Déclencheurs et métadonnées serveur | PG 16 / 17, pile locale | conformes |
| Synchronisation (`sync_txid`, borne `pg_snapshot_xmin`, sessions concurrentes) | PG 16 / 17, pile locale | 16 / 16 (dont 300 étapes aléatoires) |
| Précision des taux de change et d'intérêt par l'API | pile locale, après migration 7 | 8 / 8 exacts |
| Nettoyage de l'environnement | Codespaces | 0 conteneur, 0 volume |
| Non-régression applicative | conteneur de session | `npm run check` 314 / 314, build réussi |

Questions de qualification : Q1 à Q6 **positives** sur la pile locale (`postgres` contourne
la RLS forcée ; déclencheur sur `auth.users` accepté ; utilisateurs fictifs créés en SQL ;
`dblink` disponible dans un schéma dédié ; privilèges, GraphQL et RPC maîtrisés ; erreurs
différées renvoyées par PostgREST).

## 3. Preuves conservées

| Preuve | Statut |
|---|---|
| `docs/qualification/3b-pg17-local.json` / `.md` (PG 17 local, analyses dblink, flottants, chaîne numérique) | **versionnées** |
| `supabase/db-tests/baseline/pg16.json` (référence PG 16, 1 106 assertions) | versionnée |
| Suites et outillage (`supabase/db-tests/`, `scripts/db-test.sh`, `scripts/qualify-supabase.sh`) permettant de rejouer la qualification | versionnés |
| `docs/qualification/3b-local-report.md`, `3b-local-sql.json`, `3b-local-http.json` (exécution Codespaces finale) | **non versionnées à ce jour** : présentes uniquement dans le Codespace. À contrôler par `node scripts/check-qualification-evidence.mjs` (secrets, données personnelles, URL non locales, cohérence), puis à ajouter — procédure : `docs/LOT3B_QUALIFICATION.md` § 5 |

Tant que ces trois fichiers ne sont pas versionnés, les résultats Codespaces finaux (SQL
1 152/1 152, HTTP 143/143, précision 8/8, PG 16/17 1 106 identiques, 7 migrations, nettoyage
complet) reposent sur le compte rendu du responsable de la qualification ; les preuves
locales reproductibles ci-dessus les corroborent.

## 4. Points P9, P10, P11

| # | Statut |
|---|---|
| P9 | **Ouvert** — qualification sur la pile Supabase locale réussie ; **validation sur un projet hébergé non réalisée** |
| P10 | **Ouvert** — résolu pour la pile locale testée (`postgres` a `BYPASSRLS`, inscription fonctionnelle) ; **vérification sur un projet hébergé à faire** |
| P11 | **Clos pour la pile locale** — 143/143 HTTP et 8/8 contrôles de précision après la migration 7 ; l'application des réglages de rôle sur un projet hébergé est à vérifier avec P9 |

## 5. Réserves R1, R2, R3

**Aucune n'est levée.**

* **R1** — remappage des identifiants à la restauration de sauvegarde : Lot 7.
* **R2** — atomicité de `saveAsset` et de la valorisation initiale : fiabilisation, avant la
  mise en production cloud.
* **R3** — concurrence entre plusieurs appareils : le Lot 3 n'a posé que `version` et les
  métadonnées de synchronisation. **Le contrôle de version optimiste n'est pas réalisé** :
  il relève du Lot 4 (`apply_changeset`), la récupération des changements du Lot 5.

## 6. Hors périmètre

Projet Supabase hébergé (3b-4) ; connexion de l'application à Supabase ; authentification
dans l'application (Lot 6) ; écriture applicative atomique `apply_changeset` et contrôle
optimiste (Lot 4) ; synchronisation réelle (Lot 5) ; Storage et pièces jointes (Lot 7) ;
purge des suppressions logiques et CI (Lot 8) ; migration des données Edge ; toute
modification de `src/`, des données IndexedDB, de la production ou de `nexora-dev`.

## 7. Limites de la qualification locale

1. **Pile locale ≠ plateforme hébergée** : configuration serveur, restrictions `supautils`
   sur les rôles réservés, versions exactes de PostgREST / GoTrue, pooler Supavisor, réseau et
   TLS peuvent différer ; `BYPASSRLS` de `postgres` et les réglages de rôle de la migration 7
   y sont à revérifier.
2. **Authentification simplifiée** : confirmation d'e-mail désactivée, clés locales par
   défaut ; politiques de mots de passe, limites de débit et clés de signature de la
   plateforme non testées.
3. **Concurrence** : prouvée au niveau base, pas via l'API sous charge ; aucune mesure de
   performance de la RLS sur gros volumes.
4. **Données fictives uniquement** ; compatibilité des données Edge existantes non testée
   (P3).
5. **Écritures** : requêtes PostgREST unitaires ; aucune écriture multi-tables atomique
   côté serveur (Lot 4).
6. **Traçabilité** : rapports Codespaces finaux non versionnés (§ 3) ; aucune CI.
7. **PostgreSQL 17 local** : binaires d'un paquet npm (empaquetage bêta) ; la référence de
   version reste l'image Supabase.

## 8. Conditions préalables aux lots suivants

| Avant | Condition |
|---|---|
| **Lot 4** (`apply_changeset`, contrôle optimiste) | Décision explicite de lancement ; archivage des trois rapports Codespaces (§ 3) recommandé ; correspondance TypeScript ↔ SQL de `users` / `meta` à définir (P2) ; tests de conflit à deux clients prévus pour R3 ; le schéma des 7 migrations sert de base (toute modification d'une migration validée exige une anomalie démontrée et une approbation) |
| **Lot 5** (synchronisation) | Lot 4 validé ; P1 et P8 traités dans la conception |
| **Lot 6** (authentification dans l'application) | P9 et P10 vérifiés sur un projet hébergé de **développement** (3b-4) |
| **Mise en production du cloud** | R1, R2, R3 levées ; P9, P10 clos sur l'hébergé ; P3 traité avant toute migration des données Edge ; projet de production distinct du développement |

## 9. État du dépôt à la clôture

| Élément | État |
|---|---|
| Branche | `claude/stoic-edison-8s0vhq` |
| Production `claude/nexora-finance-platform-81blaa` | `5fd37c3`, inchangée |
| `nexora-dev` | `341f3da`, inchangée |
| `src/` | inchangé depuis la validation du Lot 2 (`d1c789e`) |
| Six migrations du Lot 3 | identiques au commit `46b83b4` |
| Migration 7 | `20261101000700_api_float_serialization.sql`, inchangée depuis `ea45a41` |
| Base IndexedDB Edge, projet hébergé, Netlify | non touchés |
