# NEXORA — Lot 4 : écriture serveur atomique et versionnée (`apply_changeset`)

> **STATUT (01/11/2026) : EN COURS.** Étapes 4.0 et 4.1 réalisées sur
> `claude/stoic-edison-8s0vhq` (base `8cdd310`), en attente de revue. Étapes 4.2 à 4.7 non
> commencées. Aucun projet Supabase hébergé, aucune migration ajoutée ou modifiée, aucune
> donnée réelle touchée.

Références : `docs/AUDIT_LOT1_CLOUD.md` (§ C.3, C.4, F), `docs/LOT2_REPOSITORY.md`,
`docs/LOT3_PLAN.md`, `docs/LOT3B_CLOTURE.md`, `docs/SUIVI_TECHNIQUE.md` (R1–R3, P1–P11).

## 1. Décisions validées par le responsable du projet

| # | Décision | Conséquence pour la suite du lot |
|---|---|---|
| D4-0 | Branche de travail exclusive : `claude/stoic-edison-8s0vhq`. Branches protégées : `claude/nexora-finance-platform-81blaa` (production), `nexora-dev` | Aucun push ailleurs ; aucun rebase, reset destructif ni force push |
| D4-1 | Toutes les écritures métier cloud passent **exclusivement** par `apply_changeset` | Une **nouvelle** migration retirera à `authenticated` les privilèges `insert` / `update` directs (les 7 migrations validées restent inchangées) ; les tests HTTP d'écriture directe deviendront des tests de refus |
| D4-2 | Versions serveur conservées dans une **table annexe du cache** | Le domaine, `snapshot()` et `exportBackup()` ne voient jamais les versions |
| D4-3 | **Aucune duplication des règles métier en SQL** | Pas de recalcul serveur de `saved_amount` ni du statut des dettes : le contrôle de version de la ligne parente empêche les mises à jour perdues |
| D4-4 | Contrôle de version **partout**, exceptions explicitement encadrées | Chaque exception (par exemple l'écrasement explicite de `restoreBackup`) est listée, justifiée et testée |
| D4-5 | Idempotence par `changesetId` (UUID client) | Un lot rejoué n'est pas appliqué deux fois (prépare P1) |
| D4-6 | Taille maximale d'un lot déterminée **par mesure** sur les données de démonstration | Mesure documentée avant de fixer la limite dans la fonction |
| D4-7 | Contrôles inter-lignes complexes (par exemple « transfert = exactement 2 jambes ») **reportés** | Hors Lot 4 |
| D4-8 | Qualification HTTP dans Codespaces **obligatoire** avant clôture | L'étape 4.6 conditionne 4.7 |

## 2. Périmètre et étapes

| Étape | Contenu | Statut |
|---|---|---|
| 4.0 | Préalables : décisions consignées, documentation périmée corrigée | **Réalisée** (§ 3) |
| 4.1 | Atomicité R2 : `saveAsset` + valorisation initiale, `resetToEmpty` | **Réalisée** (§ 4) |
| 4.2 | Mapping TypeScript ↔ SQL (`src/data/cloud/mapping.ts`) | À faire |
| 4.3 | Protocole `ChangeSet` versionné (versions attendues, `changesetId`, conflit) | À faire |
| 4.4 | Fonction SQL `apply_changeset` (nouvelles migrations) | À faire |
| 4.5 | Tests PostgreSQL 16 / 17 éphémères | À faire |
| 4.6 | Qualification HTTP (Codespaces, par le responsable du projet) | À faire |
| 4.7 | Clôture et archivage | À faire |

**Exclus** : transport réseau et `@supabase/supabase-js`, récupération des changements et
rechargement après conflit (Lot 5) ; authentification dans l'application (Lot 6) ; R1,
pièces jointes et Storage (Lot 7) ; projet hébergé (3b-4) ; données Edge.

## 3. Étape 4.0 — préalables

Corrections documentaires (informations devenues inexactes, sans changer aucun résultat) :

| Fichier | Correction |
|---|---|
| `docs/LOT3B_CLOTURE.md` § 3, § 7.6, § 8 | Les trois rapports Codespaces sont **versionnés** depuis `8cdd310` (et non « non versionnés ») ; contrôle `scripts/check-qualification-evidence.mjs` rejoué : « fichiers propres et cohérents » ; condition « décision de lancement du Lot 4 » marquée comme donnée |
| `docs/LOT3B_QUALIFICATION.md` § 4 | « les 6 migrations » → toutes les migrations du répertoire (7 à ce jour) ; le script compare déjà dynamiquement avec le contenu de `supabase/migrations/` |
| `scripts/qualify-supabase.sh` | Même correction dans le commentaire d'en-tête (aucun changement de comportement) |
| `docs/SUIVI_TECHNIQUE.md` | R2 : constat complémentaire et traitement (étape 4.1) ; R3 : renvoi aux décisions D4 |

Les documents conservés « sans modification » par choix (`LOT3_PLAN.md` partie II,
`LOT3B_PLAN.md` § 4) gardent leurs chiffres d'origine (« 6 migrations ») ; leur statut en
tête le signale déjà.

**Vérifié** : les 7 migrations `supabase/migrations/*.sql` sont inchangées (diff vide).

## 4. Étape 4.1 — réserve R2

### 4.1 Constats (avant correction, `8cdd310`)

1. `saveAsset` écrivait l'actif hors transaction, puis appelait `addValuation` (seconde
   écriture). En cloud : **deux lots** ; une panne entre les deux laissait un actif sans
   valorisation.
2. La valorisation initiale était validée **après** l'écriture de l'actif : une date ou une
   valeur invalide créait l'actif puis levait une `ValidationError`, **y compris en mode
   local**. Dans `NetWorth.tsx`, le formulaire restait ouvert : une nouvelle tentative créait
   un second actif (ou échouait sur « compte déjà valorisé »).
3. `resetToEmpty` enchaînait `clearUserData`, `ensureUser` et `updateSettings` sans
   transaction commune : une panne après l'effacement laissait un espace sans paramètres
   (retour à l'onboarding) ou sans catégories initiales.

### 4.2 Corrections (`src/data/RepositoryCore.ts`)

* **`saveAsset`** : validations, puis écritures, dans **une seule transaction**
  `['assets', 'valuations']`. Ordre des validations conservé (nom vide → compte déjà
  valorisé → actif inconnu) ; la validation de la valorisation initiale (date puis valeur,
  mêmes messages) est ajoutée **avant** la première écriture. `addValuation` est appelée
  telle quelle : l'appel imbriqué rejoint la transaction englobante (Dexie et
  `CloudStorage`).
* **`addValuation`** : inchangée fonctionnellement ; ses deux contrôles sont factorisés dans
  une fonction de module `checkValuation` (et non une méthode, pour que la surface de l'API
  reste de 54 méthodes).
* **`resetToEmpty`** : une transaction englobante dont la portée couvre toutes les tables
  des appels imbriqués (`USER_TABLES`, `attachments`, `users`, `meta`).

**Règles métier** : aucune modifiée. Seul effet observable : en cas d'échec (validation de la
valorisation initiale, panne), **plus rien n'est écrit**, au lieu d'une écriture partielle.
En cloud, chaque opération produit désormais **un seul lot** (règle « une opération métier =
un `ChangeSet` », préalable à `apply_changeset`).

### 4.3 Tests (`src/data/contract.test.ts`, bloc « atomicité R2 », 23 tests)

Exécutés sur `LocalRepository` (transaction Dexie) **et** `CloudRepository`
(`MemoryTransport`), uniquement sur fake-indexeddb et des données fictives. Comparaison
exhaustive de la base / du cache **et**, en cloud, du serveur simulé.

| Test | Vérifie |
|---|---|
| Valorisation initiale invalide (5 cas : date inexistante, date mal formée, valeur négative, non entière, NaN) | `ValidationError`, aucun actif, aucun lot envoyé |
| Messages | Date invalide signalée avant la valeur (ordre d'origine) |
| Panne à l'écriture de la valorisation | Aucun actif orphelin ; nouvelle tentative possible (pas de « compte déjà valorisé ») |
| Panne à l'écriture de l'actif | Ni actif ni valorisation |
| Succès | Création avec valorisation (un seul lot cloud contenant `assets` + `valuations`), modification sans valorisation, modification avec valorisation |
| Erreurs existantes | Nom vide, compte déjà valorisé, actif inconnu : aucune écriture |
| `resetToEmpty`, panne à 4 étapes (effacement, profil, catégories initiales, paramètres) | État strictement identique à l'état initial |
| `resetToEmpty`, succès | Espace vierge, préférences conservées, `demoMode = false`, catégories initiales, un seul lot cloud |
| Équivalence | Mêmes résultats et mêmes données en local et en cloud (horloge et identifiants figés) |

**Contrôles par mutation** (code volontairement cassé puis restauré) :

| Mutation | Tests en échec |
|---|---|
| M1 — `saveAsset` sans transaction | 3 (panne valorisation local + cloud, lot unique cloud) |
| M2 — `resetToEmpty` sans transaction englobante | 7 (3 pannes local, 3 pannes cloud, lot unique cloud) |
| M3 — code d'origine exact (sans transaction, validation après écriture) | 5 (valorisation invalide local + cloud, panne valorisation local + cloud, lot unique cloud) |

Deux tests ne peuvent pas détecter ces mutations, par construction : « panne à l'écriture
de l'actif » (première écriture, rien avant elle) et « panne à l'effacement »
(`clearUserData` est déjà atomique à lui seul). Ils protègent contre d'autres régressions.

### 4.4 Résultats

* `npm run check` : typecheck OK, **13 fichiers, 337 tests, 337 réussis** (314 existants
  inchangés + 23 nouveaux), build OK.
* `repository.test.ts` : 31/31, sans modification.
* E2E (`e2e/smoke.cjs`, build local servi sur `localhost`, profil Chromium neuf) : **10/11**,
  aucune erreur de page. L'échec « transfert non compté en dépense (dépenses = 410,80) »
  est **préexistant** : il se reproduit à l'identique sur `8cdd310` sans les corrections
  du Lot 4. Hypothèse non vérifiée : test dépendant de la date du jour (exécution le
  01/11, premier jour du mois ; 11/11 le 31/10 au Lot 2). Hors périmètre 4.1, à analyser
  séparément.

### 4.5 Limites restantes

* R2 est **corrigée et testée** ; sa levée formelle intervient à la validation du Lot 4
  (règle du registre).
* L'atomicité côté serveur (un lot = une transaction PostgreSQL) reste à prouver avec
  `apply_changeset` (étapes 4.4 à 4.6).
* Les autres opérations à écriture unique ne sont pas concernées ; aucune autre opération
  composée hors transaction n'a été trouvée dans `RepositoryCore` (`saveGoal` et
  `saveRecurringRule` n'écrivent qu'une ligne par appel).
