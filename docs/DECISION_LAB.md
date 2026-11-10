# Decision Lab — moteur de simulation (V1)

État : **étape E4** — moteur métier pur (E3) et persistance des simulations (E4), avec leurs tests.
Aucune interface, aucune route, aucune traduction : rien n'est encore utilisé par un écran.

## 1. Fichiers

| Fichier | Rôle |
|---|---|
| `src/domain/calc/decision.ts` | Moteur pur : validation, simulations des 4 décisions, référence, comparateur 2–4 variantes |
| `src/domain/calc/decisionSituation.ts` | Situation initiale (référence) construite en lecture seule à partir des calculs existants |
| `src/domain/calc/decision.oracle.test.ts` | Validation contre l'oracle indépendant `references/decision-lab/` |
| `src/domain/calc/decision.test.ts` | Invariants, cas limites, erreurs de validation, pureté |
| `src/domain/calc/decisionSituation.test.ts` | Périmètres de la situation initiale, comptes exclus, double comptabilisation |
| `references/decision-lab/` | Oracle Python indépendant (E2), voir son `README.md` |
| `src/features/decision/snapshot.ts` | Snapshot figé d'une simulation : création à partir du moteur, validation stricte |
| `src/features/decision/store.ts` | Stockage `sessionStorage` dédié, versionné, limité à 50 simulations |
| `src/features/decision/snapshot.test.ts`, `store.test.ts` | Tests de la persistance (§ 8) |

## 2. Principes

* **Pur et déterministe** : le moteur reçoit des nombres, renvoie de nouveaux objets, n'importe
  aucune couche de données (`@/data`, Dexie, stockage navigateur) — vérifié par test. Une
  simulation ne peut donc pas modifier les données financières réelles.
* **Impact incrémental** : chaque simulation décrit l'écart par rapport à la référence sans
  décision. Trajectoire avec décision = référence + écart (`projectDecision`).
* **Montants** en centimes entiers (devise de base uniquement), **taux** en points de base.
* **Arithmétique exacte** : arrondis faits sur des rationnels exacts (`BigInt`). `money.ts`
  (`roundHalfAwayFromZero`) travaille en flottants et ne garantit pas l'arrondi exact d'un produit
  comme b × 7/1200 ; le taux mensuel effectif (irrationnel) est calculé en virgule fixe à 10⁻⁵⁰
  (erreur < 10⁻²⁵ centime sur les montants V1).

## 3. Conventions (validées, identiques à l'oracle)

| Code | Convention |
|---|---|
| H1 | Taux annuel effectif → taux mensuel i = (1 + R)^(1/12) − 1 |
| H2 | Versements, échéances et assurance en fin de mois |
| H3 | Capital initial placé au mois 0 |
| H4 | Intérêts de chaque mois arrondis au centime, demi vers l'extérieur |
| H5 | Crédit : taux nominal / 12, échéances constantes |
| H6 | Mensualité arrondie au centime ; dernière échéance ajustée au montant réellement dû (voir § 4.2) |
| H7 | Effort d'épargne arrondi au centime supérieur |
| H8 | Objectif : épargne initiale nulle |
| H10 | Horizon et durées ≤ 480 mois |
| H11 | Achat : apport et frais au mois 0, crédit versé au vendeur, bien à l'actif au mois 0 |
| H12 | Référence : trésorerie non dépensée non rémunérée |
| H14 | Dernier versement d'objectif plafonné au montant nécessaire |
| H15 | Après l'atteinte d'un objectif : versements arrêtés, capital conservé sur le compte dédié et rémunéré au taux prévu |

## 4. Décisions et comptabilité

Pour chaque mois m (0 = aujourd'hui) : `flows` (négatif = décaissement), `cumulativeCash` (écart de
trésorerie cumulé), `assets` (actif créé), `liabilities` (dette restante),
`netWorthImpact = assets − liabilities + cumulativeCash`, `netWorthChange`.

| Décision (`kind`) | Trésorerie | Actif | Dette | Effet sur le patrimoine |
|---|---|---|---|---|
| `purchase` (comptant ou financé) | −apport −frais (m0) ; −échéance −assurance | valeur du bien (sans dépréciation) | capital restant dû | −frais (+ valeur − prix) au m0 ; puis −(intérêts + assurance) |
| `recurring` | −montant chaque mois actif | — | — | = trésorerie |
| `goal` (`effort` / `contribution`) | −versements | épargne constituée | — | + intérêts |
| `investment` | −capital (m0) ; −versements | solde du placement | — | + intérêts |

* **Objectif, mode `effort`** : effort minimal au centime supérieur pour atteindre la cible en
  `months` mois. **Mode `contribution`** : versement donné, mois d'atteinte (≤ 480, sinon `null`),
  solde et manque à l'échéance `deadlineMonths`.
* **Comparateur** (`compareDecisions`) : 2 à 4 variantes, même situation, même horizon, même
  référence ; par variante : trajectoire, fin d'horizon, trésorerie la plus basse, premier mois de
  trésorerie négative.

### 4.1 Situation initiale (`buildInitialSituation`)

| Grandeur | Source (existante, non modifiée) | Périmètre |
|---|---|---|
| Trésorerie | `totalBalance` sur `accountsInScope` | comptes non archivés **et** inclus dans les totaux (= Forecast) ; c'est l'argent qui paie les décisions |
| Patrimoine | `computeNetWorth` | tous les comptes (valorisation manuelle si le compte est lié à un actif), actifs valorisés, créances, − dettes |
| Épargne mensuelle de référence | `computeBaseline` sur les opérations des **seuls comptes de trésorerie** | revenus − dépenses, moyenne des 3 derniers mois complets avec données |

* **Comptes exclus** (`perimeter.excludedAccounts`) : motif `archived` ou `notInTotal`, valeur
  comptée dans le patrimoine (`null` si non comptée, ex. compte archivé à solde nul). Ils restent
  dans le patrimoine, jamais dans la trésorerie, et leurs revenus n'alimentent pas l'épargne de
  référence (`monthlySavingsAllAccounts` donne la valeur tous comptes, à titre d'information).
* **Écarts trésorerie / patrimoine** expliqués compte par compte (`cashAccounts[].difference`) :
  `valuation` (compte lié à un actif valorisé), `notYetOpened` (ouverture postérieure) ; total dans
  `cashValuationDifference`.
* **Aucune double comptabilisation** : chaque compte figure une seule fois dans le patrimoine ;
  trésorerie et comptes exclus forment une partition des comptes ; la décomposition
  (`perimeter.netWorth`) retombe exactement sur `computeNetWorth` et la somme des comptes de
  trésorerie sur `totalBalance` — sinon `SituationPerimeterError`. Les objectifs d'épargne sont des
  affectations : jamais ajoutés au patrimoine. Une décision est un **écart** : avec décision =
  référence + écart, donc un bien acheté ou un capital placé n'est jamais compté en plus de la
  trésorerie qui l'a payé.

### 4.2 Crédit : remboursement anticipé par l'arrondi, crédit non amortissable

* Si la mensualité arrondie (H6), capitalisée, couvre le restant dû avant le terme, cette échéance
  est **ajustée au montant réellement dû** et l'échéancier s'arrête (`earlyPayoffMonth`,
  `actualMonths` < `months`). Aucune échéance négative n'est possible. L'assurance s'arrête avec le
  crédit, sauf durée explicite.
* Si la mensualité arrondie ne couvre pas les intérêts du mois (montant minuscule ou crédit très
  long), le crédit n'est pas amortissable : erreur `notAmortizable`.

### 4.3 Objectif après atteinte

Versements arrêtés ; le capital reste sur le compte dédié et produit le rendement prévu (intérêts
arrondis, H4). `reachedMonth` et `balanceAtReach` (mois et solde d'atteinte) sont distincts de
`finalBalance` (solde à l'horizon) et `interestAfterReach` ; `balanceAtDeadline` est le solde réel
à l'échéance, `shortfallAtDeadline` vaut 0 si la cible est atteinte.

## 5. Validation

`validateDecision` / `DecisionInputError` (sous-classe de `ValidationError`) renvoient la liste des
champs fautifs avec des codes stables (à traduire par l'interface) : `notInteger`, `negative`,
`notPositive`, `tooLarge`, `rateOutOfRange`, `exceedsPrice`, `loanRequired`, `loanNotAllowed`,
`required`, `invalidMonth`, `unknownMode`, `unknownKind`, `emptyInvestment`, `variantCount`,
`duplicate`, `notAmortizable`, `resultOutOfRange`.

## 6. Limites V1

* Devise de base uniquement ; pas d'inflation, de fiscalité, de frais de gestion ni de dépréciation.
* Référence linéaire : épargne mensuelle constante, trésorerie non rémunérée (pas de coût
  d'opportunité) ; pas de projection des récurrences ou des dettes existantes.
* Objectif : épargne initiale nulle (H8).
* Référence : l'épargne mensuelle ne tient pas compte des remboursements de principal des dettes
  existantes ni des transferts vers des comptes exclus (opérations neutres dans `summarizePeriod`).
* Le remboursement anticipé par l'arrondi (§ 4.2) n'est déclenché par aucun cas de l'oracle : il
  est couvert par les invariants TypeScript (grille de 125 crédits), pas par l'oracle Python.
* Effort de quelques centimes (taux élevé, horizon long) : l'arrondi supérieur peut atteindre la
  cible quelques mois avant l'échéance demandée.
* Montants limités aux entiers sûrs JavaScript (2^53) : dépassement → `resultOutOfRange`.
* Persistance limitée à l'onglet (`sessionStorage`) : voir § 8.5.

## 7. Tests

* Oracle : `decision.oracle.test.ts` lit les JSON de `references/decision-lab/` et compare ligne à
  ligne (échéancier du crédit, trajectoire 0–60 du cas 1, points de contrôle, G1–G3, échéancier de
  120 mois du cas 2, taux mensuels à 30 décimales, cas 3 effort et versements constants avec solde
  à l'atteinte et rendement après atteinte (H15), grilles).
  Aucune valeur attendue n'est recalculée en TypeScript. Contrôle par mutation : 6 altérations du
  moteur (troncature des intérêts, dernière échéance non ajustée, versement en début de mois,
  versement non plafonné, taux nominal au lieu d'effectif) sont toutes détectées.
* Régénération de l'oracle : `python3 -I references/decision-lab/generate_references.py --check`
  (non exécuté par `npm test`, Python n'étant pas une dépendance du projet).

## 8. Persistance des simulations (E4)

### 8.1 Contrat

* **Stockage dédié** : `sessionStorage`, clé `nexora.decisionLab` (et `nexora.decisionLab.quarantine`).
  Le module n'importe ni la couche de données ni le repository et ne lit aucune autre clé : une
  simulation ne peut modifier ni transactions, ni budgets, ni objectifs. Aucun changement du schéma
  IndexedDB.
* **Durée de vie : l'onglet.** Les simulations **disparaissent à la fermeture de l'onglet** (ou du
  navigateur). Elles ne sont pas partagées entre onglets et ne figurent pas dans les sauvegardes
  JSON : l'interface devra le dire clairement à l'utilisateur.
* **Format versionné** : `{ "formatVersion": 1, "simulations": [DecisionSnapshot…] }`. Les migrations
  futures s'ajoutent dans `MIGRATIONS` (version source → version suivante).
* **Snapshot** (`DecisionSnapshot`) : `id`, `name`, `createdAt` (ISO 8601 UTC), `engineVersion`,
  `hypotheses` (situation initiale réduite à trésorerie / patrimoine / épargne mensuelle, horizon,
  mois de départ, 1 à 4 variantes) et `results` figés : référence (trésorerie et patrimoine, mois 0
  à l'horizon) et, par variante, synthèse, fin d'horizon, trésorerie la plus basse, premier mois
  négatif, séries d'écart de trésorerie et de patrimoine, détails par type (crédit, objectif,
  placement). Un snapshot est **autonome** : il ne contient aucun identifiant de compte, de
  transaction, de budget ou d'objectif.
* **Immutabilité** : un snapshot relu est gelé (copie profonde) ; il n'existe **aucune API de mise
  à jour** ; enregistrer un identifiant déjà présent est refusé (`duplicateId`). Un recalcul passe
  par `createSnapshot`, qui produit un nouvel identifiant : l'ancien snapshot reste intact. Relire
  un snapshot ne relance jamais le moteur (`engineVersion` permet de signaler un écart de version).

### 8.2 Limite de 50 simulations : refus explicite

* Au plus 50 simulations. Lorsque 50 existent déjà, `saveSimulation` **refuse** le nouvel
  enregistrement : `{ ok: false, issue: { code: 'limitReached', limit: 50, count: 50 } }`. Aucune
  simulation existante n'est supprimée automatiquement ; l'interface doit expliquer que la limite
  est atteinte et inviter l'utilisateur à supprimer une simulation (`deleteSimulation`), après quoi
  l'enregistrement redevient possible.
* Un identifiant déjà présent reste refusé en priorité (`duplicateId`).
* Stockage altéré contenant plus de 50 entrées valides : **toutes** sont conservées et lues,
  le dépassement est signalé (`overLimit`, avec la limite et le nombre) et tout nouvel enregistrement
  est refusé (`limitReached`) jusqu'au retour sous la limite par suppressions explicites.
* Liste triée par `createdAt` croissant, puis par `id`.

### 8.3 Validation (lecture et écriture)

`validateSnapshot` s'applique à l'écriture comme à chaque entrée lue : structure exacte (champ
manquant ou inconnu refusé), types, entiers sûrs, dates, mois, longueurs de texte, 1 à 4 variantes
sans doublon, types de décision et champs obligatoires (mêmes règles que le moteur,
`validateDecision`), taille des séries (horizon + 1) et cohérence interne des résultats (synthèse,
fin d'horizon, trésorerie minimale et premier mois négatif recalculés à partir des séries).

### 8.4 Pannes et données invalides

Aucune fonction du store ne lève d'exception ; tout est renvoyé dans le résultat :

| Situation | Lecture | Écriture |
|---|---|---|
| `sessionStorage` absent, accès refusé ou lecture en erreur | vide, `storageUnavailable`, `writable: false` | refusée |
| JSON corrompu / enveloppe invalide | vide, `corruptedJson` / `invalidEnvelope` | autorisée ; le contenu brut est d'abord copié en quarantaine |
| Version plus récente inconnue | vide, `unsupportedVersion`, `writable: false` | **refusée** (ajout, suppression, vidage) : le contenu est préservé |
| Entrées invalides ou en double parmi des valides | valides conservées ; `invalidSnapshot` / `duplicateStoredId` avec la position | autorisée ; contenu brut copié en quarantaine avant réécriture |
| Limite de 50 atteinte | — | refusée : `limitReached` (limite, nombre) ; rien n'est supprimé |
| Plus de 50 entrées (stockage altéré) | toutes conservées ; `overLimit` | ajout refusé (`limitReached`) ; suppression autorisée |
| Quota dépassé, écriture en erreur ou partielle | — | `quotaExceeded` / `writeFailed` ; le contenu précédent est rétabli |

La lecture ne modifie jamais le stockage.

### 8.5 Limites

* **Fermeture de l'onglet** : les simulations disparaissent (`sessionStorage`) ; non partagées entre
  onglets ; absentes des sauvegardes JSON.
* **« Tout supprimer »** (Paramètres, `deleteAll`) appelle `sessionStorage.clear()` : les simulations
  et la quarantaine sont effacées avec les données. Comportement existant, conservé : cohérent avec
  l'intention « tout supprimer ».
* **Restauration d'une sauvegarde** (Paramètres et annulation de restauration) : seules les clés
  `SESSION_KEYS_RESET_ON_RESTORE` (`nexora.tx-filters`, `nexora.analytics`,
  `nexora.analytics.recurringTab`) sont effacées ; les simulations sont **conservées**. Elles restent
  valides car autonomes (aucun identifiant des données restaurées) ; leur situation initiale décrit
  les données au moment de la simulation, pas celles restaurées.
* **Taille** : les échéanciers détaillés ne sont pas stockés (ils se re-dérivent des hypothèses avec
  la même version du moteur). Mesuré : un snapshot au pire cas (4 variantes, 480 mois, montants à
  11 chiffres) occupe 60 841 caractères, soit ≈ 3 millions pour 50. Les quotas de `sessionStorage`
  (≈ 5 Mo par origine, souvent comptés en UTF-16) peuvent donc être atteints avant 50 simulations
  de cette taille : l'enregistrement est alors refusé (`quotaExceeded`), sans perte. Une simulation
  courante (1–2 variantes, 60 mois) est bien plus petite.
* La quarantaine ne conserve que le dernier contenu illisible (une seule clé).
* Deux onglets ne se synchronisent pas (stockage propre à chaque onglet).

### 8.6 Tests

`snapshot.test.ts` (création figée, indépendance, recalcul, 45 cas de données invalides) et
`store.test.ts` (sauvegarde / relecture, limite de 50, corruption, versions, stockage indisponible
ou en erreur, snapshots indépendants, isolation des données réelles). Limite : 50 conservées, 51e
refusée sans perte, enregistrement possible après suppression, stockage altéré à plus de 50 conservé.
Contrôle par mutation, toutes détectées : écrasement d'un doublon, version future inscriptible, pas
de quarantaine, pas de rétablissement après échec, snapshot non gelé, champs inconnus tolérés, limite
non contrôlée, limite à 49, troncature à la lecture, quarantaine déclenchée par le seul dépassement.
