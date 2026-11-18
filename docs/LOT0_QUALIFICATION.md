# NEXORA — Lot 0 : finalisation et qualification du socle backend

*État au 14/11/2026 sur `claude/stoic-edison-8s0vhq`, à partir du commit `6bc7f44`.
Correspond aux étapes 4.5 et 4.6 de `docs/LOT4_PLAN.md`. Modifications NON commitées à la
rédaction : leur validation appartient au responsable du projet. Mis à jour par la
remédiation documentaire du Lot 0 (§ 10 à § 12), puis corrigé le 18/11/2026 après revalidation
dans le Codespace (E1 : origine des preuves, périmètres de tests, mesures, avancement hébergé —
§ 4, § 6, § 8, § 10, § 13).*

> **Statut : qualifications locales reproduites avec succès ; validation hébergée encore non
> réalisée ; LOT 0 validable sous réserves.**
>
> * Qualifications **locales** : SQL 1 847 / 1 847 et HTTP 302 / 302 sur PostgreSQL 17.11
>   (pile Supabase locale), obtenues dans la session cloud puis reproduites à l'identique dans
>   le Codespace (§ 10). Les preuves `lot4-local-*` du dépôt sont celles **du Codespace** (§ 4).
> * Qualification **hébergée** : **en cours** sur le projet de développement NEXORA-DEV.
>   Niveaux 1 et 2 (lecture seule) réalisés les 17 et 18/11/2026 ; écritures, migrations et
>   suites de tests restent à faire (§ 6, § 13). Elle reste obligatoire avant le Lot 1.
> * Revue technique contradictoire : « validable sous réserves » (§ 11).
> * Les décisions D4-9 à D4-13 et la correction de la migration 8 (§ 3) restent à approuver.
>
> Historique : la première version de ce document (même date) concluait « LOT 0 NON VALIDÉ »,
> avant la revue et la comparaison Cloud / Codespace.

## 1. Constat de départ (vérifié par exécution)

| Contrôle | Résultat |
|---|---|
| `npm run test:db` sur `6bc7f44` (migrations 1 à 8) | **rouge** : suite 02 interrompue ligne 75 (`permission denied for table accounts`) |
| Mêmes suites sur les migrations 1 à 7 seules | 1 106 / 1 106 |

Cause unique : la migration 8 retire à `authenticated` toute écriture directe (décision
D4-1), alors que les suites 01 à 08, P1 et la suite HTTP écrivaient directement et vérifiaient
des invariants devenus faux (politiques d'un seul rôle, aucune fonction dans `public`).
Piège relevé : plusieurs anciens tests de refus attendaient `42501` (déclencheur) et seraient
restés verts pour une autre raison (refus de privilège, même SQLSTATE) sans rien prouver.

## 2. Décisions D4-9 à D4-13 (appliquées selon la recommandation, à valider)

| # | Application |
|---|---|
| D4-9 | Option (a) : suites adaptées à l'état final. Écritures d'un utilisateur par `apply_changeset` ; écritures directes converties en tests de refus ; comportement du déclencheur testé en administrateur ; invariants du catalogue mis à jour ; nouvelle référence PG 16 |
| D4-10 | `nexora_writer` conservé. Vérifié sur l'image PostgreSQL de Supabase (pile locale) : rôle créé et propriété transférée par `postgres` non superutilisateur |
| D4-11 | Noms SQL sur le fil, inchangé. La suite HTTP lit la liste blanche dans la migration (aucune seconde définition) |
| D4-12 | 5 000 opérations / 4 Mio conservés. Mesuré par l'API locale : 5 000 opérations (1,6 Mio) en **3,09 s** dans le Codespace (preuve `lot4-local-http.json` ; ancienne mesure de la session cloud : 2,2 s) pour un `statement_timeout` de 8 s ; > 4 Mio et > 5 000 opérations → HTTP 413 |
| D4-13 | Alignement de `MemoryTransport` reporté au lot du transport HTTP. Écart ajouté : le serveur exige désormais une clé canonique (§ 3) |

## 3. Défaut corrigé dans la migration 8

**Constat (reproduit sur la pile réelle et par test)** : un lot pouvait viser deux fois la même
ligne si les deux clés ne différaient que par leur écriture (UUID en minuscules puis en
majuscules, date non normalisée, nombre pour une clé texte). Le contrôle « une opération par
clé » comparait les clés telles que reçues : la ligne était écrite deux fois (versions v + 1 et
v + 2 pour un seul lot). Aucun effet entre utilisateurs ; défaut d'intégrité du protocole.

**Correction** : `apply_changeset` exige la forme canonique de la clé (relue à travers les
types de la table), sinon `invalid_key`. Le mapping client l'impose déjà. Coût mesuré : nul
(5 000 opérations : 2,16 s avant, 2,17 s après). 8 assertions ajoutées à la suite 11.

## 4. Résultats

| Environnement | SQL | HTTP |
|---|---|---|
| PostgreSQL 16.15 éphémère, profil standard | **1 793 / 1 793** | — |
| PostgreSQL 16.15 « supabase-like » (`postgres` non superutilisateur, BYPASSRLS) | **1 847 / 1 847** | — |
| Pile Supabase locale réelle (PostgreSQL 17.11, GoTrue 2.197.0, PostgREST 16.5, Kong 2.8.1 ; CLI 2.122.0 ; 8 migrations) | **1 847 / 1 847**, 1 793 identiques à la référence PG 16, 0 régression | **302 / 302**, deux utilisateurs inscrits et authentifiés par GoTrue |
| `npm run check` | typecheck OK, 46 fichiers, build OK. **1 508 / 1 508** sur le périmètre du Lot 0 (HEAD `6bc7f44`, sans les modifications Decision Lab non commitées) ; **1 512 / 1 512** avec les 4 tests Decision Lab de la copie de travail (Codespace, 15/11/2026) | — |

Preuves : `docs/qualification/lot4-local-report.md`, `-sql.json`, `-http.json` (contrôle
`node scripts/check-qualification-evidence.mjs docs/qualification lot4-local` : propres,
cohérents et **complets** par rapport à la référence `scripts/qualification-reference/lot4-local.json`,
§ 12). Les preuves `3b-local-*` (migrations 1 à 7) sont inchangées.
Référence PG 16 : `supabase/db-tests/baseline/pg16.json` régénérée (1 793 assertions) ;
l'ancienne référence (1 106 assertions, migrations 1 à 7) reste disponible par
`git show 6bc7f44:supabase/db-tests/baseline/pg16.json`.

**Origine des résultats** (corrigée le 18/11/2026) :

* **Origine environnementale** : les preuves `lot4-local-*` présentes dans le dépôt
  proviennent du **Codespace** (pile Supabase locale, images `public.ecr.aws/supabase/*`,
  PostgreSQL `17.11.0.006`, rapport généré le **2026-11-14T14:58:35Z**). Les preuves de la
  session cloud (images Docker Hub, `SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io`, rapport du
  2026-11-14T01:40:10Z) ne sont **pas** dans le dépôt ; elles ont servi à produire la référence
  de complétude (§ 12), à laquelle les preuves du Codespace sont strictement conformes
  (contrôleur, 15 et 18/11/2026).
* **Traçabilité de l'exécution** : ces rapports sont antérieurs à l'ajout de la traçabilité
  (§ 12) ; ils ne consignent ni l'exécutant, ni le commit, ni l'empreinte des migrations. Le
  lien avec le code testé repose sur une corrélation d'horodatage, non cryptographique
  (migrations et suites datées du 14/11 à 14:50:29 UTC, preuves à 14:58:35 UTC, inchangées
  depuis). Empreinte actuelle des migrations 1 à 8 :
  `8eb5d49fcfbfc5eab2452d464d3ae72f769a30e69c1a759f08402fb5522c01fb`.
* Les résultats PostgreSQL 16 (profils standard et « supabase-like ») et les 10 mutations ont
  été observés dans la session cloud et **ne sont pas archivés** ; ils ne sont pas rejouables
  dans le Codespace sans binaires serveur PostgreSQL 16 (P26).

Par suite : 01 catalogue 809 · 02 isolation 402 · 03 déclencheurs 34 · 04 contraintes 122 ·
05 relations 10 · 06 suppression logique 28 · 07 synchronisation 16 · 08 cycle de vie 78 ·
09 outillage 15 · 10 sérialisation 13 (17) · 11 `apply_changeset` 266 · P1 plateforme 50.

### Contrôles par mutation (copie de travail, jamais le dépôt ; versionnés depuis la remédiation, § 12)

| # | Affaiblissement simulé | Échecs détectés |
|---|---|---|
| M1 | révocation D4-1 absente | 129 |
| M2 | contrôle du propriétaire retiré de la fonction | 46 |
| M3 | politiques du rôle d'écriture permissives | 51 |
| M4 | M2 + M3 + filtre propriétaire retiré (isolation supprimée) | 164 SQL, dont 17 « lignes de A inchangées » ; **86 / 302 par l'API** sur une pile réelle ainsi affaiblie |
| M5 | `apply_changeset` exécutable par `anon` | 4 |
| M6 | RLS désactivée sur une table | 4 |
| M7 | fonctions laissées à `postgres` | 4 |
| M8 | politique de lecture ouverte sur une table | 6 |
| M9 | `resolve_changeset` exécutable par PUBLIC | 7 |
| M10 | contrôle de clé canonique retiré | 7 |

## 5. Séparation entre deux utilisateurs : ce qui est prouvé

Pour chacune des 17 tables portant `user_id`, en SQL et par l'API réelle :

* B ne lit que ses lignes ; filtrer sur A ne renvoie rien ;
* toute écriture directe est refusée par privilège, même sur ses propres lignes ;
* par le protocole, B ne peut ni modifier, ni supprimer, ni écraser une ligne de A (ligne vue
  comme inexistante, aucune version révélée), ni écrire au nom de A, ni soumettre un lot au
  nom de A, ni lui transférer une ligne ;
* les 25 clés étrangères composites refusent toute référence à une ligne de A ;
* les lignes de A sont comparées avant / après, toutes tables et versions comprises ;
* `anon` n'accède à rien ; un jeton à la signature invalide est refusé.

Limites de cette preuve : § 7.

## 6. Qualification hébergée : ce qui manque

*Mis à jour le 18/11/2026 :* le projet de développement **NEXORA-DEV** existe et les niveaux 1
et 2 de sa qualification, en lecture seule, ont été réalisés hors du script (§ 13). Le mode
`hosted` de `scripts/qualify-supabase.sh` reste désactivé : aucune écriture, migration ni
suite de tests n'a été exécutée sur l'hébergé.

| Manque | Détail |
|---|---|
| Projet Supabase de **développement** | **Disponible** : NEXORA-DEV, `eu-west-1`, PostgreSQL 17.11, offre gratuite ; vide (0 utilisateur, aucune table dans `public`) au 18/11/2026 |
| Accès, fournis hors dépôt et hors conversation | **En place** : clé publique (`SUPABASE_ANON_KEY`) et mot de passe de la base (`SUPABASE_DB_PASSWORD`) en secrets du Codespace ; certificat racine Supabase hors dépôt (`/workspaces/nexora-n2/`) |
| Lieu d'exécution | Le Codespace. La connexion directe à la base (IPv6) n'y est pas joignable : passer par le pooler en mode session (IPv4, port 5432), en `sslmode=verify-full` |
| Réglage Auth pendant la qualification | Inscription par e-mail ouverte et confirmation désactivée (la suite HTTP inscrit deux comptes `@example.test`). **État constaté** : inscription ouverte, confirmation **obligatoire** ; à modifier temporairement (autorisation distincte), puis à rétablir |
| Mode `hosted-dev` du script | À écrire à ce moment-là : cible confirmée explicitement, refus si un utilisateur non fictif existe, nettoyage (schémas `tests`, `tests_dblink`, comptes fictifs) |

À observer sur l'hébergé : inscription créant le profil (P10) ; création de `nexora_writer`
et transfert de propriété (P13) ; `statement_timeout` et durée d'un lot de 5 000 opérations ;
réglages de rôle de la migration 7 (P11) ; disponibilité de `dblink` ; GraphQL. *Constaté au
18/11/2026 :* `dblink` disponible mais non installé ; GraphQL **désactivé** sur NEXORA-DEV
(`pg_graphql` non installé), contrairement à ce qui était supposé.

## 7. Risques ouverts

* Plateforme hébergée partiellement qualifiée : lecture seule uniquement (§ 13) ; P9, P10,
  P11, P13 restent ouverts.
* GraphQL non activé sur la pile locale **ni sur NEXORA-DEV** : ses contrôles n'y prouvent
  rien (P24).
* Un lot de 5 000 opérations prend 3,09 s dans le Codespace (2,2 s dans la session cloud) ;
  sur une petite instance hébergée, le délai de
  8 s peut être atteint (grosses restaurations : découpage à prévoir).
* Une erreur transitoire pendant les écritures d'un lot est rapportée `invalid_row` (refus
  définitif) avec son SQLSTATE d'origine : le client devra en tenir compte (P20).
* Croissance de `private.changesets`, y compris par des appels répétés à
  `resolve_changeset` avec des identifiants aléatoires (P14).
* Les politiques d'écriture d'`authenticated` restent en place, inertes : elles
  redeviendraient actives si un privilège d'écriture était réaccordé (gardé par la suite 01).
* Existence d'un UUID d'autrui révélée par `duplicate_key` (P7, accepté).
* R1, rechargement après conflit (R3), P1, P15, P19 : lots suivants.
* Suites SQL et HTTP hors intégration continue.
* Modifications locales du Codespace non examinées dans cette session. *(Remédiation : le
  Codespace est la référence opérationnelle ; ses résultats de qualification sont identiques,
  § 10 ; son contenu n'a pas été examiné par la session cloud.)*

## 8. Critères de passage au Lot 1 (authentification)

1. Décisions D4-9 à D4-13 et correction du § 3 approuvées ; modifications commitées.
2. Qualification hébergée de développement sans écart (§ 6), preuves archivées et contrôlées.
3. `npm run test:db` (1 793) et `npm run check` verts sur la branche — 1 508 tests sur le
   périmètre du Lot 0, 1 512 lorsque les 4 tests Decision Lab seront commités ; contrôleur de
   preuves et ses tests verts ; 10 mutations de sécurité détectées (§ 12).
4. ~~Modifications locales du Codespace réconciliées avec la branche.~~ Travail du Lot 0
   versionné sur GitHub **depuis le Codespace**, qui est la référence opérationnelle.
5. Choix du Lot 1 arrêtés : méthodes de connexion, confirmation d'e-mail, URL de redirection.
6. Réserves du § 11 traitées ou explicitement acceptées.

## 9. Fichiers modifiés

| Fichier | Nature |
|---|---|
| `supabase/migrations/20261101000800_apply_changeset.sql` | clé canonique exigée (§ 3) |
| `supabase/db-tests/_setup.sql` | fonctions d'aide `tests.cs_*` (écriture par le protocole) |
| `supabase/db-tests/01` à `06`, `08`, `11`, `platform/P1` | adaptation à l'état final, tests ajoutés |
| `supabase/db-tests/http/rls.mjs`, `chain-report.mjs` | écritures par `/rpc/apply_changeset`, refus des écritures directes |
| `supabase/db-tests/baseline/pg16.json` | nouvelle référence |
| `scripts/qualify-supabase.sh`, `scripts/check-qualification-evidence.mjs` | preuves `lot4-local-*` séparées de `3b-local-*` |
| `docs/qualification/lot4-local-*` | nouvelles preuves |
| `scripts/qualification-reference/` (remédiation) | références de complétude `3b-local.json`, `lot4-local.json` et procédure de mise à jour |
| `scripts/check-qualification-evidence.test.mjs` (remédiation) | tests de régression du contrôleur |
| `scripts/security-mutations/` (remédiation) | 10 contrôles de sécurité par mutation, exécuteur isolé, notice |
| `docs/LOT4_PLAN.md`, `docs/SUIVI_TECHNIQUE.md`, `docs/CODESPACES.md` (remédiation) | harmonisation documentaire |

Migrations 1 à 7, `src/`, Decision Lab et interface : inchangés. La remédiation n'a modifié
aucune migration (la migration 8 est celle du § 3).

## 10. Comparaison des qualifications Cloud et Codespace

Les qualifications locales ont été exécutées dans deux environnements distincts, avec la même
version de PostgreSQL (17.11, image de la pile Supabase locale) :

| Qualification | Session cloud (14/11/2026) | Codespace |
|---|---|---|
| SQL | 1 847 / 1 847 | 1 847 / 1 847 |
| HTTP | 302 / 302 | 302 / 302 |

Comparaison réalisée par le responsable du projet avec un script Python indépendant, à partir
des preuves cloud extraites du patch et des preuves locales du Codespace : signatures
strictement identiques, aucun test manquant, aucun test supplémentaire, aucun statut
divergent. Ce script n'est pas versionné. *Correction du 18/11/2026 :* les preuves
`docs/qualification/lot4-local-*` présentes dans le Codespace sont celles **du Codespace**
(§ 4) ; les preuves cloud ne sont pas dans le dépôt. Aucune n'est encore commitée.

Conséquence vérifiable : les 8 assertions de clé canonique de la suite 11 font partie des
signatures identiques et échouent si le contrôle est retiré (mutation M10, 7 échecs) ; la
migration 8 du Codespace contient donc ce contrôle (ou un équivalent).

**Portée** : cette comparaison prouve la **reproductibilité** des qualifications locales.
Elle ne prouve **pas** la validation du projet Supabase hébergé.

## 11. Revue technique contradictoire

Une revue indépendante a conclu : **« LOT 0 validable sous réserves »**, sans anomalie
bloquante dans la migration 8, les politiques de sécurité ni les tests. Réserves et suites
données :

| Réserve | Statut après la remédiation | Suivi |
|---|---|---|
| Qualification Supabase hébergée | **En cours** : niveaux 1 et 2 en lecture seule réalisés (§ 13) ; écritures et suites à faire | P22 |
| Scripts de mutation non versionnés | **Traité** (§ 12), en attente de validation | P29 |
| Contrôleur de preuves : cohérence vérifiée, pas la complétude | **Traité** (§ 12), en attente de validation | — |
| Preuves sans environnement, commit ni empreinte des migrations | **Partiellement traité** : ajoutés aux futurs rapports ; preuves existantes inchangées | § 12 |
| GraphQL non probant sur la pile locale | **Ouvert** ; GraphQL également désactivé sur NEXORA-DEV | P24 |
| PostgreSQL 17 éphémère non exécuté | **Ouvert**, à clarifier | P26 |
| Incohérences documentaires | **Traité** dans `LOT0_QUALIFICATION.md`, `LOT4_PLAN.md`, `SUIVI_TECHNIQUE.md`, `CODESPACES.md` | — |
| Synchronisation incrémentale : nouvelle fonction serveur nécessaire | **Ouvert** (lot prévu) | P28 |
| `service_role` | **Ouvert**, risque à encadrer | P25 |
| Quotas et purge | **Ouvert**, avant l'ouverture publique | P31, P5, P14 |
| Délai de 8 s | **Partiellement traité** : mesure locale (3,09 s dans le Codespace), mesure hébergée manquante | P30, P13 |
| Erreurs transitoires classées définitives | **Ouvert** (transport HTTP) | P20 |
| Exception `transactions.attachment_id` | **Ouvert**, risque documenté | P23 |
| Couverture HTTP des clés étrangères (6 / 25 ; SQL : 25 / 25) | **Ouvert**, non bloquant | P27 |
| Travail du Lot 0 non versionné sur GitHub | **Ouvert** : à commiter et pousser depuis le Codespace | § 8, critère 4 |

## 12. Remédiation : robustesse des preuves et contrôles par mutation

**Contrôleur de preuves** (`scripts/check-qualification-evidence.mjs`) : en plus des
contrôles de secrets et de cohérence, il vérifie la **complétude** de chaque jeu de preuves
par rapport à une référence versionnée (`scripts/qualification-reference/`) : signatures
exactes des 1 847 assertions SQL et 302 HTTP, nombre par suite, catégories critiques
(isolation, catalogue, protocole de la migration 8, clé canonique, écritures directes,
précision, rôle anonyme, plateforme), version majeure de PostgreSQL et liste exacte des
migrations. La référence est lue dans le dépôt et son empreinte est épinglée dans le
contrôleur ; sa mise à jour est volontaire et documentée
(`scripts/qualification-reference/README.md`). Avant la remédiation, une suite supprimée
avec un compteur de rapport ajusté était acceptée ; elle est désormais refusée.

Tests : `node --test scripts/check-qualification-evidence.test.mjs` (21 tests sur copies
temporaires hors dépôt). Désactiver le contrôle de complétude fait échouer 11 de ces tests.

**Traçabilité** : `scripts/qualify-supabase.sh` consigne désormais dans le rapport
l'environnement, le commit testé (et le nombre de fichiers non commités), l'empreinte des
migrations et le registre d'images ; le contrôleur vérifie l'empreinte des migrations
lorsqu'elle est présente. Les preuves existantes n'ont pas été modifiées.

**Contrôles par mutation** (`scripts/security-mutations/`) : portage en Node du script
d'origine ; pour les 10 mutations, la migration produite est identique octet par octet à
celle de l'original. Rejoués le 14/11/2026 (session cloud, PostgreSQL 16.15) : témoin
1 793 / 1 793, puis **10 / 10 détectées** avec exactement les nombres d'échecs du tableau du
§ 4. Commande : `node scripts/security-mutations/run.mjs` (binaires PostgreSQL 16 requis).

## 13. Qualification hébergée : avancement (17 et 18/11/2026)

Projet **NEXORA-DEV** (référence `nmrjwyfloqnypaawlqxd`, `eu-west-1`, PostgreSQL 17.11). Toutes
les opérations ci-dessous sont en **lecture seule** : aucune écriture, aucune migration, aucun
utilisateur créé. Les sorties brutes ne sont pas versionnées.

| Niveau | Contenu | Résultat |
|---|---|---|
| 1 | API anonyme : `GET /rest/v1/`, `GET /auth/v1/settings`, introspection GraphQL | Clé `anon` acceptée ; description OpenAPI réservée à `service_role` ; inscription par e-mail ouverte, **confirmation obligatoire**, seul fournisseur `email` ; **GraphQL désactivé** |
| 2 | Inspection SQL du catalogue, script v3 (SHA-256 `7cd02f2c…`) | **Réussite** (règle O1). TLS 1.3 en `verify-full` par le pooler ; `postgres` : non superutilisateur, `BYPASSRLS`, `CREATEROLE`, option ADMIN sur `anon`, `authenticated`, `service_role` ; `extra_float_digits = 0` (P11 confirmé) ; 0 utilisateur ; aucune migration appliquée ; `dblink` disponible, non installé ; privilèges par défaut plus restrictifs qu'en local ; aucun déclencheur `login` |
| 2 bis | Déclencheur `ensure_rls` et droits sur `public`, script SHA-256 `cb7908b4…` | **Réussite** (règle O1-bis). `ensure_rls` (`public.rls_auto_enable()`) active la RLS, sans la forcer, sur les **seules** tables créées dans `public` ; compatible avec les migrations (la migration 6 active et force la RLS) ; `private` et `tests` non concernés. `postgres` peut créer et accorder `CREATE` sur `public` (migration 8) |

Garanties appliquées : transaction `READ ONLY`, `search_path = pg_catalog, pg_temp`, garde-fou
G1 qualifié, `ROLLBACK` final, script lié à son empreinte SHA-256, client `psql` dans un
conteneur jetable sans privilèges. Règle O1 : réussite uniquement si code 0, `G1 OK` et
marqueur de fin présents une fois, `ROLLBACK` exécuté et aucun déclencheur `login`.

Restent : migration 7 sur des rôles réservés par `supautils` (incertitude, à vérifier au
Niveau 4, P33) ; application des 8 migrations ; suites SQL et HTTP adaptées à l'hébergé
(P24, `dblink`, confirmation d'e-mail, privilèges par défaut, P34) ; mesure du délai (P30).
