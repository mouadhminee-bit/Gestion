# NEXORA — Lot 2 : abstraction de la persistance

*Réalisé le 31/10/2026 sur `claude/stoic-edison-8s0vhq` (base `nexora-dev` = `341f3da` +
audit Lot 1 rectifié). Architecture et périmètre : `docs/AUDIT_LOT1_CLOUD.md` § C.3 et § F,
décisions D1–D10 validées.*

## 1. Décisions appliquées

| Décision | Application dans ce lot |
|---|---|
| D2 — règles métier en TypeScript | Les 54 méthodes sont **déplacées sans réécriture** dans `RepositoryCore` ; seules les expressions d'accès au stockage changent (vérifié par diff normalisé, § 6). |
| D4 — hors connexion en lecture seule | `CloudRepository` lit son cache ; avec `DisabledTransport`, toute écriture est refusée et le cache reste intact (testé). |
| D5 — cache distinct par utilisateur | `nexora-cache-<uid>` imposé (`cloudCacheName`, `assertCloudCacheName`) ; `nexora` refusée explicitement. |
| D6 — serveur source de vérité | Le cache n'est modifié **qu'après** acceptation du lot par le transport. |
| D7 — suppressions, versions, récupération | Préparé : chaque écriture produit un `ChangeSet` (état final par clé). Versions / `deleted_at` / pull : Lots 3 à 5. |
| D8 — production en mode local | `useRepository()` instancie toujours `LocalRepository(getDB(), 'local-user')` ; aucun code cloud dans le bundle (vérifié : 0 occurrence dans `dist/`). |
| Atomicité (validée) | `addGoalContribution`, `addDebtPayment`, `updateDebt` : lecture et écriture dans la même transaction. |

Non fait, conformément au périmètre : aucun schéma Supabase exécuté ou modifié, aucune
dépendance Supabase, aucune authentification, aucune synchronisation, aucune sélection
de backend (`VITE_DATA_BACKEND` reste inerte).

## 2. Architecture implémentée

```
UI (pages, features)  ──►  NexoraRepository  (src/data/contracts.ts — 54 méthodes)
                                   ▲
                           RepositoryCore  (src/data/RepositoryCore.ts — règles métier)
                                   │ StoragePort (src/data/storage.ts)
                 ┌─────────────────┴──────────────────┐
        LocalRepository                         CloudRepository  (préparé, non utilisé)
        └ DexieStorage ─► NexoraDB « nexora »    └ CloudStorage ─► cache « nexora-cache-<uid> »
          (délégation directe à Dexie)              │  surcouche de transaction → ChangeSet
                                                    └ CloudTransport
                                                       ├ DisabledTransport (défaut : refuse tout)
                                                       └ MemoryTransport  (tests uniquement)
```

* **`StoragePort`** reprend exactement le sous-ensemble Dexie utilisé (`get`, `add`,
  `put`, `bulkAdd`, `bulkPut`, `delete`, `bulkDelete`, `where(index).equals(v)` →
  `toArray`/`count`/`first`/`delete`/`filter`) et `transaction(tables, fn)`.
* **`DexieStorage`** transmet chaque appel à `NexoraDB` ; `transaction()` ouvre une
  transaction Dexie `'rw'` sur les mêmes tables qu'avant : garanties IndexedDB inchangées.
* **`CloudStorage`** : pendant une transaction, les écritures vont dans une surcouche en
  mémoire, lisibles par la suite de la transaction (mêmes sémantiques que Dexie, y compris
  `ConstraintError` sur `add` d'une clé existante). À la fin, un `ChangeSet` unique est
  soumis au transport ; en cas de succès seulement, il est appliqué au cache dans une
  transaction Dexie. Une écriture isolée forme son propre lot ; un appel imbriqué rejoint
  la transaction englobante.
* **`CloudRepository`** sérialise ses appels publics (une opération à la fois), car la
  surcouche est unique ; les appels internes ne sont pas mis en file.

## 3. Fichiers

| Fichier | Statut | Rôle |
|---|---|---|
| `src/data/contracts.ts` | créé | `NexoraRepository`, `NewEntity`, `BackupFile`, `REPOSITORY_METHODS` (54) |
| `src/data/storage.ts` | créé | `StoragePort`, `TablePort`, `Collection`, `WhereClause` |
| `src/data/tables.ts` | créé | Noms de tables, `USER_TABLES`, `SCHEMA_VERSION`, clés primaires (copie vérifiée par test de `db.ts`, qui n'est pas modifié) |
| `src/data/RepositoryCore.ts` | créé | Règles métier (54 méthodes, extraites de `repository.ts`) |
| `src/data/local/DexieStorage.ts` | créé | Port local Dexie |
| `src/data/cloud/CloudStorage.ts` | créé | Port cloud : cache par utilisateur, surcouche, lots |
| `src/data/cloud/CloudRepository.ts` | créé | Repository cloud (sérialisé, `DisabledTransport` par défaut) |
| `src/data/cloud/transport.ts` | créé | `ChangeSet`, `CloudTransport`, `DisabledTransport`, erreurs |
| `src/data/cloud/MemoryTransport.ts` | créé | Serveur simulé pour les tests (partition par utilisateur, tout ou rien) |
| `src/domain/errors.ts` | créé | `ValidationError` (déplacée, ré-exportée par `repository.ts`) |
| `src/data/contract.test.ts` | créé | 35 tests de conformité |
| `src/data/repository.ts` | modifié | `LocalRepository extends RepositoryCore` sur `DexieStorage` ; ré-exports |
| `src/app/AppContext.tsx` | modifié (types) | `repo: NexoraRepository` ; instanciation locale inchangée |
| `src/pages/Onboarding.tsx` | modifié (types) | prop `repo: NexoraRepository` (import de type uniquement) |
| `docs/LOT2_REPOSITORY.md` | créé | Ce rapport |

**Inchangés (diff vide vérifié)** : `src/data/db.ts`, `src/data/repository.test.ts`,
`src/domain/calc/`, `src/domain/types.ts`, `src/domain/validation.ts`, `src/domain/dates.ts`,
`src/i18n/` (24 langues), `src/components/`, `src/features/`, les autres pages, `supabase/`,
`netlify.toml`, `package.json`, `package-lock.json`, `.env.example`.

## 4. Les 54 méthodes

Les signatures de `NexoraRepository` ont été vérifiées **contre l'ancien `LocalRepository`
avant extraction** (égalité stricte de types, contrôle négatif validé), puis contre
`LocalRepository` et `CloudRepository` après extraction (`contract.test.ts`, vérifié par
`tsc`). `LocalRepository` et `CloudRepository` n'ajoutent ni ne redéfinissent aucune méthode.

Légende : **=** code identique (accès stockage seul modifié) · **A** atomicité corrigée ·
**E** cas d'erreur couverts dans le scénario d'équivalence.

| Groupe | Méthodes | Statut |
|---|---|---|
| Initialisation (4) | `ensureUser`, `getSettings`, `updateSettings`, `snapshot` | = |
| Comptes (4) | `createAccount` E, `updateAccount` E (nom vide, devise verrouillée), `archiveAccount`, `deleteAccount` E (historique, inconnu) | = |
| Catégories (5) | `createCategory` E (nom vide, 2 niveaux), `updateCategory` (propagation), `categoryUsage`, `deleteCategory` E (utilisée), `reorderCategories` | = |
| Transactions (9) | `createTransaction` E (montant, même compte ; transfert simple et multidevise, remboursement), `getTransactionGroup`, `updateTransaction` E (transfert ↔ dépense), `deleteTransactions` (cascades), `recategorize`, `addAttachment` E (format), `getAttachment`, `removeAttachment`, `importTransactions` E | = |
| Budgets (3) | `setBudget` E (multi-mois, mise à jour), `deleteBudget`, `copyBudgets` (avec / sans écrasement) | = |
| Objectifs (3) | `saveGoal` E, `deleteGoal`, `addGoalContribution` E (retrait trop élevé, objectif inconnu) | = sauf `addGoalContribution` **A** |
| Récurrences (9) | `saveRecurringRule` E, `deleteRecurringRule`, `markOccurrencePaid` E (déjà réglée), `linkOccurrence` E (mauvais type, déjà associée), `unlinkTransaction`, `settleOccurrence` E (sans paiement), `reopenOccurrence`, `skipOccurrence`, `resetOccurrence` | = |
| Dettes (5) | `createDebt` E (invalide, devise du compte), `updateDebt` E (principal < remboursé), `deleteDebt`, `addDebtPayment` E (trop élevé, date, devise ; solde → `settled`), `deleteDebtPayment` | = sauf `updateDebt`, `addDebtPayment` **A** |
| Patrimoine et taux (6) | `saveAsset` E (doublon de compte valorisé, nom vide), `deleteAsset`, `addValuation` E, `deleteValuation`, `saveRate` E (même devise, taux nul), `deleteRate` | = |
| Notifications (1) | `setNotificationState` (fusion lu / masqué) | = |
| Sauvegarde (5) | `exportBackup`, `restoreBackup` E (invalide, version plus récente), `replaceWithSnapshot` (démo), `resetToEmpty`, `clearUserData` | = |

**Correction d'atomicité — effet observable** : aucun en usage séquentiel (mêmes
résultats, mêmes messages, même ordre des validations). En cas d'appels concurrents, la
lecture se fait désormais dans la transaction : plus de mise à jour perdue. Seul détail :
dans `addDebtPayment`, l'identifiant du paiement est généré avant les validations (sans
effet sur les données).

## 5. Tests de conformité (`src/data/contract.test.ts`, 35 tests)

| Domaine | Tests | Vérifie |
|---|---|---|
| Surface de l'API | 2 | 54 méthodes uniques, présentes sur les 3 classes, arité identique, signatures égales au contrat (`tsc`), constructeur et `db` de `LocalRepository` conservés |
| Schéma IndexedDB | 2 | `nexora` en version 1, 19 tables et index identiques au schéma publié ; `tables.ts` ≡ `db.ts` |
| Équivalence | 2 | Même scénario (les 54 méthodes appelées — contrôlé —, 38 cas d'erreur) sur les deux repositories avec identifiants et horloge déterministes : journal des résultats et erreurs identique, 11 instantanés identiques, contenu physique base locale ≡ cache cloud table par table ; serveur simulé ≡ cache |
| Refus par défaut | 2 | `DisabledTransport` par défaut ; écritures refusées (`CloudWriteDisabledError`), cache vide ; cache existant lisible et **inchangé** après 6 tentatives d'écriture |
| Échecs et erreurs | 4 | Panne du transport sur 6 opérations composées → `CloudTransportError`, cache et serveur inchangés, reprise ensuite ; erreur métier → aucun lot envoyé ; transfert et suppression en **un seul lot** ; `ConstraintError` sur clé existante (cloud et Dexie) |
| Atomicité | 10 | Panne simulée au milieu de 5 opérations composées (`addGoalContribution`, `addDebtPayment`, `updateTransaction`, `deleteTransactions`, `restoreBackup`), **sur Dexie et sur le cloud** : aucune écriture partielle |
| Mises à jour perdues | 6 | Contributions concurrentes (somme exacte), paiements concurrents (jamais > principal), `updateDebt` concurrent à un paiement (principal ≥ remboursé), sur les deux repositories |
| Isolation | 5 (dont 1 `it.fails`) | Local, même base : u2 ne lit / modifie / supprime rien de u1 ; cloud : caches et partitions séparés, restauration croisée sans effet sur u1 ; ligne forgée pour un autre utilisateur refusée, rien écrit ; cache d'un autre utilisateur refusé |
| Protection `nexora` | 2 | Nommage `nexora-cache-<uid>`, noms invalides et `nexora` refusés ; après usage du mode cloud, `indexedDB.databases()` ne contient pas `nexora` |

**Contrôles par mutation** (code volontairement cassé puis restauré) — chaque régression
est détectée :

| Mutation | Tests en échec |
|---|---|
| Lecture de l'objectif sortie de la transaction (`addGoalContribution`) | contributions concurrentes (local) |
| Lectures sorties de la transaction (`addDebtPayment`, `updateDebt`) | paiements concurrents, `updateDebt` concurrent (local) |
| Cache écrit avant l'envoi au transport | 4 tests (refus par défaut, lecture seule, échec transport, isolation) |
| `DisabledTransport` qui accepte | 2 tests (refus par défaut, lecture seule) |

## 6. Résultats

* `npm run check` : typecheck OK · **13 fichiers, 314 tests, 314 réussis** (279 existants
  + 35 nouveaux ; `repository.test.ts` : 31/31 **sans modification**) · build OK.
* E2E (`e2e/smoke.cjs`, build local servi sur `localhost:4173`, profil Chromium neuf) :
  **11/11**, aucune erreur de page.
* Diff normalisé ancien `LocalRepository` ↔ `RepositoryCore` (après remplacement de
  `this.db.` par `this.t.` et normalisation des appels `transaction`) : seules différences
  = en-tête, imports, déclaration de classe, déplacement de `ValidationError`, fermeture
  de `deleteTransactions`, liste de tables de `restoreBackup` / `clearUserData`, et les
  3 corrections d'atomicité approuvées.

## 7. Garanties : testées localement / à valider avec Supabase

| Garantie | Testée au Lot 2 (fake-indexeddb, MemoryTransport) | À valider plus tard |
|---|---|---|
| Comportement local inchangé | ✅ 31 tests existants, équivalence, e2e | — |
| Atomicité locale (IndexedDB) | ✅ pannes simulées dans des transactions Dexie | — |
| Atomicité cloud | ✅ côté client (surcouche, lot unique, cache après succès) | Lot 4 : `apply_changeset` dans une transaction PostgreSQL |
| Isolation entre utilisateurs | ✅ local (filtre `userId`) ; cloud simulé (partition + contrôle du propriétaire) | Lot 3 : RLS, clés étrangères composites, tests pgTAP |
| Refus des écritures sans backend | ✅ `DisabledTransport` | — |
| Concurrence multi-appareils | 🟡 une seule instance : appels sérialisés | Lots 3–5 : colonnes `version`, conflits, récupération des changements |
| Contraintes de données (CHECK, unicités) | ❌ non applicable | Lot 3 |
| Cache dans un vrai navigateur | 🟡 fake-indexeddb uniquement pour `CloudStorage` | Lot 5 (e2e en mode cloud) |

## 8. Limites techniques

1. **Sérialisation cloud** : la cohérence de `CloudStorage` repose sur une seule
   opération à la fois par instance de `CloudRepository`. Plusieurs onglets ou appareils ne
   sont pas couverts : c'est le rôle des versions serveur (Lots 3–5).
2. **Cache après acceptation** : si le serveur accepte un lot mais que l'écriture du cache
   échoue ensuite (quota, onglet fermé), le cache est en retard jusqu'à la prochaine
   récupération (Lot 5).
3. **`ChangeSet` sans version** : état final par clé, sans contrôle de conflit. Les tables
   `users` et `meta` y figurent : correspondance vers `profiles` à définir au Lot 4.
4. **Port volontairement minimal** : seules les requêtes utilisées existent (`equals` sur
   un index). Les résultats sont triés par clé primaire comme IndexedDB ; `orderBy`, les
   intervalles, etc. ne sont pas implémentés.
5. **`bulkAdd` hors transaction** : Dexie peut insérer partiellement en cas de clé en
   double ; le cloud est tout-ou-rien. Situation inatteignable (identifiants UUID neufs).
6. **Limite préexistante documentée** (`it.fails`) : dans une **même** base locale,
   restaurer chez u2 la sauvegarde de u1 réattribue les lignes de u1 (identifiants
   réutilisés). Inatteignable dans l'application (un seul utilisateur local) ; remappage
   des identifiants prévu au Lot 7. En cloud, caches et partitions séparés : pas d'effet
   (mais la clé primaire globale côté PostgreSQL rendra le remappage nécessaire).
7. **Préexistant, non modifié** : `saveAsset` + valorisation initiale ne sont pas dans une
   même transaction (hors périmètre approuvé).
8. Les déclarations de tables de `transaction()` sont contrôlées par Dexie en local, mais
   ignorées par `CloudStorage` (la surcouche couvre toutes les tables).

## 9. Préservation des données

* Aucune base IndexedDB réelle ouverte : tous les tests utilisent `fake-indexeddb`
  (mémoire, `src/test/setup.ts`) ; l'e2e utilise un profil Chromium neuf sur `localhost`.
  Les données Edge ne sont pas accessibles depuis cet environnement.
* Schéma Dexie `nexora` v1 inchangé (fichier `db.ts` identique, test de schéma) ; aucune
  migration, suppression ni réinitialisation ajoutée ; `LOCAL_USER_ID` et le nom `nexora`
  inchangés pour le mode local.
* Le mode cloud ne peut pas ouvrir `nexora` (refus explicite, testé).
* Aucun changement dans `supabase/`, aucune connexion, aucune dépendance ajoutée.
* Aucun push sur `nexora-dev` ni sur la production ; aucun déploiement Netlify lancé.
