# NEXORA — Sauvegarde et restauration JSON (v2)

Ce document décrit le format des sauvegardes, les migrations, les validations, les
erreurs possibles et les garanties d'atomicité. Code : `src/data/backup/`,
`RepositoryCore.exportBackup / restoreBackup`, `src/pages/Settings.tsx`,
`src/app/uiState.ts`.

## 1. Format des fichiers

```json
{
  "app": "nexora",
  "formatVersion": 2,
  "schemaVersion": 1,
  "exportedAt": "2026-11-01T18:22:14.000Z",
  "data": {
    "settings": [ { … } ],
    "accounts": [ … ], "categories": [ … ], "transactions": [ … ],
    "budgets": [ … ], "goals": [ … ], "goalContributions": [ … ],
    "recurringRules": [ … ], "occurrences": [ … ], "debts": [ … ],
    "debtPayments": [ … ], "assets": [ … ], "valuations": [ … ], "rates": [ … ],
    "notificationStates": [ … ], "importBatches": [ … ],
    "attachments": [ { "id", "name", "mimeType", "size", "createdAt", "data": "<base64>" } ]
  }
}
```

| Champ | Rôle |
|---|---|
| `formatVersion` | Version du **format de fichier** (enveloppe, tables, encodage). Absent = v1. |
| `schemaVersion` | Version du **schéma de données** (IndexedDB, `db.ts`). Actuellement 1. |

| Version | Contenu | Statut |
|---|---|---|
| v1 | 16 tables utilisateur, **sans** pièces jointes, pas de `formatVersion` | Lu (migré vers v2) |
| v2 | 16 tables + `attachments` (contenu en base64), paramètres complets | Produit et lu |

Les tables `users` et `meta` ne sont pas sauvegardées (profil local et version du
schéma, recréés par l'application). `userId` est réécrit à la restauration : une
sauvegarde est toujours restaurée **pour l'utilisateur courant**.

## 2. Déroulement d'une restauration

| Phase | Où | Écritures |
|---|---|---|
| **A. Prévalidation** : lecture du JSON, `migrateBackup`, `validateBackup('full')` | `prepareBackup` | aucune |
| **B. Préparation** : sauvegarde de sécurité de l'état actuel (`exportBackup`), **vérifiée par relecture** (JSON reparsé, structure valide, mêmes volumes) ; aperçu des volumes actuel / fichier par table, migration, avertissements ; confirmation explicite | `planRestore` + `RestorePreview` | aucune |
| **C. Application** : téléchargement de la sauvegarde de sécurité, puis `restoreBackup` (rejoue A), transaction unique, contrôle des volumes, puis réinitialisation de l'interface | `RepositoryCore.restoreBackup`, `Settings.restore` | transaction atomique |

Aucune donnée existante n'est supprimée avant la réussite complète de A. `restoreBackup`
rejoue toujours A, quel que soit l'appelant (démo, tests, interface).

### Garanties d'atomicité (phase C)

Une seule transaction couvre les 16 tables et `attachments` : effacement des lignes de
l'utilisateur, écriture, conservation éventuelle des pièces jointes (§ 5), puis **contrôle
après écriture** (nombre de lignes par table = nombre attendu). Toute erreur, y compris un
écart de volume (`RestoreVerificationError`), annule la transaction : l'état d'origine
reste intact.
- Local : transaction Dexie `rw` (IndexedDB).
- Cloud (`CloudRepository`, non branché dans l'application) : un seul `ChangeSet` ; en
  cas d'échec, ni le cache ni le serveur ne sont modifiés (protocole v1).

La sauvegarde de sécurité est téléchargée **avant** l'application. Le navigateur ne
permet pas de vérifier qu'elle a été enregistrée sur le disque : seule sa validité (avant
téléchargement) est garantie.

## 3. Migrations (`migrateBackup`)

1. Identification : `app === "nexora"`, `formatVersion` entier ≥ 1 (ou absent = v1),
   `schemaVersion` entier ≥ 1. Version future (`formatVersion > 2` ou
   `schemaVersion > 1`) : refus `newer`. Valeur non entière ou absente : refus `badVersion`.
2. Étapes appliquées dans l'ordre, uniquement si nécessaires :
   - **v1 → v2** : ajout de `attachments: []`, car le format v1 n'exportait pas les pièces
     jointes. Ce n'est pas une table « remplacée par [] » : son absence est la définition
     même du format v1. Un fichier v1 qui contiendrait une table `attachments` est refusé.
3. Paramètres : les champs **absents** de la ligne `settings` sont complétés par
   `defaultSettings` (locale déduite de la langue ; `onboarded = true`, car une
   sauvegarde provient d'un espace configuré). Les champs complétés sont tracés
   (`report.filledSettings`) et affichés dans l'aperçu. Une valeur **présente mais
   invalide** n'est jamais corrigée : elle est refusée par la validation.
4. Les données métier ne sont jamais modifiées. Le fichier d'entrée n'est pas modifié.

Traçabilité : `MigrationReport { fromVersion, toVersion, steps, filledSettings }`.

Ajouter une version : incrémenter `BACKUP_FORMAT_VERSION`, ajouter `STEPS[n]`
(n → n + 1), étendre les tests « 14 » et « 15 ».

## 4. Validations (`validateBackup`)

**Structure** (vérifiée aussi sur la sauvegarde de sécurité) :
- `data` est un objet ;
- les 17 tables sont présentes, aucune table inconnue, chaque table est un tableau ;
- chaque ligne est un objet ;
- identifiant présent (chaîne non vide) et unique par table ;
- exactement une ligne de paramètres.

**Contenu** (`full`), selon `src/data/backup/schema.ts` :
- types des champs essentiels :
  - montants : entiers sûrs, en unités mineures ;
  - dates : `AAAA-MM-JJ` réelles ; mois : `AAAA-MM` ;
  - devises : 3 lettres majuscules ;
  - énumérations fermées, booléens, listes ;
- paramètres complets : langue connue, locale non vide ;
- identifiant d'échéance = `<ruleId>:<dueDate>` ;
- taux de change strictement positif ;
- transferts : `transferId` et `counterpartAccountId` renseignés, exactement 2 jambes ;
- pièces jointes : base64 valide, taille décodée = `size` ≤ 5 Mo.

**Relations.** Les références bloquantes (refus) sont celles dont l'intégrité est garantie
par l'application :

| Référence | Cible |
|---|---|
| `transactions.accountId`, `counterpartAccountId` | comptes |
| `transactions.categoryId`, `subcategoryId` | catégories |
| `categories.parentId` | catégories |
| `budgets.categoryId` | catégories |
| `recurringRules.categoryId` | catégories |
| `goalContributions.goalId` | objectifs |
| `occurrences.ruleId` | règles récurrentes |
| `debtPayments.debtId` | dettes |
| `valuations.assetId` | actifs |

Les liens historiques donnent un **avertissement** non bloquant. Ils peuvent viser une
ligne supprimée par l'application elle-même (ex. `deleteAccount` ne contrôle que les
transactions) ; ils sont restaurés tels quels, jamais réécrits :

| Référence | Cible |
|---|---|
| `recurringRules.accountId`, `subcategoryId` | compte, catégorie |
| `transactions.refundOfId`, `debtId`, `debtPaymentId`, `recurringRuleId`, `importBatchId`, `attachmentId` | lignes liées |
| `occurrences.transactionId` | transaction |
| `debts.originTransactionId` | transaction |
| `debtPayments.accountId`, `transactionId` | compte, transaction |
| `goals.linkedAccountId`, `assets.linkedAccountId` | compte |
| `importBatches.accountId` | compte |

Aucun identifiant n'est inventé ni remplacé. Le remappage entre utilisateurs (R1) reste
au Lot 7.

### Erreurs possibles

| Classe | Code / cause | Effet |
|---|---|---|
| `BackupValidationError` | `notNexora`, `badVersion`, `newer`, `badData`, `missingTable`, `unknownTable`, `notArray`, `badRow`, `missingId`, `duplicateId`, `settingsCount`, `badField`, `orphan` (bloquant), `transferPair` | Refus avant toute écriture. Message : nombre de problèmes et 5 premiers détails (`issues` complet). |
| `SafetyBackupError` | Sauvegarde de sécurité impossible à produire ou à relire | Refus avant toute écriture. |
| `RestoreVerificationError` | Volume écrit ≠ volume attendu | Transaction annulée, état d'origine intact. |
| Erreur de stockage (quota, panne) | — | Transaction annulée, état d'origine intact. |
| `SyntaxError` (interface) | JSON illisible | Message « Fichier JSON illisible ». |

Les avertissements (`orphan` non bloquant, `attachmentMissing`) sont listés dans l'aperçu.

## 5. Pièces jointes

- Export : contenu encodé en base64 dans `data.attachments`, soit environ +33 % de la
  taille du fichier. `data: null` si le contenu n'était pas disponible à l'export.
- Restauration : contenu décodé (`Blob`, type MIME d'origine) et validé (taille, base64).
- **Conservation** : une pièce jointe référencée par une transaction restaurée, mais
  absente du fichier (fichier v1, ou `data: null`), est **conservée** si une copie locale
  existe. Les autres pièces jointes actuelles sont remplacées ; elles figurent dans la
  sauvegarde de sécurité téléchargée en phase C.
- Limites : 5 Mo par pièce jointe (comme `addAttachment`) ; fichier de sauvegarde
  ≤ 100 Mo dans l'interface (lecture et analyse en mémoire).
- **Cloud — comportement actuel (constat de revue, A1)** : le fichier est bien restauré dans
  le cache local (`nexora-cache-<uid>`). En revanche, le protocole `ChangeSet` de l'étape 4.3
  transmet la **ligne complète** au transport : avec `MemoryTransport` (serveur simulé, seul
  transport existant), le `blob` des pièces jointes est **également transmis et stocké**.
  Ce comportement préexiste au correctif v2 (`addAttachment` fait de même). Le mapping
  (`cloud/mapping.ts`) déclare `attachments.blob` comme champ local et fournit
  `toCloudRow()` pour le retirer, mais **aucun transport ne l'applique encore**.
  - Exigence pour le futur transport HTTP (Lots 4.5 / 4.6, non commencés) : appliquer
    `toCloudRow()` / `serializeRow()` à chaque ligne avant l'envoi, afin que le fichier ne
    quitte jamais l'appareil. Le stockage distant des fichiers est prévu au Lot 7.
  - Aucun effet en mode local (seul mode utilisé par l'application).
- **Mécanisme complémentaire proposé, non implémenté** : pour de gros volumes, une
  archive (ZIP : `backup.json` + fichiers binaires) éviterait le surcoût base64 et le
  chargement intégral en mémoire.

## 6. Interface après restauration

`src/app/uiState.ts`, appelé après une restauration, une réinitialisation de la démo ou
un démarrage à vide :
- effacement de `nexora.tx-filters`, `nexora.analytics`, `nexora.analytics.recurringTab`
  (sessionStorage) et de `nexora.lastAccount` (localStorage) ;
- mois affiché (`nexora.month` et contexte React) :
  - le mois courant s'il contient des opérations restaurées ;
  - sinon le mois de la dernière opération passée.

Filet permanent : `dropUnknownIds` ignore, sur les pages Transactions et Analyses, un
filtre visant un compte ou une catégorie inexistant.

L'instantané (`useLiveQuery`) est relu dès la validation de la transaction ; les KPI,
soldes et graphiques sont recalculés à partir de lui.

Robustesse :
- `normalizeSettings` (en mémoire, base inchangée) remplace par défaut un paramètre
  absent ou mal typé ;
- un `ErrorBoundary` global entoure `AppProvider` et `AppShell` : une donnée inattendue
  affiche un écran d'erreur, plus une page blanche.

### 6.1 Annulation immédiate (atténuation de P18)

Code : `src/data/backup/undo.ts` (logique), `src/features/backup/RestoreUndo.tsx`
(bandeau et action), `Settings.restore`.

**Fonctionnement.**
- Après une restauration réussie, la sauvegarde de sécurité (JSON déjà vérifié en phase B)
  est conservée **en mémoire**, dans un emplacement unique (`undoStore`).
- Un bandeau « Annuler la restauration » s'affiche sur toutes les pages, et le message de
  réussite propose la même action.
- L'annulation, après confirmation, rétablit l'état précédent par `restoreBackup` : même
  validation complète, même transaction unique, même contrôle des volumes. L'interface
  est réinitialisée comme après une restauration.
- Elle fonctionne même si le navigateur a ignoré le téléchargement du fichier de sécurité.

**Garanties (testées en local et en cloud).**
- Retour **exact** à l'état précédent : toutes les tables, pièces jointes comprises
  (octets identiques). Contrôle final par empreinte du contenu (`verified`) ; un écart
  serait signalé par un avertissement.
- Échec de l'annulation (quota de stockage dépassé, panne sur n'importe quelle table) :
  transaction annulée, **données restaurées inchangées**, emplacement **conservé**,
  nouvel essai possible ; message d'erreur explicite.
- Modification faite depuis la restauration : détectée par empreinte et signalée
  **avant** confirmation (« elle sera perdue »). Si l'état actuel est illisible, la
  modification est présumée et l'avertissement est affiché.
- Une seule annulation à la fois (bandeau et message ne peuvent pas la lancer deux fois).

**Limites (assumées et documentées).**

| Limite | Conséquence | Recours |
|---|---|---|
| Mémoire de l'onglet uniquement | Perdue au rechargement, à la fermeture, en cas de plantage de l'onglet ou du navigateur, ou si le système libère l'onglet (mobile) | Fichier de sécurité téléchargé |
| Une seule restauration | Seule la **dernière** restauration est annulable ; une nouvelle restauration remplace l'emplacement | Fichiers de sécurité successifs |
| Autres remplacements | Réinitialisation de la démo, démarrage à vide et suppression totale **effacent** l'emplacement | — |
| État précédent incohérent | Si l'état actuel ne passe pas la validation **complète** (ex. relation bloquante écrite hors application), l'annulation immédiate est **indisponible** ; l'aperçu le signale avant confirmation | Fichier de sécurité (validé structurellement) |
| Autres onglets | L'emplacement est propre à l'onglet ; une modification faite dans un autre onglet pendant l'aperçu n'est pas dans la sauvegarde de sécurité | Un seul onglet ouvert pendant une restauration |
| Quota | L'annulation réécrit un volume comparable à l'état précédent ; si le quota est atteint, elle échoue sans dommage | Libérer de l'espace, réessayer |
| Mémoire vive | Le JSON de sécurité (jusqu'à ~100 Mo avec pièces jointes) reste en mémoire jusqu'à l'annulation ou au rechargement ; pas de bouton « fermer », pour éviter une perte par mégarde | Recharger la page libère la mémoire |
| Changement de langue juste après restauration | L'action du message de réussite peut ne plus répondre (arbre remonté) ; le bandeau reste opérationnel | Utiliser le bandeau |

## 7. Différences LocalRepository / CloudRepository

Même code (`RepositoryCore`) : mêmes validations, migrations et contrôles, testés sur les
deux implémentations.

| | Local | Cloud |
|---|---|---|
| Transaction | Dexie `rw` | un `ChangeSet` (tout ou rien, cache et serveur) |
| Pièces jointes | fichier stocké localement | fichier dans le cache ; **le serveur simulé reçoit aussi le blob** (ligne complète, § 5) ; le filtrage `toCloudRow()` devra être appliqué par le futur transport HTTP |
| Liens historiques orphelins (avertissements) | restaurés tels quels | `MemoryTransport` les accepte ; **le schéma PostgreSQL les refuserait** (clés étrangères différées, sauf `attachment_id`) : la restauration serait rejetée en bloc (voir P16) |
| Utilisation dans l'application | oui | non (préparé) |

## 8. Tests

| Fichier | Contenu |
|---|---|
| `src/data/backup/backup.test.ts` | 25 scénarios × {Local, Cloud}, plus le codec base64 |
| `src/data/backup/historicalV1.test.ts` | Sauvegarde V1 historique du 31/10/2026 (fixture fictive) : format exact, migration, conservation intégrale champ par champ, KPI, pièces jointes, Local et Cloud |
| `src/data/backup/undo.test.ts` | Annulation immédiate : retour exact, modification intercurrente, quota, panne par table, disponibilité, Local et Cloud |
| `src/app/restoreUi.test.ts` | Pages Transactions et Paramètres réelles, jsdom ; bandeau d'annulation (téléchargement ignoré, avertissement, échec puis nouvel essai) |
| `src/app/uiState.test.ts` | Mois, filtres, effacement des états |
| `e2e/backup.cjs` | Profil Chromium temporaire, données fictives : export, refus, aperçu, sécurité, restauration, annulation, persistance, fixture V1 |

Données toujours fictives, bases fake-indexeddb isolées.

### Fixture historique V1 (31/10/2026)

- `src/data/backup/__fixtures__/backup-v1-2026-10-31.json` : sauvegarde V1 **fictive**
  produite par le code exact du 31/10/2026 (commit `341f3da` ; le code de données est
  identique de `27defa5` à `341f3da`). 16 tables, 461 lignes, couvrant tous les cas
  historiques (liste dans le générateur).
- `…local-attachments.json` : pièce jointe présente dans la base au moment de l'export
  (non incluse en V1), pour simuler la base locale existante.
- Générateur : `scripts/fixtures/backup-v1-2026-10-31/generate.sh` (exécute
  `generate.test.ts` dans une copie temporaire du commit historique, fake-indexeddb).
- Les UUID et horodatages changent à chaque génération : la fixture versionnée fait
  référence ; son empreinte SHA-256 est vérifiée par `historicalV1.test.ts`.
- Aucune donnée personnelle, aucun fichier réel.

