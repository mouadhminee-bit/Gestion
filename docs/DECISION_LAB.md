# Decision Lab — moteur de simulation (V1)

État : **étape E3** — moteur métier pur et tests. Aucune interface, aucun stockage, aucune route :
le moteur n'est encore utilisé par aucun écran.

## 1. Fichiers

| Fichier | Rôle |
|---|---|
| `src/domain/calc/decision.ts` | Moteur pur : validation, simulations des 4 décisions, référence, comparateur 2–4 variantes |
| `src/domain/calc/decisionSituation.ts` | Situation initiale (référence) construite en lecture seule à partir des calculs existants |
| `src/domain/calc/decision.oracle.test.ts` | Validation contre l'oracle indépendant `references/decision-lab/` |
| `src/domain/calc/decision.test.ts` | Invariants, cas limites, erreurs de validation, pureté |
| `src/domain/calc/decisionSituation.test.ts` | Périmètres de la situation initiale, comptes exclus, double comptabilisation |
| `references/decision-lab/` | Oracle Python indépendant (E2), voir son `README.md` |

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
* Les résultats ne sont pas encore persistés (snapshots en `sessionStorage` : étape ultérieure) ;
  `engineVersion` est fourni pour les futurs snapshots.

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
