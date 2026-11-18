# Contrôles de sécurité par mutation (Lot 0)

Vérifient que les suites SQL **détectent** un affaiblissement de la sécurité de la
migration 8 (`apply_changeset`, rôle `nexora_writer`, RLS, privilèges). Chaque mutation
affaiblit une **copie** de la migration ; les suites doivent alors échouer.

## Provenance

Portage en Node du script Python utilisé pour la qualification du Lot 0 (session cloud du
14/11/2026, archive `nexora-lot0-outils-hors-depot/mutations/mut.py`). Équivalence
vérifiée : pour les 10 mutations, la migration produite est **identique octet par octet**
à celle du script d'origine (même empreinte SHA-256).

## Prérequis

* Node 22 ;
* binaires **serveur** PostgreSQL 16 et `psql` (variable `PG_BIN`, défaut
  `/usr/lib/postgresql/16/bin`), comme `npm run test:db`. Vérifier `ls /usr/lib/postgresql/` ;
  s'ils sont absents, installer les binaires serveur PostgreSQL 16 (dépôt PGDG), ou exécuter
  dans un environnement qui les fournit ;
* aucun Docker, aucun réseau, aucun projet Supabase.

## Commandes

```bash
node scripts/security-mutations/run.mjs --list     # liste des 10 mutations
node scripts/security-mutations/run.mjs            # témoin + 10 mutations (≈ 1 min 30)
node scripts/security-mutations/run.mjs M5 M10     # sélection
```

## Isolation

* Chaque exécution travaille dans un dossier **neuf** créé par `mkdtemp` sous le dossier
  temporaire du système ; un chemin situé dans le dépôt est refusé.
* Seule la **copie** de la migration est modifiée ; le dépôt n'est jamais écrit.
* `scripts/db-test.sh` crée puis détruit son propre cluster PostgreSQL éphémère (socket Unix,
  aucun port TCP).
* Le script supprime le dossier temporaire qu'il a créé, et lui seul.

## Verdicts

| Verdict | Sens |
|---|---|
| DÉTECTÉE | toutes les suites ont tourné et au moins une assertion échoue |
| NON PROBANT | une suite s'est interrompue : échec d'exécution, ce n'est pas une preuve |
| NON DÉTECTÉE | aucune assertion n'échoue malgré l'affaiblissement : trou de test |

Un **témoin** (copie sans mutation) est exécuté d'abord : il doit réussir sans échec, sinon
aucune conclusion n'est tirée (code de sortie 2).

## Résultats de référence (PostgreSQL 16.15, 1 793 assertions)

| Mutation | Affaiblissement | Échecs |
|---|---|---|
| M1 | révocation D4-1 absente | 129 |
| M2 | contrôle du propriétaire retiré de la fonction | 46 |
| M3 | politiques du rôle d'écriture permissives | 51 |
| M4 | isolation supprimée (M2 + M3 + filtre propriétaire) | 164 |
| M5 | `apply_changeset` exécutable par `anon` | 4 |
| M6 | RLS désactivée sur `transactions` | 4 |
| M7 | fonctions laissées à `postgres` | 4 |
| M8 | politique de lecture ouverte sur `accounts` | 6 (sur 1 795) |
| M9 | `resolve_changeset` exécutable par PUBLIC | 7 |
| M10 | contrôle de clé canonique retiré | 7 |

Ces nombres sont observés, non exigés : seule compte la détection. Une baisse marquée après
une modification des suites doit toutefois être expliquée.

## Limites

* Couvre la migration 8 uniquement, et les suites SQL (pas la suite HTTP : sur la pile
  Supabase locale, M4 a fait échouer 86 assertions HTTP sur 302 lors du Lot 0, contrôle non
  automatisé ici).
* Ne s'applique jamais à un projet hébergé.
