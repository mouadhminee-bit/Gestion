# Decision Lab — référentiels de calcul indépendants (étape E2, clôturée)

Référentiels destinés à tester **ultérieurement** (E3) le moteur `decision.ts`, qui n'existe
pas encore. Rien ici n'est importé par l'application ; aucun module métier n'est modifié.

## Contenu

| Fichier | Rôle |
|---|---|
| `generate_references.py` | Générateur (Python 3, bibliothèque standard uniquement) |
| `case1_vehicle_loan.json` | Cas 1 — véhicule 180 000 DH, apport 30 000, crédit 150 000 à 7 % nominal sur 48 mois, frais 1 500, assurance 120/mois, horizon 60 mois ; + vérification du générateur (G1–G3) |
| `case2_investment.json` | Cas 2 — placement 20 000 DH + 1 500 DH/mois, 6 % effectif, 120 mois, fin de mois |
| `case3_savings_goal.json` | Cas 3 — objectif 60 000 DH en 24 mois, 0 % et 3 % effectif ; effort constant ; versement constant 2 500 DH (référence), 2 000 et 3 000 DH (variantes) |

```bash
python3 -I references/decision-lab/generate_references.py          # régénérer
python3 -I references/decision-lab/generate_references.py --check  # vérifier que les JSON sont à jour
```

## Méthode

* **Indépendance** : autre langage que le moteur (Python), aucun accès à `src/`,
  arithmétique exacte — `Fraction` pour les taux rationnels (crédit 7 %/12, 1,06^10),
  `Decimal` à 80 chiffres pour les taux irrationnels (racine 12e) ; aucun flottant binaire.
* **Double calcul obligatoire** (assertions, tolérance 1e-60 centime) : racine 12e par
  logarithme/exponentielle **et** Newton ; valeurs finales par formule fermée **et**
  itération mois par mois ; mensualité par formule fermée **et** somme géométrique
  (égalité rationnelle stricte) ; effort d'objectif exact recapitalisé mois par mois.
* **Invariants automatiques** : crédit soldé, Σ capital = montant financé ; solde = apports
  + intérêts ; objectif atteint exactement (dernier versement plafonné) ; cas 1 :
  patrimoine net (écart) = −(frais + intérêts cumulés + assurance cumulée) chaque mois ;
  écart de dernière échéance dû à l'arrondi de la mensualité = −δ · S_n (exact).
* **Contre-vérification hors script** avec `bc -l` (40 décimales) : 1,06^10, valeurs finales
  du cas 2, mensualité et intérêts exacts du cas 1, effort exact à 3 %, composante G3 — identiques.
* **Cohérence des trois JSON** (`coherence_checks`, à chaque exécution) : `meta` identique, statuts
  recalculés depuis les hypothèses, codes d'hypothèse connus, aucun flottant, soldes finaux des
  échéanciers = synthèses.
* Fichiers déterministes (aucun horodatage) : `--check` détecte toute dérive ; deux exécutions
  isolées (graines de hachage différentes) donnent des fichiers identiques octet pour octet.

## Statuts

| Statut | Signification |
|---|---|
| `verifie_math` | vrai quelle que soit la convention métier ; ≥ 2 méthodes concordantes |
| `valide_conventions` | calcul vérifié **et** toutes les hypothèses utilisées sont validées |
| `candidat` | calcul vérifié, au moins une hypothèse à valider (`hypotheses_a_valider`) |
| `synthetique` | paramètres de contrôle, hors cas de référence |
| `informatif` | variante écartée par une convention validée, conservée pour comparaison |
| `manquant` | aucune valeur produite |

Le statut est **calculé** à partir de l'état des hypothèses (`meta.hypotheses`, champ
`etat` : `validee` / `a_valider`) : valider une hypothèse dans le script promeut
automatiquement les résultats concernés. Aucun contrôle externe certifié n'existe :
« vérifié » ≠ « certifié métier ».

## Conventions

Toutes les hypothèses H1–H15 sont validées (H11 et H12 à l'ouverture de E3 ; H15 — rendement
après atteinte d'un objectif — à la finalisation de E3) : champ `etat`
de `meta.hypotheses`. Les référentiels servent d'oracle aux tests
`src/domain/calc/decision.oracle.test.ts` (voir `docs/DECISION_LAB.md`).

## Cas 1 — lecture comptable

La trajectoire est un **impact incrémental** par rapport à la référence sans décision, jamais
un patrimoine total : patrimoine total = patrimoine de la référence (données de l'utilisateur,
non modélisées ici) + `impact_patrimoine_net`, avec
`impact = actif_vehicule − dette_restante + ecart_tresorerie_cumule`.

| Mois | Flux du mois | Trésorerie cumulée | Actif | Dette | Impact patrimoine |
|---|---|---|---|---|---|
| 0 | −31 500,00 | −31 500,00 | 180 000,00 | 150 000,00 | −1 500,00 |
| 1 | −3 711,94 | −35 211,94 | 180 000,00 | 147 283,06 | −2 495,00 |
| 48 | −3 711,78 | −209 672,96 | 180 000,00 | 0,00 | −29 672,96 |
| 49 | 0,00 | −209 672,96 | 180 000,00 | 0,00 | −29 672,96 |
| 60 | 0,00 | −209 672,96 | 180 000,00 | 0,00 | −29 672,96 |

Contrôlés par recalcul indépendant en arithmétique entière. Impact final = −(frais 1 500 +
intérêts 22 412,96 + assurance 5 760).

## Écart de dernière échéance (G3 : −9 770,29 DH)

Ce n'est pas une erreur de calcul, mais l'amplification d'arrondis par un crédit très mal
conditionné (30 %, 480 mois, i = 2,5 %/mois ; 17,80 centimes de capital amorti le premier mois).
Décomposition exacte, en DH :

| Composante | Définition | Valeur |
|---|---|---|
| B | arrondi de la mensualité seul = −δ · S_n (δ = +0,1972 centime, S_480 ≈ 5 617 102) | −11 078,31 |
| C | arrondi mensuel des intérêts seul = Σ ε_m (1+i)^(n−m) | +1 470,43 |
| I | interaction = Σ (ε_m^D − ε_m^C)(1+i)^(n−m) : les erreurs d'arrondi dépendent du solde, qui diffère dès que la mensualité est arrondie (479 mois sur 480) | −162,41 |
| D | total avec les conventions H4 + H6 = B + C + I | −9 770,29 |

B + C + I = D est une égalité rationnelle exacte, et la somme des valeurs arrondies au centime
retombe exactement sur −9 770,29. Méthodes indépendantes : simulation directe en fractions,
propagation linéaire des erreurs sans simulation du solde, recalcul de D en arithmétique entière
pure, forme fermée de B (contre-vérifiée par `bc`). Cas 1 réel : B −0,18, C +0,01, I +0,01,
D −0,16 DH. Les règles H4 et H6 sont appliquées correctement.
