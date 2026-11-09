#!/usr/bin/env python3
"""
NEXORA — Decision Lab, étape E2 : référentiels de calcul indépendants.

Indépendance vis-à-vis du moteur TypeScript :
  * langage différent (Python 3, bibliothèque standard uniquement) ;
  * aucune lecture ni import de `src/` ;
  * arithmétique exacte : `fractions.Fraction` (taux rationnels) ou `decimal.Decimal`
    à 80 chiffres significatifs (taux irrationnels) — jamais de flottant binaire ;
  * chaque grandeur est obtenue par au moins deux méthodes distinctes (formule fermée
    et itération mois par mois, ou deux algorithmes de racine 12e) dont l'accord est
    vérifié par assertion.

Usage :
  python3 references/decision-lab/generate_references.py          # régénère les JSON
  python3 references/decision-lab/generate_references.py --check  # recalcule et compare

Aucune donnée réelle n'est lue ni écrite. Les seules entrées sont les paramètres
écrits dans ce fichier.
"""
from __future__ import annotations

import json
import sys
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, getcontext
from fractions import Fraction
from pathlib import Path

getcontext().prec = 80
HERE = Path(__file__).resolve().parent
TOL = Decimal("1e-60")  # tolérance d'accord entre deux méthodes (en centimes)
MAX_MONTHS = 480
MAX_RATE_BPS = 3000

STATUS_VERIFIED = "verifie_math"          # vrai quelle que soit la convention métier ; ≥ 2 méthodes concordantes
STATUS_VALIDATED = "valide_conventions"    # calcul vérifié ET toutes les conventions utilisées validées
STATUS_CANDIDATE = "candidat"              # calcul vérifié, mais au moins une hypothèse non validée
STATUS_MISSING = "manquant"                # paramètre non fourni : aucune valeur produite
STATUS_SYNTHETIC = "synthetique"           # paramètres de contrôle, hors cas de référence
STATUS_INFO = "informatif"                 # variante écartée par une convention validée, conservée pour comparaison

SOURCE_E2C = "consigne de correction E2 du responsable du projet"
SOURCE_CLOTURE = "décision de clôture E2 du responsable du projet"
SOURCE_E3 = "décision d'ouverture E3 du responsable du projet"
SOURCE_E3F = "décision de finalisation E3 du responsable du projet"
# validee : convention fixée par le responsable du projet ; a_valider : proposition en attente.
HYPOTHESES = {
    "H1": {"texte": "Taux annuel effectif → taux mensuel équivalent i = (1 + R)^(1/12) − 1 (capitalisation mensuelle).", "etat": "validee", "source": SOURCE_CLOTURE,
           "note": "Usage standard ; l'énoncé dit « effectif annuel » mais ne fixe pas la capitalisation infra-annuelle."},
    "H2": {"texte": "Versements périodiques en fin de mois.", "etat": "validee", "source": SOURCE_E2C + " (cas 2 et 3)"},
    "H3": {"texte": "Capital initial placé à t = 0 et capitalisé dès le premier mois.", "etat": "validee", "source": SOURCE_CLOTURE,
           "note": "Lecture naturelle de « capital initial », non formulée explicitement."},
    "H4": {"texte": "Intérêts de chaque mois arrondis au centime le plus proche, demi vers l'extérieur (règle roundHalfAwayFromZero) ; placement, objectif et crédit.", "etat": "validee", "source": SOURCE_CLOTURE,
           "note": "La variante sans arrondi intermédiaire est fournie à chaque fois."},
    "H5": {"texte": "Crédit : taux nominal annuel proportionnel, i = taux / 12 ; échéances constantes.", "etat": "validee", "source": SOURCE_E2C + " (cas 1 : « taux nominal annuel »), confirmée par la " + SOURCE_CLOTURE},
    "H6": {"texte": "Crédit : mensualité arrondie au centime le plus proche ; la dernière échéance est ajustée pour solder le crédit.", "etat": "validee",
           "source": SOURCE_E2C + " (cas 1), confirmée par la " + SOURCE_CLOTURE, "note": "« Au centime » lu comme « au plus proche » (demi vers l'extérieur)."},
    "H7": {"texte": "Objectif : effort mensuel arrondi au centime supérieur (l'objectif doit être atteint dans l'horizon) ; même règle que goals.ts (Math.ceil).", "etat": "validee", "source": SOURCE_CLOTURE},
    "H8": {"texte": "Objectif : épargne initiale nulle.", "etat": "validee", "source": SOURCE_E2C + " (cas 3)"},
    "H9": {"texte": "Objectif : taux de 3 % annuel effectif.", "etat": "validee", "source": SOURCE_E2C + " (cas 3)"},
    "H10": {"texte": "Rythme constant : durée = premier mois où le solde atteint la cible, plafonnée à 480 mois.", "etat": "validee", "source": SOURCE_CLOTURE},
    "H11": {"texte": "Cas 1 : apport et frais payés au mois 0 ; crédit versé directement au vendeur ; véhicule inscrit à l'actif au mois 0 ; échéances et assurance en fin de mois 1 à 48 (convention de fin de mois, H2).", "etat": "validee", "source": SOURCE_E3},
    "H12": {"texte": "Référence sans décision : trésorerie non dépensée non rémunérée ; résultats exprimés en écart à cette référence.", "etat": "validee", "source": SOURCE_E3},
    "H13": {"texte": "Cas 3, mode « versement constant » : scénario de référence 2 500 DH/mois ; variantes 2 000 et 3 000 DH/mois.", "etat": "validee", "source": SOURCE_CLOTURE},
    "H14": {"texte": "Dernier versement plafonné au montant nécessaire : versement du mois = min(versement prévu, cible − (solde + intérêts du mois)).", "etat": "validee", "source": SOURCE_E2C + " (cas 3)"},
    "H15": {"texte": "Objectif : après l'atteinte, versements arrêtés ; le capital reste sur le compte dédié et continue de produire le rendement prévu (intérêts arrondis, H4). Le mois d'atteinte et le solde final sont distincts.", "etat": "validee", "source": SOURCE_E3F},
}


def status_for(hyps: list[str]) -> str:
    return STATUS_VALIDATED if all(HYPOTHESES[h]["etat"] == "validee" for h in hyps) else STATUS_CANDIDATE


def tagged(hyps: list[str], **values) -> dict:
    hyps = sorted(set(hyps), key=lambda h: int(h[1:]))
    return {"statut": status_for(hyps), "hypotheses": hyps,
            "hypotheses_a_valider": [h for h in hyps if HYPOTHESES[h]["etat"] != "validee"], **values}


# ---------------------------------------------------------------- arrondis exacts
def frac_round_half_away(x: Fraction) -> int:
    q, r = divmod(abs(x.numerator), x.denominator)
    if 2 * r >= x.denominator:
        q += 1
    return q if x >= 0 else -q


def dec_round_half_away(x: Decimal) -> int:
    return int(x.to_integral_value(rounding=ROUND_HALF_UP))  # HALF_UP de decimal = demi vers l'extérieur


def dec_ceil(x: Decimal) -> int:
    return int(x.to_integral_value(rounding=ROUND_CEILING))


def dstr(x, places: int = 12) -> str:
    """Valeur décimale exacte tronquée à l'affichage (arrondie à `places` décimales)."""
    if isinstance(x, Fraction):
        x = Decimal(x.numerator) / Decimal(x.denominator)
    return str(Decimal(x).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP))


def agree(a: Decimal, b: Decimal, what: str) -> None:
    if abs(a - b) > TOL:
        raise AssertionError(f"désaccord entre méthodes ({what}) : {a} ≠ {b}")


# ---------------------------------------------------------------- taux
def monthly_rate_effective(bps: int) -> Decimal:
    """Racine 12e par deux méthodes indépendantes (logarithme/exponentielle, Newton)."""
    assert 0 <= bps <= MAX_RATE_BPS
    if bps == 0:
        return Decimal(0)
    base = Decimal(10000 + bps) / Decimal(10000)
    a = (base.ln() / 12).exp() - 1
    y = 1 + Decimal(bps) / Decimal(120000)
    for _ in range(500):
        nxt = y - (y**12 - base) / (12 * y**11)
        if abs(nxt - y) < Decimal("1e-78"):
            y = nxt
            break
        y = nxt
    b = y - 1
    agree(a, b, f"racine 12e de {base}")
    agree((1 + a) ** 12, base, "re-élévation à la puissance 12")
    return a


def monthly_rate_nominal(bps: int) -> Fraction:
    assert 0 <= bps <= MAX_RATE_BPS
    return Fraction(bps, 120000)


def to_dec(x) -> Decimal:
    if isinstance(x, Fraction):
        return Decimal(x.numerator) / Decimal(x.denominator)
    return Decimal(x)


# ---------------------------------------------------------------- placement
def invest_closed(c0: int, p: int, i: Decimal, n: int, timing: str) -> tuple[Decimal, Decimal]:
    g = (1 + i) ** n
    fv0 = Decimal(c0) * g
    ann = Decimal(p) * n if i == 0 else Decimal(p) * (g - 1) / i
    if timing == "debut":
        ann *= 1 + i
    return fv0, ann


def invest_iter_exact(c0: int, p: int, i: Decimal, n: int, timing: str) -> Decimal:
    b = Decimal(c0)
    for _ in range(n):
        if timing == "debut":
            b += p
        b += b * i
        if timing == "fin":
            b += p
    return b


def invest_rounded(c0: int, p: int, i: Decimal, n: int, timing: str, rows: bool = True):
    b = c0
    out = []
    cum_c = c0
    cum_i = 0
    for m in range(1, n + 1):
        opening = b
        contrib = 0
        if timing == "debut":
            b += p
            contrib = p
        interest = dec_round_half_away(Decimal(b) * i)
        b += interest
        if timing == "fin":
            b += p
            contrib = p
        cum_c += contrib
        cum_i += interest
        if rows:
            out.append({"mois": m, "solde_ouverture": opening, "versement": contrib, "interets": interest,
                        "solde_cloture": b, "apports_cumules_capital_initial_inclus": cum_c, "interets_cumules": cum_i})
    assert b == cum_c + cum_i, "invariant solde = versements + intérêts"
    return b, cum_c, cum_i, out


# ---------------------------------------------------------------- crédit
def loan_payment_closed(l: int, i: Fraction, n: int) -> Fraction:
    if i == 0:
        return Fraction(l, n)
    return l * i / (1 - (1 + i) ** -n)


def loan_payment_sum(l: int, i: Fraction, n: int) -> Fraction:
    """Méthode 2 : solde final linéaire en X : L(1+i)^n − X Σ_{k<n}(1+i)^k = 0."""
    s = Fraction(0)
    f = Fraction(1)
    for _ in range(n):
        s += f
        f *= 1 + i
    return l * f / s


def loan_schedule(l: int, bps: int, n: int, keep_rows=True):
    assert 1 <= n <= MAX_MONTHS
    i = monthly_rate_nominal(bps)
    exact = loan_payment_closed(l, i, n)
    exact2 = loan_payment_sum(l, i, n)
    assert exact == exact2, "mensualité : formule fermée ≠ somme géométrique"
    inst = frac_round_half_away(exact)
    b = l
    rows = []
    tot_int = tot_pr = tot_paid = 0
    for m in range(1, n + 1):
        interest = frac_round_half_away(b * i)
        if m < n:
            pay = inst
            principal = pay - interest
        else:
            principal = b
            pay = principal + interest
        assert principal >= 0, "amortissement négatif"
        opening = b
        b -= principal
        tot_int += interest
        tot_pr += principal
        tot_paid += pay
        if keep_rows:
            rows.append({"mois": m, "capital_restant_debut": opening, "echeance": pay, "interets": interest,
                         "capital_amorti": principal, "capital_restant_fin": b})
    assert b == 0 and tot_pr == l and tot_paid == tot_pr + tot_int
    # Coût exact sans arrondi : n × mensualité exacte − L
    exact_cost = exact * n - l
    return {
        "taux_mensuel_exact": f"{i.numerator}/{i.denominator}",
        "mensualite_exacte_centimes": dstr(exact),
        "mensualite_arrondie_centimes": inst,
        "derniere_echeance_centimes": rows[-1]["echeance"] if keep_rows else pay,
        "ecart_derniere_echeance_centimes": (rows[-1]["echeance"] if keep_rows else pay) - inst,
        "total_interets_centimes": tot_int,
        "total_interets_exact_sans_arrondi_centimes": dstr(exact_cost),
        "total_rembourse_centimes": tot_paid,
    }, rows


# ---------------------------------------------------------------- objectif
def goal_effort_exact(t: int, i: Decimal, n: int) -> Decimal:
    if i == 0:
        return Decimal(t) / n
    return Decimal(t) * i / ((1 + i) ** n - 1)


def goal_reached_rounded(t: int, p: int, i: Decimal, n: int) -> bool:
    return invest_rounded(0, p, i, n, "fin", rows=False)[0] >= t


def goal_min_effort_rounded(t: int, i: Decimal, n: int) -> int:
    p = dec_ceil(goal_effort_exact(t, i, n))
    while p > 1 and goal_reached_rounded(t, p - 1, i, n):
        p -= 1
    while not goal_reached_rounded(t, p, i, n):
        p += 1
    return p


def goal_months(t: int, p: int, i: Decimal, rounded: bool):
    b = Decimal(0) if not rounded else 0
    for m in range(1, MAX_MONTHS + 1):
        if rounded:
            b += dec_round_half_away(Decimal(b) * i) + p
        else:
            b += b * i + p
        if b >= t:
            return m
    return None


# ---------------------------------------------------------------- crédit : analyse de l'écart de dernière échéance
def loan_last_deviation(l: int, i: Fraction, n: int, installment, round_interest: bool) -> Fraction:
    """Dernière échéance − mensualité, avec mensualité donnée (exacte ou arrondie) et intérêts exacts ou arrondis."""
    b = Fraction(l)
    for _ in range(n - 1):
        it = b * i
        if round_interest:
            it = Fraction(frac_round_half_away(it))
        b = b + it - installment
    it = b * i
    if round_interest:
        it = Fraction(frac_round_half_away(it))
    return b + it - installment


def loan_path_errors(l: int, i: Fraction, n: int, installment, round_interest: bool) -> tuple[Fraction, list[Fraction]]:
    """Simulation directe ; renvoie (dernière échéance − mensualité, erreurs d'arrondi d'intérêts ε_m)."""
    b = Fraction(l)
    errs = []
    for _ in range(n):
        ex = b * i
        it = Fraction(frac_round_half_away(ex)) if round_interest else ex
        errs.append(it - ex)
        b = b + it - installment  # au mois n : b = dernière échéance − mensualité
    return b, errs


def propagate(errs: list[Fraction], delta: Fraction, i: Fraction, n: int) -> Fraction:
    """Méthode 2 (propagation linéaire des erreurs, sans simulation du solde) :
    écart = Σ ε_m (1+i)^(n−m) − δ · S_n, puisque e_m = e_(m−1)(1+i) + ε_m − δ et e_0 = 0."""
    s_n = Fraction(n) if i == 0 else ((1 + i) ** n - 1) / i
    w = [(1 + i) ** (n - m) for m in range(1, n + 1)]
    return sum((e * x for e, x in zip(errs, w)), Fraction(0)) - delta * s_n


def loan_last_integer_only(l: int, num: int, den: int, n: int, inst: int) -> int:
    """Méthode 3 (convention D) : arithmétique entière pure, i = num/den ; arrondi demi vers
    l'extérieur d'un montant positif = ⌊(2·b·num + den) / (2·den)⌋."""
    b = l
    for _ in range(n - 1):
        b = b + (2 * b * num + den) // (2 * den) - inst
    return b + (2 * b * num + den) // (2 * den) - inst


def dh(x) -> str:
    x = x if isinstance(x, Fraction) else Fraction(x)
    return dstr(x / 100, 2)


def loan_deviation_analysis(l: int, bps: int, n: int) -> dict:
    i = monthly_rate_nominal(bps)
    exact = loan_payment_closed(l, i, n)
    rounded = frac_round_half_away(exact)
    delta = rounded - exact
    s_n = Fraction(n) if i == 0 else ((1 + i) ** n - 1) / i
    A, _ = loan_path_errors(l, i, n, exact, False)
    B, eB = loan_path_errors(l, i, n, Fraction(rounded), False)
    C, eC = loan_path_errors(l, i, n, exact, True)
    D, eD = loan_path_errors(l, i, n, Fraction(rounded), True)
    assert A == 0
    assert B == -delta * s_n == propagate(eB, delta, i, n)
    assert C == propagate(eC, Fraction(0), i, n)
    assert D == propagate(eD, delta, i, n)
    assert D == loan_last_integer_only(l, i.numerator, i.denominator, n, rounded)
    inter = D - B - C
    w = [(1 + i) ** (n - m) for m in range(1, n + 1)]
    assert inter == sum(((d - c) * x for d, c, x in zip(eD, eC, w)), Fraction(0))
    rB, rC, rI, rD = (frac_round_half_away(x) for x in (B, C, inter, D))
    assert rB + rC + rI == rD, "les composantes arrondies au centime ne se réconcilient pas"
    differ = sum(1 for d, c in zip(eD, eC) if d != c)
    alt = {}
    for name, inst in (("plancher", exact.numerator // exact.denominator), ("plafond", -(-exact.numerator // exact.denominator))):
        alt[name] = {"mensualite_centimes": inst, "ecart_derniere_echeance_centimes": dstr(loan_path_errors(l, i, n, Fraction(inst), True)[0], 6)}
    return {
        "mensualite_exacte_centimes": dstr(exact),
        "mensualite_arrondie_centimes": rounded,
        "delta_arrondi_mensualite_centimes": dstr(delta),
        "facteur_amplification_S_n": dstr(s_n, 6),
        "definitions": {
            "B": "effet de l'arrondi de la mensualité seul (intérêts exacts) = −δ · S_n",
            "C": "effet de l'arrondi mensuel des intérêts seul (mensualité exacte) = Σ ε_m^C (1+i)^(n−m)",
            "I": "interaction = D − B − C = Σ (ε_m^D − ε_m^C)(1+i)^(n−m) : l'erreur d'arrondi des intérêts dépend du solde, qui diffère selon que la mensualité est arrondie ou non",
            "D": "écart total avec les conventions H4 + H6 = B + C + I",
        },
        "reconciliation_centimes": {"B": dstr(B, 6), "C": dstr(C, 6), "I": dstr(inter, 6), "D": dstr(D, 6),
                                    "controle": "B + C + I = D (égalité rationnelle exacte)"},
        "reconciliation_DH": {"B": dh(B), "C": dh(C), "I": dh(inter), "D": dh(D),
                              "somme_des_composantes_affichees": dh(rB + rC + rI)},
        "mois_ou_les_erreurs_C_et_D_different": differ,
        "methodes_independantes": [
            "1 — simulation directe du solde en fractions exactes (variantes A à D)",
            "2 — propagation linéaire des erreurs Σ ε_m (1+i)^(n−m) − δ · S_n, sans simulation du solde",
            "3 — variante D recalculée en arithmétique entière pure",
            "4 — B égal à la forme fermée −δ · S_n (contre-vérifiée par bc à 40 décimales)",
        ],
        "decomposition_ecart_derniere_echeance_centimes": {
            "A_mensualite_exacte_interets_exacts": dstr(A, 6),
            "B_mensualite_arrondie_interets_exacts": dstr(B, 6),
            "C_mensualite_exacte_interets_arrondis": dstr(C, 6),
            "D_mensualite_arrondie_interets_arrondis_convention": dstr(D, 6),
        },
        "alternatives_informatives_non_retenues": alt,
    }


# ---------------------------------------------------------------- objectif avec dernier versement plafonné
def goal_schedule_capped(t: int, p, i: Decimal, max_months: int, rounded: bool):
    """Versements de fin de mois p, dernier versement plafonné au besoin (H14). p peut être exact (Decimal)."""
    b = 0 if rounded else Decimal(0)
    rows, tot_p, tot_i = [], 0, 0
    for m in range(1, max_months + 1):
        opening = b
        it = dec_round_half_away(Decimal(b) * i) if rounded else b * i
        need = t - (b + it)
        pay = min(p, need) if need > 0 else 0
        b = b + it + pay
        tot_p += pay
        tot_i += it
        rows.append({"mois": m, "solde_ouverture": opening if rounded else dstr(opening), "interets": it if rounded else dstr(it),
                     "versement": pay if rounded else dstr(pay), "solde_cloture": b if rounded else dstr(b)})
        if b >= t:
            return m, b, tot_p, tot_i, rows
    return None, b, tot_p, tot_i, rows


# ================================================================ cas
def case1() -> dict:
    price, down, credit, bps, n = 18_000_000, 3_000_000, 15_000_000, 700, 48
    fees, ins, horizon, vehicle = 150_000, 12_000, 60, 18_000_000
    assert price - down == credit
    summary, rows = loan_schedule(credit, bps, n)
    i = monthly_rate_nominal(bps)
    exact = loan_payment_closed(credit, i, n)
    by_month = {r["mois"]: r for r in rows}
    traj = []
    cash = -(down + fees)
    debt = credit
    impact = vehicle - debt + cash
    assert impact == -fees
    traj.append({"mois": 0,
                 "flux": {"apport": -down, "frais_initiaux": -fees, "echeance": 0, "dont_interets": 0, "dont_capital": 0, "assurance": 0, "total": cash},
                 "ecart_tresorerie_cumule": cash, "actif_vehicule": vehicle, "dette_restante": debt,
                 "impact_patrimoine_net": impact, "variation_impact_patrimoine_du_mois": impact})
    for m in range(1, horizon + 1):
        r = by_month.get(m)
        e, it, pr, a = (r["echeance"], r["interets"], r["capital_amorti"], ins) if r else (0, 0, 0, 0)
        total = -(e + a)
        cash += total
        debt = r["capital_restant_fin"] if r else debt
        new_impact = vehicle - debt + cash
        assert new_impact - impact == -(it + a), "variation du mois = −(intérêts + assurance)"
        traj.append({"mois": m,
                     "flux": {"apport": 0, "frais_initiaux": 0, "echeance": -e, "dont_interets": -it, "dont_capital": -pr, "assurance": -a, "total": total},
                     "ecart_tresorerie_cumule": cash, "actif_vehicule": vehicle, "dette_restante": debt,
                     "impact_patrimoine_net": new_impact, "variation_impact_patrimoine_du_mois": new_impact - impact})
        impact = new_impact
    # Points de contrôle recalculés indépendamment (arithmétique entière pure, sans l'échéancier ci-dessus)
    inst = frac_round_half_away(exact)
    b, ints, pays = credit, [], []
    for m in range(1, n + 1):
        it = (2 * b * 7 + 1200) // 2400  # i = 7/1200, demi vers l'extérieur
        pay = inst if m < n else b + it
        b = b + it - pay
        ints.append(it)
        pays.append(pay)
    assert b == 0
    checkpoints = []
    for m in (0, 1, 48, 49, 60):
        k = min(m, n)
        exp_cash = -(down + fees) - sum(pays[:k]) - ins * k
        exp_debt = credit - (sum(pays[:k]) - sum(ints[:k]))
        exp_impact = -fees - sum(ints[:k]) - ins * k
        row = traj[m]
        assert (row["ecart_tresorerie_cumule"], row["dette_restante"], row["impact_patrimoine_net"]) == (exp_cash, exp_debt, exp_impact), f"point de contrôle mois {m}"
        assert exp_impact == vehicle - exp_debt + exp_cash
        checkpoints.append({"mois": m, "flux_du_mois_DH": dh(row["flux"]["total"]), "ecart_tresorerie_cumule_DH": dh(exp_cash),
                            "actif_vehicule_DH": dh(vehicle), "dette_restante_DH": dh(exp_debt), "impact_patrimoine_net_DH": dh(exp_impact)})
    total_out = down + fees + summary["total_rembourse_centimes"] + ins * n
    assert -cash == total_out
    loan_h = ["H4", "H5", "H6"]
    traj_h = loan_h + ["H11", "H12"]
    return {
        "cas": "1 — achat d'un véhicule financé par crédit",
        "source_parametres": SOURCE_E2C,
        "parametres": {
            "devise": "MAD", "unite_montants": "centimes", "prix_vehicule": price, "apport": down, "montant_finance": credit,
            "taux_nominal_annuel_bps": bps, "duree_credit_mois": n, "frais_initiaux": fees,
            "assurance_mensuelle": ins, "duree_assurance_mois": n, "horizon_simulation_mois": horizon,
            "valeur_comptable_vehicule": vehicle, "depreciation": "aucune (V1)",
        },
        "resultats_verifies_math": {
            "statut": STATUS_VERIFIED,
            "note": "Valeurs exactes en fractions, sans arrondi.",
            "taux_mensuel": "7/1200",
            "mensualite_exacte_centimes": dstr(exact),
            "total_interets_exact_sans_arrondi_centimes": dstr(exact * n - credit),
            "assurance_totale_centimes": ins * n,
            "methodes": ["formule fermée", "somme géométrique (égalité rationnelle stricte)"],
        },
        "credit": tagged(loan_h, resultats=summary, echeancier=rows),
        "trajectoire_ecart_vs_reference": tagged(
            traj_h,
            perimetre="IMPACT INCRÉMENTAL de la décision uniquement : chaque valeur est un écart par rapport à la référence sans décision (H12). Patrimoine net TOTAL de l'utilisateur = patrimoine net de la référence + impact_patrimoine_net ; la référence (données de l'utilisateur) n'est pas modélisée dans ce référentiel.",
            conventions_de_signe="flux négatif = décaissement ; ecart_tresorerie_cumule = Σ flux depuis le mois 0 ; actif_vehicule et dette_restante sont des positions (positives) ; impact_patrimoine_net = actif_vehicule − dette_restante + ecart_tresorerie_cumule.",
            lecture="Le crédit n'est pas un flux de trésorerie (versé au vendeur, H11) : au mois 0, l'actif (+180 000) est financé par la dette (150 000) et l'apport (−30 000) ; seuls les frais (−1 500) réduisent le patrimoine. Ensuite, chaque mois : patrimoine −(intérêts + assurance) ; le capital amorti réduit d'autant la trésorerie et la dette, sans effet sur le patrimoine.",
            synthese={
                "ecart_tresorerie_cumule_fin_horizon": cash,
                "impact_patrimoine_net_fin_horizon": traj[-1]["impact_patrimoine_net"],
                "cout_total_decision": fees + summary["total_interets_centimes"] + ins * n,
                "dont_interets": summary["total_interets_centimes"], "dont_frais": fees, "dont_assurance": ins * n,
                "total_decaisse": total_out,
            },
            points_de_controle={"methode": "recalcul indépendant en arithmétique entière pure (échéancier refait sans loan_schedule), comparé à la trajectoire",
                                "invariant": "impact = actif − dette + écart de trésorerie = −(frais + intérêts cumulés + assurance cumulée)",
                                "mois": checkpoints},
            mois=traj),
        "analyse_ecart_derniere_echeance": loan_deviation_analysis(credit, bps, n),
    }


def case2() -> dict:
    c0, p, bps, n = 2_000_000, 150_000, 600, 120
    i = monthly_rate_effective(bps)
    g_exact = Fraction(10000 + bps, 10000) ** (n // 12)
    agree((1 + i) ** n, to_dec(g_exact), "(1+i)^120 = 1,06^10")
    fv0_exact = c0 * g_exact
    res = {}
    for timing in ("fin", "debut"):
        fv0, ann = invest_closed(c0, p, i, n, timing)
        agree(fv0, to_dec(fv0_exact), "capital initial : décimal vs rationnel")
        it = invest_iter_exact(c0, p, i, n, timing)
        agree(fv0 + ann, it, f"valeur finale {timing} : formule fermée vs itération")
        fin_r, cum_c, cum_i, rows = invest_rounded(c0, p, i, n, timing)
        total = fv0 + ann
        exact_block = tagged(["H1", "H2", "H3"],
                             valeur_finale_centimes=dstr(total), valeur_finale_arrondie_centimes=dec_round_half_away(total),
                             dont_capital_initial_capitalise_centimes=dstr(fv0), dont_versements_capitalises_centimes=dstr(ann),
                             interets_totaux_centimes=dstr(total - c0 - p * n))
        rounded_block = tagged(["H1", "H2", "H3", "H4"],
                               valeur_finale_centimes=fin_r, apports_cumules_capital_initial_inclus_centimes=cum_c,
                               interets_cumules_centimes=cum_i, ecart_vs_exact_centimes=dstr(Decimal(fin_r) - total),
                               echeancier=rows)
        if timing == "debut":
            for blk in (exact_block, rounded_block):
                blk["statut"] = STATUS_INFO
            role = "variante informative : écartée par H2 (fin de mois, validée)"
        else:
            role = "convention validée (H2)"
        res[timing] = {"role": role, "exact_sans_arrondi_intermediaire": exact_block, "arrondi_mensuel": rounded_block}
    return {
        "cas": "2 — placement avec capital initial et versements mensuels",
        "source_parametres": "Paramètres communiqués par le responsable du projet ; confirmés par la " + SOURCE_E2C + ".",
        "parametres": {"devise": "MAD", "unite_montants": "centimes", "capital_initial_centimes": c0,
                       "versement_mensuel_centimes": p, "taux_annuel_effectif_bps": bps, "duree_mois": n, "versements": "fin de mois"},
        "resultats_verifies_math": {
            "statut": STATUS_VERIFIED,
            "note": "Vrais quelle que soit la convention de capitalisation infra-annuelle ; calculs exacts.",
            "facteur_croissance_120_mois": {"valeur_exacte": dstr(g_exact, 20), "fraction": "106^10 / 100^10"},
            "total_apporte_centimes": c0 + p * n,
            "capital_initial_capitalise_120_mois_centimes": {"valeur_exacte": dstr(fv0_exact, 20), "arrondi": frac_round_half_away(fv0_exact)},
        },
        "taux_mensuel_equivalent": tagged(["H1"], valeur=dstr(i, 30),
                                          methodes=["logarithme / exponentielle", "Newton sur y^12 = 1,06"]),
        "resultats_candidats": res,
        "controles_externes": {"statut": STATUS_MISSING, "note": "Aucune valeur de contrôle certifiée n'est disponible ; les valeurs indicatives de l'ancien rapport E1 ne sont pas des références."},
    }


def case3() -> dict:
    t, n = 6_000_000, 24
    p_const = 250_000  # H13
    out = {}
    for key, bps in (("rendement_0_pct", 0), ("rendement_3_pct_effectif", 300)):
        i = monthly_rate_effective(bps)
        base_h = ["H2", "H8", "H14"] + (["H1", "H9"] if bps else [])
        ex = goal_effort_exact(t, i, n)
        # Contrôle croisé : effort exact capitalisé mois par mois = cible.
        agree(invest_iter_exact(0, ex, i, n, "fin"), Decimal(t), f"effort exact {bps} bps")
        ceil_p = dec_ceil(ex)
        min_p = goal_min_effort_rounded(t, i, n)
        assert min_p == ceil_p, "effort minimal avec arrondi mensuel ≠ effort exact arrondi au supérieur"
        m_e, b_e, tp_e, ti_e, rows_e = goal_schedule_capped(t, ex, i, n, rounded=False)
        assert m_e == n and abs(b_e - t) <= TOL
        m_r, b_r, tp_r, ti_r, rows_r = goal_schedule_capped(t, ceil_p, i, n, rounded=True)
        assert m_r == n and b_r == t and tp_r + ti_r == t
        # H7 (arrondi supérieur) n'intervient que si l'effort exact n'est pas un nombre entier de centimes.
        hy_eff = base_h + (["H7"] if ex != ceil_p else []) + (["H4"] if bps else [])
        effort = {
            "effort_exact_centimes": tagged(base_h, valeur=dstr(ex)),
            "avec_arrondis": tagged(hy_eff, effort_mensuel_centimes=ceil_p, dernier_versement_centimes=rows_r[-1]["versement"],
                                    mois_atteinte=m_r, total_verse_centimes=tp_r, interets_totaux_centimes=ti_r, echeancier=rows_r),
        }
        hy_c = base_h + ["H10", "H13", "H15"] + (["H4"] if bps else [])
        scen = []
        for p_c, role in ((250_000, "reference"), (200_000, "variante"), (300_000, "variante")):
            m_c, b_c, tp_c, ti_c, rows_c = goal_schedule_capped(t, p_c, i, MAX_MONTHS, rounded=True)
            m_cx, _, _, _, _ = goal_schedule_capped(t, Decimal(p_c), i, MAX_MONTHS, rounded=False)
            assert b_c == t and tp_c + ti_c == t
            if bps == 0:
                assert m_c == m_cx == -(-t // p_c)
            reach_bal = rows_c[-1]["solde_cloture"]
            if m_c > n:
                at_h = rows_c[n - 1]["solde_cloture"]
                after = 0
            else:
                # H15 : après l'atteinte, plus de versement ; le compte dédié reste rémunéré (arrondi H4).
                b_after = reach_bal
                for _ in range(m_c + 1, n + 1):
                    b_after += dec_round_half_away(Decimal(b_after) * i)
                # Contrôle croisé : écart avec la capitalisation exacte ≤ 1 centime par mois écoulé.
                exact_after = Decimal(reach_bal) * (1 + i) ** (n - m_c)
                assert abs(Decimal(b_after) - exact_after) <= n - m_c
                if bps == 0:
                    assert b_after == reach_bal
                at_h = b_after
                after = b_after - reach_bal
            scen.append(tagged(hy_c, role=role, versement_mensuel_centimes=p_c, mois_atteinte=m_c, mois_atteinte_sans_arrondi=m_cx,
                               atteint_dans_horizon_24_mois=m_c <= n, solde_a_l_atteinte_centimes=reach_bal,
                               solde_au_mois_24_centimes=at_h,
                               interets_apres_atteinte_jusqu_au_mois_24_centimes=after,
                               manque_au_mois_24_centimes=0 if m_c <= n else t - at_h,
                               dernier_versement_centimes=rows_c[-1]["versement"], total_verse_centimes=tp_c,
                               interets_totaux_centimes=ti_c, echeancier=rows_c))
        const = {"scenario_reference_centimes": 250_000, "scenarios": scen}
        out[key] = {"taux_annuel_effectif_bps": bps, "taux_mensuel": dstr(i, 30), "effort_constant": effort, "versement_constant": const}
    # Grilles synthétiques conservées (autres horizons / versements, variante nominale)
    grids = {}
    for key, (label, i, hyps) in {
        "0_pct": ("0 %", Decimal(0), []),
        "3_pct_effectif": ("3 % effectif annuel", monthly_rate_effective(300), ["H1", "H9"]),
        "3_pct_nominal": ("3 % nominal annuel (variante écartée par H9)", to_dec(monthly_rate_nominal(300)), []),
    }.items():
        eff = []
        for nn in [12, 24, 36, 48, 60, 120]:
            ex = goal_effort_exact(t, i, nn)
            agree(invest_iter_exact(0, ex, i, nn, "fin"), Decimal(t), f"grille {label} n={nn}")
            eff.append({"duree_mois": nn, "effort_exact_centimes": dstr(ex), "effort_arrondi_superieur_centimes": dec_ceil(ex),
                        "effort_minimal_avec_arrondi_mensuel_centimes": goal_min_effort_rounded(t, i, nn)})
        dur = [{"versement_mensuel_centimes": pp, "duree_mois_exacte": goal_months(t, pp, i, False),
                "duree_mois_arrondi_mensuel": goal_months(t, pp, i, True)} for pp in [50_000, 100_000, 150_000, 200_000]]
        grids[key] = {"taux": label, "statut": STATUS_SYNTHETIC, "hypotheses": sorted(set(hyps + ["H2", "H4", "H7", "H8", "H10"]), key=lambda h: int(h[1:])),
                      "taux_mensuel": dstr(i, 30), "effort_constant": eff, "rythme_constant": dur}
    return {
        "cas": "3 — constitution d'une épargne de 60 000 DH, rendement 0 % vs 3 %",
        "source_parametres": SOURCE_E2C,
        "parametres": {"devise": "MAD", "unite_montants": "centimes", "cible_centimes": t, "epargne_initiale_centimes": 0,
                       "horizon_mois": n, "taux_compares_effectifs_bps": [0, 300], "versements": "fin de mois, dernier plafonné"},
        "resultats_verifies_math": {
            "statut": STATUS_VERIFIED,
            "note": "Rendement nul : effort = cible / horizon et durée = ⌈cible / versement⌉ sont exacts sans convention de taux ni d'arrondi d'intérêts.",
            "effort_0_pct_24_mois_centimes": t // n, "reste_division": t % n,
        },
        "resultats": out,
        "grilles_synthetiques": grids,
    }


def synthetic_loans() -> dict:
    synth = []
    for label, l, bps, n, keep in [
        ("G1 — contrôle arithmétique classique : 100 000 DH, 12 %, 12 mois", 10_000_000, 1200, 12, True),
        ("G2 — taux nul : 120 000 DH, 0 %, 48 mois", 12_000_000, 0, 48, True),
        ("G3 — bornes V1 : 1 000 000 DH, 30 %, 480 mois", 100_000_000, MAX_RATE_BPS, MAX_MONTHS, False),
    ]:
        summary, rows = loan_schedule(l, bps, n, keep)
        entry = {"libelle": label, "statut": STATUS_SYNTHETIC, "hypotheses": ["H4", "H5", "H6"],
                 "parametres": {"montant_finance_centimes": l, "taux_annuel_nominal_bps": bps, "duree_mois": n},
                 "resultats": summary, "analyse_ecart_derniere_echeance": loan_deviation_analysis(l, bps, n)}
        if keep:
            entry["echeancier"] = rows
        synth.append(entry)
    assert synth[0]["resultats"]["mensualite_arrondie_centimes"] == 888_488
    assert synth[1]["resultats"]["mensualite_arrondie_centimes"] == 250_000 and synth[1]["resultats"]["total_interets_centimes"] == 0
    return {
        "methodes": [
            "mensualité par formule fermée L·i / (1 − (1+i)^−n), en fractions exactes",
            "mensualité par somme géométrique (égalité rationnelle stricte)",
            "invariants : Σ capital amorti = montant financé, capital restant final = 0, Σ échéances = capital + intérêts, aucun amortissement négatif",
            "écart de dernière échéance : identité exacte −δ · S_n vérifiée pour la composante « arrondi de la mensualité »",
        ],
        "jeux_synthetiques": synth,
    }


def build() -> dict[str, dict]:
    meta = {"generateur": "references/decision-lab/generate_references.py", "etape": "E2 (clôturée ; H11–H12 validées à l'ouverture de E3 ; H15 ajoutée à la finalisation E3)",
            "precision_decimal": getcontext().prec, "tolerance_accord_methodes_centimes": str(TOL),
            "hypotheses": HYPOTHESES,
            "statuts": {STATUS_VERIFIED: "vérifié mathématiquement : vrai quelle que soit la convention métier, ≥ 2 méthodes concordantes",
                        STATUS_VALIDATED: "validé selon les conventions : calcul vérifié et toutes les hypothèses utilisées sont validées",
                        STATUS_CANDIDATE: "candidat : calcul vérifié, au moins une hypothèse à valider (voir hypotheses_a_valider)",
                        STATUS_MISSING: "manquant : aucune valeur produite",
                        STATUS_SYNTHETIC: "synthétique : paramètres de contrôle, hors cas de référence",
                        STATUS_INFO: "informatif : variante écartée par une convention validée"},
            "controles_externes": "aucun contrôle externe certifié disponible : « vérifié » ≠ « certifié métier »"}
    c1 = case1()
    c1["verification_du_generateur"] = synthetic_loans()
    out = {}
    for name, obj in (("case1_vehicle_loan", c1), ("case2_investment", case2()), ("case3_savings_goal", case3())):
        out[name] = {"meta": meta, **obj}
    coherence_checks(out)
    return out


def coherence_checks(out: dict[str, dict]) -> None:
    """Cohérence des trois référentiels (exécutée à chaque génération et à chaque --check)."""
    allowed = {STATUS_VERIFIED, STATUS_VALIDATED, STATUS_CANDIDATE, STATUS_MISSING, STATUS_SYNTHETIC, STATUS_INFO}
    metas = [json.dumps(o["meta"], sort_keys=True) for o in out.values()]
    assert len(set(metas)) == 1, "meta différente selon les fichiers"

    def walk(x, path):
        if isinstance(x, dict):
            if "statut" in x:
                assert x["statut"] in allowed, f"statut inconnu {path}"
            for h in x.get("hypotheses", []):
                assert h in HYPOTHESES, f"hypothèse inconnue {h} ({path})"
            if x.get("statut") in (STATUS_VALIDATED, STATUS_CANDIDATE) and "hypotheses" in x:
                assert x["statut"] == status_for(x["hypotheses"]), f"statut incohérent {path}"
                assert x["hypotheses_a_valider"] == [h for h in x["hypotheses"] if HYPOTHESES[h]["etat"] != "validee"], path
            for k, v in x.items():
                walk(v, f"{path}.{k}")
        elif isinstance(x, list):
            for j, v in enumerate(x):
                walk(v, f"{path}[{j}]")
        elif isinstance(x, float):
            raise AssertionError(f"flottant interdit {path}")
    for name, o in out.items():
        walk(o, name)
    c1, c2, c3 = out["case1_vehicle_loan"], out["case2_investment"], out["case3_savings_goal"]
    tr = c1["trajectoire_ecart_vs_reference"]
    assert tr["mois"][-1]["impact_patrimoine_net"] == tr["synthese"]["impact_patrimoine_net_fin_horizon"]
    assert -tr["synthese"]["impact_patrimoine_net_fin_horizon"] == tr["synthese"]["cout_total_decision"]
    assert c1["credit"]["resultats"]["total_interets_centimes"] == tr["synthese"]["dont_interets"]
    assert c1["credit"]["echeancier"][-1]["capital_restant_fin"] == 0
    for t in ("fin", "debut"):
        r = c2["resultats_candidats"][t]["arrondi_mensuel"]
        assert r["echeancier"][-1]["solde_cloture"] == r["valeur_finale_centimes"]
    assert c2["parametres"]["capital_initial_centimes"] + 120 * c2["parametres"]["versement_mensuel_centimes"] == c2["resultats_verifies_math"]["total_apporte_centimes"]
    for v in c3["resultats"].values():
        a = v["effort_constant"]["avec_arrondis"]
        assert a["echeancier"][-1]["solde_cloture"] == c3["parametres"]["cible_centimes"] and a["mois_atteinte"] == c3["parametres"]["horizon_mois"]
        assert [sc["versement_mensuel_centimes"] for sc in v["versement_constant"]["scenarios"]] == [250_000, 200_000, 300_000]
        for sc in v["versement_constant"]["scenarios"]:
            assert sc["echeancier"][-1]["solde_cloture"] == c3["parametres"]["cible_centimes"]
            if sc["atteint_dans_horizon_24_mois"]:
                assert sc["solde_au_mois_24_centimes"] == sc["solde_a_l_atteinte_centimes"] + sc["interets_apres_atteinte_jusqu_au_mois_24_centimes"]
                assert sc["solde_au_mois_24_centimes"] >= sc["solde_a_l_atteinte_centimes"] >= c3["parametres"]["cible_centimes"]
                assert sc["manque_au_mois_24_centimes"] == 0


def dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    data = build()
    check = "--check" in sys.argv
    bad = 0
    for name, obj in data.items():
        path = HERE / f"{name}.json"
        text = dump(obj)
        if check:
            ok = path.exists() and path.read_text(encoding="utf-8") == text
            print(f"{'OK ' if ok else 'DIFF'} {path.name}")
            bad += not ok
        else:
            path.write_text(text, encoding="utf-8")
            print(f"écrit {path.name}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
