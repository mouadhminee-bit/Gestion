# NEXORA — Étape 3b : qualification sur la véritable pile Supabase — PROPOSITION

*Cadrage du 01/11/2026, en attente d'autorisation explicite. Aucun projet créé, aucune
connexion à Supabase, aucune donnée touchée.*

## 1. Constats préalables (vérifiés depuis cet environnement)

| Constat | Conséquence |
|---|---|
| Les hôtes `supabase.com`, `api.supabase.com` et `apt.postgresql.org` sont **refusés** par la politique réseau de cette session | Rien ne peut être créé ni testé chez Supabase depuis ici sans élargir l'accès réseau |
| La sortie réseau ne passe que par un proxy **HTTPS** | Une connexion PostgreSQL directe (port 5432 / pooler) vers un projet hébergé est **impossible** depuis ici, même avec l'hôte autorisé |
| Docker est installé mais **sans démon** | `supabase start` (pile Supabase locale) impossible ici |
| Les nouveaux projets Supabase sont en **PostgreSQL 17** (le Lot 3 a été validé sur 16) | Compatibilité 17 à qualifier ; `supabase/config.toml` (`major_version = 15`) à corriger |
| GitHub Codespaces (`.devcontainer/` de `nexora-dev`) dispose d'un accès réseau direct et peut exécuter Docker | Lieu d'exécution adapté — **par vous**, je n'y ai pas accès |

## 2. Environnements proposés

| | A — Pile Supabase locale dans Codespaces **(recommandé, premier)** | B — Projet Supabase hébergé de développement *(facultatif, ensuite)* |
|---|---|---|
| Nature | Images officielles Supabase (PostgreSQL 17 Supabase, GoTrue/Auth, PostgREST, Kong, Supavisor) lancées par `supabase start` | Projet cloud réel, offre gratuite |
| Séparation de la production | Totale : tout tourne dans le conteneur, détruit à la fin ; aucun compte Supabase | Organisation Supabase **dédiée** (« nexora-qualification ») contenant un seul projet ; aucune donnée réelle |
| Ce que ça qualifie | Rôles, privilèges, RLS réelle, JWT signés par GoTrue, PostgREST, version 17, extensions | En plus : configuration de la plateforme hébergée, pooler, version réellement déployée |
| Compte nécessaire | GitHub (Codespaces) | GitHub + Supabase |
| Secrets | aucun (clés locales par défaut) | mot de passe de la base, clé `anon`, URL — en **secrets Codespaces**, jamais dans la discussion |
| Exécution | vous, une commande | vous, une commande |

L'étape 0 (facultative, ici) consiste à rejouer les 1 057 assertions sur un PostgreSQL 17
**local et éphémère**, en binaires téléchargés depuis `registry.npmjs.org` (autorisé), dans
`/tmp`, détruits ensuite. Elle détecte les incompatibilités de version **avant** Codespaces.
La disponibilité de `dblink` dans ces binaires n'est pas garantie (sans lui, seul le fichier
de synchronisation ne pourrait pas tourner à cette étape).

## 3. Coûts

| Poste | Coût | Remarques |
|---|---|---|
| Étape 0 | 0 | ressources de cette session |
| A — Codespaces | 0 dans le quota gratuit mensuel des comptes personnels | Machine 4 cœurs / 16 Go recommandée (la pile Supabase demande ~4 Go de RAM ; la machine 2 cœurs / 4 Go actuelle est juste). Exécution estimée : 20 à 40 min, soit 1,5 à 3 heures-cœur. Vérifier votre quota restant dans GitHub → Settings → Billing |
| B — Supabase hébergé | 0 avec l'offre gratuite | Limites rapportées : 2 projets actifs, mise en pause après 7 jours d'inactivité, 500 Mo de base. Si vous avez déjà 2 projets gratuits actifs : en mettre un en pause ou passer à Pro (25 $/mois). Les tarifs viennent de sources tierces (la page officielle est inaccessible d'ici) : à vérifier sur supabase.com/pricing |

## 4. Opérations prévues

### Étape P — Préparation (moi, dans cette session, après votre accord ; aucun accès Supabase)

| Fichier | Contenu |
|---|---|
| `scripts/qualify-supabase.sh` | Orchestration A/B : contrôles d'environnement, application des migrations, suites SQL et HTTP, comparaison, rapport, nettoyage |
| `scripts/db-test.sh` | Mode supplémentaire « base existante » : exécute les tests SQL sur une base désignée (sans l'émulation `auth`), avec garde-fou refusant toute base non explicitement marquée comme base de qualification |
| `supabase/db-tests/http/rls.mjs` | Tests via l'API avec **deux utilisateurs réellement authentifiés** (inscription GoTrue, jetons JWT réels, appels PostgREST) ; Node 22, `fetch`, **aucune dépendance** |
| `supabase/db-tests/baseline/pg16.json` | Résultat de référence des 1 057 assertions sur PostgreSQL 16 local (pour la comparaison) |
| `supabase/config.toml` | `major_version = 17` |
| `.devcontainer/devcontainer.json` | Ajout de la fonctionnalité Docker-in-Docker et d'une machine 4 cœurs (sur `claude/stoic-edison-8s0vhq` uniquement) |
| `docs/LOT3B_QUALIFICATION.md` | Mode opératoire pas à pas |

### Étape A — Exécution par vous dans Codespaces (sur `claude/stoic-edison-8s0vhq`)

1. Créer un Codespace sur la branche, puis lancer `bash scripts/qualify-supabase.sh local`.
2. Le script : `npx supabase start` → `supabase db reset` (applique les 6 migrations) →
   contrôles du catalogue et des privilèges → suites SQL → suite HTTP → comparaison avec
   la référence PostgreSQL 16 → rapport → `supabase stop --no-backup` (supprime toutes les
   données du conteneur).
3. Le rapport (`docs/qualification/3b-local.md` + `.json`, sans aucun secret) est commité
   sur la branche ; je le relis et rédige le rapport de qualification.

### Étape B — facultative, après A

1. Vous créez une organisation Supabase dédiée, un projet de développement (région UE,
   offre gratuite) et désactivez la confirmation d'e-mail (utilisateurs de test fictifs
   `@example.test`).
2. Vous enregistrez dans les secrets Codespaces : URL du pooler en mode **session** (avec
   mot de passe), URL du projet, clé `anon`.
3. `bash scripts/qualify-supabase.sh hosted` : mêmes suites. Le script refuse de s'exécuter
   si le projet contient des tables autres que celles des migrations ou des utilisateurs
   autres que les comptes de test.
4. Nettoyage : schéma `tests` et utilisateurs de test supprimés ; vous pouvez ensuite
   mettre le projet en pause ou le supprimer.

Aucune étape ne touche la base IndexedDB `nexora`, l'application, l'authentification de
l'application, `nexora-dev`, la production ou Netlify. Aucune fonction `apply_changeset`.

## 5. Couverture des objectifs

| # | Objectif | Comment |
|---|---|---|
| 1 | Environnement séparé de la production | A : conteneur éphémère ; B : organisation dédiée, garde-fous du script |
| 2 | Compatibilité avec la version réelle | Étape 0 (PG 17 local) ; A/B : `select version()` consigné, migrations appliquées par l'outil Supabase |
| 3 | Migrations sur l'environnement de test uniquement | `supabase db reset` (A) / `supabase db push --db-url` (B), jamais sur un autre projet |
| 4 | `anon`, `authenticated`, privilèges des fonctions | Suite catalogue (01, 08) rejouée sur les vrais rôles Supabase + appels HTTP : `anon` refusé, `/rpc/handle_new_user` introuvable, schéma `private` non exposé, GraphQL vérifié |
| 5 | Isolation RLS avec deux utilisateurs authentifiés | `rls.mjs` : inscription de A et B, jetons réels ; lecture, modification, suppression, insertion au nom d'autrui, upsert, références croisées par l'API ; jeton falsifié refusé |
| 6 | Clés composites et contraintes différées | Suites 02 et 05 + écriture circulaire via l'API (erreur différée remontée par PostgREST) |
| 7 | Déclencheurs et métadonnées serveur | Suite 03 + vérification par l'API (valeurs imposées par le serveur dans la réponse) |
| 8 | Synchronisation et transactions concurrentes | Suite 07 (sessions concurrentes, 300 étapes aléatoires) sur la base Supabase |
| 9 | Comparaison avec PostgreSQL local | Comparaison assertion par assertion avec `baseline/pg16.json` ; tout écart est listé et analysé |

## 6. Points que la qualification doit trancher (non vérifiables localement)

| # | Question | Impact si la réponse est négative |
|---|---|---|
| Q1 | Le rôle `postgres` de Supabase (non superutilisateur) a-t-il `BYPASSRLS` ? Avec la RLS **forcée**, sinon même le propriétaire est filtré | Outillage d'administration via `service_role` ; aucun impact sur l'application |
| Q2 | Un déclencheur sur `auth.users` (`handle_new_user`) est-il accepté par la plateforme ? | Création du profil à déplacer (premier `ensureUser`, Lot 4) |
| Q3 | Les tests SQL peuvent-ils insérer directement dans `auth.users` ? | Création des utilisateurs de test par l'API d'administration |
| Q4 | `dblink` disponible et connexion à la base elle-même possible ? | Concurrence pilotée depuis l'extérieur (plusieurs connexions `psql`) |
| Q5 | Privilèges par défaut et déclencheurs d'événements Supabase (`pg_graphql`, PostgREST) : nos révocations tiennent-elles ? | Révocations complémentaires dans une 7e migration |
| Q6 | Erreurs de contraintes différées (`23503` à la validation) correctement renvoyées par PostgREST ? | Gestion d'erreur à prévoir au Lot 4 |

## 7. Autorisations demandées

| # | Autorisation | Recommandation |
|---|---|---|
| 3b-1 | Préparer les fichiers de l'étape P sur `claude/stoic-edison-8s0vhq` (dont `.devcontainer/` et `config.toml`) | Oui |
| 3b-2 | Étape 0 : PostgreSQL 17 éphémère dans `/tmp` (binaires npm, détruits ensuite) | Oui |
| 3b-3 | Étape A dans votre Codespace (exécutée par vous) | Oui |
| 3b-4 | Étape B : projet hébergé dans une organisation dédiée (créé et exécuté par vous) | Facultatif, après A |
