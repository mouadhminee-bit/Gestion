# Decision Lab — moteur de simulation (V1)

État : **étape E5.5** — moteur métier pur (E3), persistance des simulations (E4), page « Mes
simulations » (E5.1), situation financière initiale (E5.2), formulaires de décision (E5.3),
exécution, résultats, trajectoires et enregistrement des simulations (E5.4) et comparateur
multi-variantes (E5.5).

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
| `src/pages/DecisionLab.tsx`, `DecisionLab.test.ts` | Page « Mes simulations » et ses tests (§ 9) |
| `src/features/decision/situationDraft.ts` | Validation pure du brouillon de situation initiale (§ 10) |
| `src/features/decision/SituationCard.tsx` | Carte « Situation initiale » : affichage, saisie, erreurs (§ 10) |
| `src/features/decision/situationDraft.test.ts`, `SituationCard.test.ts` | Tests de la situation initiale (§ 10) |
| `src/features/decision/decisionDraft.ts` | Formulaires de décision : champs, lecture des saisies, entrée du moteur (§ 11) |
| `src/features/decision/DecisionBuilder.tsx` | Carte « Nouvelle décision » : choix du mode (§ 13), du type, formulaire réutilisable `DecisionForm`, récapitulatif (§ 11) |
| `src/features/decision/decisionDraft.test.ts`, `DecisionBuilder.test.ts` | Tests des formulaires (§ 11) |
| `src/features/decision/simulationRun.ts` | Exécution : horizon, moteur, snapshot ; séries et avertissements lus dans le snapshot (§ 12) |
| `src/features/decision/SimulationPanel.tsx` | Carte « Simulation » : horizon, exécution, enregistrement (§ 12) |
| `src/features/decision/SimulationResults.tsx` | Résultats : indicateurs, trajectoires, lecture factuelle, limites (§ 12) |
| `src/features/decision/simulationRun.test.ts`, `SimulationPanel.test.ts` | Tests de l'exécution et du parcours complet (§ 12) |
| `src/features/decision/comparisonRun.ts` | Comparateur : exécution des variantes, indicateurs et écarts « variante − A » lus dans le snapshot (§ 13) |
| `src/features/decision/ComparisonBuilder.tsx` | Saisie d'une comparaison : type commun, 2 à 4 variantes nommées et validées (§ 13) |
| `src/features/decision/ComparisonPanel.tsx` | Carte « Comparaison » : nom, horizon commun, exécution, enregistrement (§ 13) |
| `src/features/decision/ComparisonResults.tsx` | Résultats comparés : synthèse, indicateurs, écarts, trajectoires, limites (§ 13) |
| `src/features/decision/comparisonRun.test.ts`, `ComparisonPanel.test.ts` | Tests du comparateur (§ 13) |

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

## 9. Interface — étape E5.1 : « Mes simulations »

* **Navigation** : entrée « Decision Lab » (`src/app/nav.ts`) dans le groupe Intelligence, juste
  après Prévisions. Les trois premières positions de `NAV` sont inchangées : la barre mobile
  (construite par position dans `AppShell`) n'est pas décalée ; l'entrée apparaît dans « Plus ».
* **Route** : `/decision-lab`, page `src/pages/DecisionLab.tsx` chargée à la demande (`lazy`).
* **Page** : lit `loadSimulations()` et affiche les snapshots tels quels, du plus récent au plus
  ancien — aucun recalcul, aucune lecture ni écriture des données financières réelles.
  * avertissement permanent : simulations conservées dans l'onglet uniquement ;
  * état vide ; compteur `n / 50` ;
  * par simulation : nom, date de création, horizon, mois de départ, nombre de variantes ;
    « Détails » : **hypothèses uniquement** — situation initiale (trésorerie, patrimoine, épargne
    mensuelle de référence) et liste des variantes avec leur type de décision ; badge si le
    snapshot provient d'une autre version du moteur. Aucun indicateur de résultat n'est affiché
    (écarts, trésorerie minimale, premier mois négatif) : ils seront présentés, avec leur contexte,
    par l'écran de résultats (E5.4). Les résultats restent stockés dans les snapshots ;
  * suppression avec confirmation (`deleteSimulation`) ; en cas d'échec, message d'erreur et liste
    relue depuis le stockage ;
  * messages correspondant aux résultats du store : limite atteinte (aucune suppression
    automatique), dépassement (`overLimit`), stockage indisponible, version plus récente, contenu
    illisible, entrées ignorées (nombre). Afficher la page ne modifie jamais le stockage.
* **Traductions** : 32 clés (`nav.decisionLab` et `dl.*`) dans les 24 langues. Parité exacte et
  variables vérifiées par `src/i18n/i18n.test.ts` ; `DecisionLab.test.ts` vérifie en plus que
  chaque clé utilisée par la page existe dans les 24 langues, sans figer leur nombre (les étapes
  suivantes ajouteront leurs clés). Traductions produites par IA, **non relues par des locuteurs
  natifs** (comme le reste de l'application) ; l'arabe et l'anglais ont fait l'objet d'une
  vérification ciblée non native. « Decision Lab » est conservé tel quel dans toutes les langues.
  Montants isolés par `<bdi>` pour les langues RTL.
* **Tests** (`DecisionLab.test.ts`, jsdom) : position dans la navigation, route réelle de
  l'application et chargement différé, liste vide, liste remplie, consultation (hypothèses
  seules, aucun indicateur de résultat), suppression (annulation, confirmation, échec
  d'écriture), limite atteinte, dépassement, stockage indisponible, entrées invalides, contenu
  corrompu, version plus récente, clés de traduction utilisées.
* **Contrôle visuel** (Chromium, hors suite de tests) : he, fa, ar, de, ru, zh, ja, hi ; 390 et
  1440 px ; thèmes clair et sombre ; liste avec nom long, Détails ouvert, limite atteinte —
  96 captures, aucun débordement, aucune troncature, compteur « n / 50 » dans le bon ordre en
  RTL, aucune erreur console.
* **Non développé à cette étape** : création d'une simulation (formulaires de décision), écran de
  résultats détaillé, graphiques, comparateur.

## 10. Interface — étape E5.2 : situation financière initiale

### 10.1 Modèle

Aucun modèle nouveau : la situation est exactement `InitialSituation` du moteur (§ 4.1), soit trois
montants en centimes entiers de la devise de base.

| Champ | Sens | Obligatoire | Zéro | Négatif | Limite |
|---|---|---|---|---|---|
| `cash` — Trésorerie | argent disponible aujourd'hui sur les comptes du périmètre | oui | admis | admis (découvert) | celle du moteur |
| `netWorth` — Patrimoine net | tout ce qui est possédé moins les dettes | oui | admis | admis | celle du moteur |
| `monthlySavings` — Épargne mensuelle | revenus − dépenses, par mois | oui | admis | admis | celle du moteur |

* **Valeur initiale** : celle calculée en lecture seule par `buildInitialSituation` à partir des
  données de l'utilisateur (aucune valeur par défaut inventée). Si ce calcul est impossible
  (périmètre incohérent), un message l'indique et les trois montants doivent être saisis.
* **Limite** : la seule borne est celle du moteur — la situation doit rester simulable sur
  l'horizon maximal (`referenceTrajectory` sur 480 mois sans dépasser les entiers sûrs). Elle est
  vérifiée en appelant le moteur, sans la recopier.
* **Aucun calcul financier dans l'interface** : la saisie est convertie en centimes par
  `MoneyInput` / `parseAmount` (sans flottant) ; la validation est dans `situationDraft.ts`.

### 10.2 Validation (`validateSituationDraft`)

| Code | Cas | Message (clé) |
|---|---|---|
| `required` | champ vide | `dl.situation.err.required` |
| `invalid` | saisie non interprétable (« 1,2,3 », « - »), valeur non entière ou hors entiers sûrs | `dl.situation.err.invalid` |
| `tooLarge` | situation non simulable sur 480 mois ; attribuée par le moteur à l'épargne, sinon au solde concerné | `dl.situation.err.tooLarge` |

Une valeur invalide n'est jamais corrigée ni effacée : la saisie reste visible, l'erreur s'affiche
sous le champ (dès la sortie du champ pour une saisie non interprétable, sinon à la validation) et
rien n'est retenu. `tooLarge` n'est évalué que lorsque les trois montants sont interprétables.

### 10.3 Parcours

Carte « Situation initiale » en tête de la page Decision Lab :

* **Affichage** : les trois montants avec leur explication et la devise ; badge « Calculée à partir
  de vos données » ou « Ajustée manuellement » ; badge « données de démonstration » tant que les
  valeurs calculées proviennent du jeu de démonstration ; notes de calcul (mois complets utilisés
  pour l'épargne, ou avertissement si aucun ; comptes non comptés dans la trésorerie ; montants
  non convertis).
* **Modifier** : formulaire de trois champs obligatoires, préremplis ; **Valider la situation** ou
  **Annuler** ; **Revenir aux valeurs calculées** après un ajustement. Valider des valeurs
  identiques aux valeurs calculées n'est pas une modification.

### 10.4 Persistance et sécurité

* La situation ajustée est **temporaire** : elle vit dans l'état de la page et disparaît à la
  navigation ou au rechargement (les valeurs calculées sont alors réaffichées). Elle sera figée
  dans un snapshot à la création d'une simulation (`createSnapshot`, étape suivante), sans
  évolution du contrat E4.
* Rien n'est écrit : ni comptes, ni opérations, ni budgets, ni objectifs, ni base IndexedDB, ni
  `sessionStorage` / `localStorage` (vérifié par test).

### 10.5 Traductions et tests

* 18 clés `dl.situation.*` ajoutées dans les 24 langues (produites par IA, non relues par des
  locuteurs natifs).
* `situationDraft.test.ts` : valeurs valides, zéro, négatives, champs manquants, valeurs non
  entières, hors limites, précision au centime, cohérence avec le moteur et les snapshots.
* `SituationCard.test.ts` (jsdom, horloge figée) : valeurs calculées et périmètre, démonstration,
  montants non convertis, saisie valide, précision, champ vide, saisie non interprétable conservée,
  hors limites, annulation, retour aux valeurs calculées, calcul impossible, arabe (RTL), absence
  d'écriture dans les données et les stockages.

## 11. Interface — étape E5.3 : formulaires de décision

### 11.1 Champs (contrat du moteur, § 4)

Les clés des champs sont les chemins d'erreur du moteur : une erreur de `validateDecision`
s'affiche directement sous le champ concerné. * = obligatoire.

| Type | Champs |
|---|---|
| Achat (`purchase`) | prix*, apport*, frais initiaux*, valeur du bien (vide : le prix) ; interrupteur « Financé par un crédit » → taux nominal annuel* (%), durée du crédit* (mois) ; assurance mensuelle, durée de l'assurance (vide : durée du crédit) |
| Dépense récurrente (`recurring`) | montant mensuel*, premier mois (vide : 1), nombre de mois (vide : jusqu'à l'horizon) |
| Objectif (`goal`) | méthode « délai fixé » (`effort`) : cible*, rendement effectif annuel* (%), délai* (mois) ; « versement fixé » (`contribution`) : cible*, rendement*, versement mensuel*, échéance souhaitée (facultative) |
| Placement (`investment`) | capital initial*, versement mensuel*, nombre de versements (vide : jusqu'à l'horizon), rendement effectif annuel* (%) |

Aucune valeur par défaut n'est inventée : les champs obligatoires partent vides ; un champ
facultatif vide est **omis** de l'entrée (le moteur applique sa valeur par défaut documentée).

### 11.2 Lecture des saisies et validation (`buildDecision`)

1. **Lecture** (interface) : montants en centimes par `MoneyInput` (`allowNegative` : un négatif
   n'est jamais converti en positif, `keepInvalidText` : une saisie non interprétable reste
   visible) ; taux en % avec deux décimales au plus, convertis en points de base par lecture des
   chiffres (7,25 % → 725 bp, sans virgule flottante) ; durées en mois entiers. Champ obligatoire
   vide → `required` ; saisie non interprétable → `invalid`.
2. **Règles du moteur**, une fois tous les champs lisibles : `validateDecision` avec l'horizon
   maximal (480 mois), l'horizon de la simulation n'étant pas encore choisi. Bornes (taux 0–30 %,
   durées ≤ 480 mois), zéro et négatifs, apport / crédit / assurance : codes du moteur inchangés.
3. **Faisabilité** : `simulateDecision` sur un mois — crédit non amortissable (`notAmortizable`),
   montants non représentables (`resultOutOfRange`, erreur globale du formulaire).

Résultat : une entrée **exactement** du type du moteur (`PurchaseDecision`,
`RecurringExpenseDecision`, `SavingsGoalDecision`, `InvestmentDecision`), sans champ supplémentaire.

### 11.3 Parcours

Carte « Nouvelle décision » sous la situation initiale : choix parmi les quatre types →
formulaire → « Valider les hypothèses » → récapitulatif « Hypothèses valides » (les saisies,
aucun résultat) → « Modifier » rouvre le formulaire avec les mêmes saisies. « Changer de type »
revient au choix ; les brouillons des quatre types sont conservés pendant la visite de la page.
L'entrée validée est transmise par `onValidated` à la page, qui affiche la carte « Simulation »
(§ 12).

### 11.4 Limites

* `resultOutOfRange` n'est vérifié que sur un mois : un dépassement qui n'apparaîtrait qu'à un
  horizon plus long est signalé à l'exécution, sur l'horizon réel (§ 12.1).
* Les brouillons ne sont pas conservés après la navigation ou le rechargement (aucune persistance
  supplémentaire).
* 58 clés `dl.form.*`, `dl.f.*`, `dl.err.*` dans les 24 langues, produites par IA, non relues par
  des locuteurs natifs.

## 12. Interface — étape E5.4 : résultats et trajectoires

### 12.1 Horizon et exécution (`runSimulation`)

* L'**horizon** est saisi par l'utilisateur, en mois entiers, sans valeur imposée : aucune valeur par
  défaut n'est justifiée par le contrat. Bornes : celles du moteur (1 à 480 mois, `validateDecision`
  avec l'horizon réel). Le mois 0 est le mois en cours (`startMonth`).
* Exécution : `createSnapshot` (moteur E3, contrat E4) avec la situation retenue (E5.2), la décision
  validée (E5.3) et l'**horizon réel** ; `simulateDecision` sur le même horizon pour le détail
  mensuel affiché. Un scénario qui échoue sur son horizon réel est **refusé** (erreur bloquante :
  `resultOutOfRange`, horizon hors bornes, situation manquante) ; il n'est jamais validé sur un
  autre horizon.
* **Erreurs bloquantes** (aucun résultat) : nom, horizon, situation, échec du moteur.
  **Avertissements** (résultat affiché) : trésorerie négative, objectif non atteint, atteint après
  l'horizon ou après l'échéance souhaitée. **Notes** : crédit au-delà de l'horizon, remboursement
  anticipé par l'arrondi.

### 12.2 Résultats (lus dans le snapshot, aucun calcul)

* Communs : trésorerie et patrimoine net — au départ (situation initiale), fin d'horizon avec et
  sans la décision, écart dû à la décision ; trésorerie la plus basse et son mois ; premier mois de
  trésorerie négative.
* Par type, uniquement ce que fournit le moteur : **achat** — mensualité, dernière échéance, nombre
  d'échéances, intérêts, total remboursé ; **objectif** — versement, mois d'atteinte, dernier
  versement, total versé, intérêts, solde et manque à l'échéance, solde final ; **placement** —
  valeur finale, total investi, intérêts ; **dépense récurrente** — indicateurs communs seuls.
* Lecture factuelle (« Ce que montre le calcul ») : écarts signés et point bas, sans recommandation ;
  avertissements distincts ; limites du calcul (devise de base, ni inflation, ni fiscalité, ni
  frais ; référence à épargne constante non rémunérée ; achat : aucune dépréciation).

### 12.3 Trajectoires

* Trésorerie et patrimoine net, avec et sans la décision ; « avec » = référence + écart stocké
  (définition de l'écart). Simulation en cours seulement : solde du compte dédié (objectif,
  placement) ou capital restant dû (achat à crédit), lus dans le détail du moteur — non stockés,
  donc absents de l'historique.
* Une valeur par mois calculé (0 à l'horizon), tracé linéaire entre les points, aucune série
  interpolée ou inventée ; valeurs exactes dans le tableau « Voir les valeurs mois par mois ».
* Graphiques toujours de gauche à droite (axes numériques) ; montants isolés (`<bdi>` et marqueurs
  d'isolation Unicode dans les phrases) pour les langues RTL.

### 12.4 Enregistrement et historique (contrat E4 inchangé)

* Le snapshot affiché est enregistré **tel quel** (`saveSimulation`) : horizon et mois de départ
  sont déjà dans `hypotheses`, les résultats dans `results` ; aucune évolution du schéma E4.
* Chaque exécution produit un nouvel identifiant ; « Enregistrer » est désactivé après succès ; un
  snapshot existant n'est jamais remplacé. Limite de 50 atteinte : enregistrement refusé avec
  explication, rien n'est supprimé.
* Modifier la situation ou la décision efface le résultat affiché (il faut relancer).
* Historique : « Détails » d'une simulation enregistrée affiche ses résultats figés, relus sans
  recalcul (simulations à une variante ; plusieurs variantes : résultats comparés, § 13).

### 12.5 Traductions et tests

* 67 clés `dl.run.*` et `dl.res.*` dans les 24 langues (produites par IA, non relues par des
  locuteurs natifs).
* `simulationRun.test.ts` : quatre types × horizons 1, 12, 60 et 480 mois ; snapshot identique à
  `createSnapshot`, détail identique à `simulateDecision`, séries identiques à `projectDecision` ;
  horizon, nom et situation invalides ; montants élevés refusés sur l'horizon réel ; trésorerie
  négative ; objectif atteint, après l'horizon, non atteint, en retard ; crédit au-delà de
  l'horizon ; remboursement anticipé ; aucun appel aux fonctions de calcul depuis les composants.
* `SimulationPanel.test.ts` : parcours complet dans la page, valeurs du référentiel E2 affichées
  (placement 279 527,12 DH, mensualité 3 591,94 DH, effort 2 429,83 DH), enregistrement et
  historique, limite atteinte, effacement après modification, arabe, absence d'écriture hors de la
  clé dédiée.

## 13. Interface — étape E5.5 : comparateur multi-variantes

Aucune modification des contrats E2, E3 et E4 : le comparateur utilise `compareDecisions` (E3) au
travers de `createSnapshot` (E4), qui acceptaient déjà 2 à 4 variantes.

### 13.1 Règles métier (arbitrages validés)

* Point d'entrée : choix « Simulation simple / Comparaison (2 à 4 variantes) » dans la carte
  « Nouvelle décision ». Les deux modes restent montés : changer de mode ne perd aucune saisie ; la
  carte de simulation simple n'est affichée qu'en mode simple, la carte « Comparaison » qu'en mode
  comparaison.
* **Un seul type de décision** par comparaison, choisi une fois pour toutes les variantes (changer
  de type invalide toutes les variantes, les brouillons sont conservés) ; `runComparison` refuse en
  plus des types mélangés (`mixedKinds`), règle que le moteur n'impose pas.
* **2 à 4 variantes**, chacune avec un **nom modifiable** (obligatoire, 80 caractères au plus,
  distinct des autres sans tenir compte de la casse) et ses propres hypothèses. Ajout, retrait (pas
  sous 2), duplication (copie des saisies, à valider à son tour).
* **Validation indépendante** de chaque variante (`buildDecision`, comme une simulation simple) ;
  la carte « Comparaison » n'apparaît que lorsque toutes les variantes sont validées et nommées.
* Objectif d'épargne : les variantes peuvent mélanger « délai fixé » et « versement fixé » (même
  type de décision) ; une note le rappelle dans les résultats.
* **Situation initiale commune** (celle de la page) et **horizon commun** saisi une fois ; même
  référence sans décision, mêmes mois et mêmes unités pour toutes les variantes (garantis par le
  moteur). Pas de comparaison de simulations déjà enregistrées : une comparaison est toujours créée
  avec une situation et un horizon communs.

### 13.2 Exécution (`runComparison`)

* Contrôles : nom, situation, horizon (bornes du moteur), nombre de variantes, type unique, noms,
  variantes validées ; puis `validateDecision` de chaque variante sur l'horizon réel.
* Chaque variante est ensuite exécutée **seule** (`simulateDecision`) : une erreur du moteur sur
  l'horizon réel (`resultOutOfRange`…) est attribuée à la variante concernée — `compareDecisions`
  ne précise pas la variante en cause. Ces résultats forment le détail mensuel affiché (non
  stocké).
* Snapshot : `createSnapshot` avec les identifiants `A` à `D` (rang) et les noms saisis ; résultat
  identique à `compareDecisions` et, variante par variante, à une simulation isolée (vérifié par
  les tests).

### 13.3 Écarts et indicateurs (aucun calcul financier dans l'interface)

* **Règle de signe** : écart = valeur de la variante − valeur de la variante A (la première,
  « base des écarts »). Positif : valeur plus élevée ; négatif : valeur plus faible. L'écart ne
  qualifie pas la variante : affiché sans couleur de jugement, aucune variante n'est dite
  « meilleure » ou « rentable ». Écart absent (« — ») si l'une des valeurs manque (pas de crédit,
  cible non atteinte…) ou s'il sortirait des entiers exacts.
* Indicateurs communs : trésorerie et patrimoine en fin d'horizon, écarts dus à la décision,
  trésorerie la plus basse et son mois, premier mois de trésorerie négative. Par type, seulement ce
  que fournit le moteur : achat (crédit : mensualité, dernière échéance, nombre d'échéances,
  intérêts, total remboursé — affichés si au moins une variante est financée, « Sans crédit »
  sinon) ; objectif (versement, mois d'atteinte, total versé, intérêts, manque à l'échéance, solde
  final) ; placement (valeur finale, total investi, intérêts) ; dépense récurrente : indicateurs
  communs seuls. Pas de « coût total » : le moteur ne le fournit pas.
* Présentation : une synthèse par variante (écarts par rapport à la situation sans décision,
  avertissements propres), puis une carte par indicateur (une ligne par variante) — lisible sur
  mobile sans tableau large.

### 13.4 Trajectoires, enregistrement, historique

* Graphiques : trésorerie et patrimoine (référence + une courbe par variante), et, pour la
  comparaison en cours, solde du compte dédié ou capital restant dû. Couleur et tracé distincts
  par variante ; axes toujours de gauche à droite ; une valeur par mois calculé, sans
  interpolation ; valeurs exactes dans le tableau (choix de la série, colonne « Mois » figée).
* Enregistrement tel quel par le store E4 (une comparaison compte pour une simulation dans la
  limite de 50) ; nouvel identifiant à chaque exécution ; refus explicite à la limite ou en cas
  d'erreur de stockage. Modifier la situation, une variante ou un nom efface le résultat affiché.
* Historique : badge « Comparaison » ; « Détails » affiche les résultats comparés relus sans
  recalcul (séries non stockées absentes, signalé dans les limites).

### 13.5 Traductions et tests

* 62 clés `dl.mode.*` et `dl.cmp.*` dans les 24 langues (produites par IA, non relues par des
  locuteurs natifs).
* `comparisonRun.test.ts` : quatre types × 2, 3 et 4 variantes × horizons 1, 60 et 480 mois —
  snapshot identique à `createSnapshot`, référence et résultats identiques à `compareDecisions` et
  à des simulations isolées ; méthodes d'objectif mélangées ; erreurs (nombre de variantes, types
  mélangés, nom, situation, horizon, noms de variantes, variante non validée, échec attribué à la
  variante) ; avertissements par variante ; règle de signe et cohérence des écarts ; séries ;
  limite de 50, erreur de stockage, cohabitation avec les simulations simples ; absence de calcul
  et de qualificatif dans l'interface.
* `ComparisonPanel.test.ts` : parcours complet dans la page (mode, ajout, retrait, duplication,
  noms, validations, changement de type, objectif à méthodes mélangées, horizon, résultats avec
  valeurs du référentiel E2, écarts, graphiques et valeurs exactes, modification et relance,
  achat comptant contre crédit, 4 dépenses récurrentes, enregistrement, historique, limite,
  stockage indisponible, simulation simple intacte, arabe et hébreu).
* `DecisionLab.test.ts` : la consultation d'une simulation à plusieurs variantes affiche désormais
  les résultats comparés (auparavant aucun résultat, en attendant E5.5).
