import { describe, expect, it } from 'vitest';
import { ctxOf, emptySnapshot, tx, UID } from '@/test/fixtures';
import { monthPeriod, yearPeriod } from '../dates';
import type { RecurringOccurrence, RecurringRule, Transaction } from '../types';
import { recurringChargesReport } from './analytics';
import { forecastMonth } from './forecast';
import { linkCandidates, listOccurrences, pendingOccurrences } from './recurring';

const now = '2026-01-01T00:00:00.000Z';
const R = (id: string, label: string, amount: number, day: number, p: Partial<RecurringRule> = {}): RecurringRule => ({
  id, userId: UID, kind: 'expense', label, amount, currency: 'MAD', accountId: 'acc', categoryId: null, frequency: 'monthly', startDate: `2026-01-${String(day).padStart(2, '0')}`, active: true, createdAt: now, updatedAt: now, ...p,
});
/** Opération associée à une échéance (lien porté par la transaction). */
const paidTx = (ruleId: string, due: string, amount: number, date: string, p: Partial<Transaction> = {}) => tx({ accountId: 'acc', amount, date, label: 'Paiement', recurringRuleId: ruleId, recurringDueDate: due, ...p });

// Les sept charges de NEXORA (montants réels), échéances d'octobre 2026, au 31/10.
const rules = [
  R('loyer', 'Loyer', 280000, 1),
  R('wifi', 'Wifi Home', 35000, 5),
  R('claude', 'CLAUDE', 24107, 12),
  R('netflix', 'Netflix', 11907, 15),
  R('orange', 'Abonnements - Orange', 10000, 20),
  R('chatgpt', 'ChatGpt', 6000, 28),
  R('ms', 'Microsoft one', 1964, 31),
];
const today = '2026-10-31';
const october = [
  paidTx('wifi', '2026-10-05', 35000, '2026-10-05'), // payée
  tx({ accountId: 'acc', amount: 24107, date: '2026-10-12', label: 'CLAUDE' }), // saisie à la main → détectée
  paidTx('netflix', '2026-10-15', 11907, '2026-10-10'), // payée 5 jours avant l'échéance
  paidTx('orange', '2026-10-20', 6000, '2026-10-20'), // paiement partiel 60 / 100
  paidTx('chatgpt', '2026-10-28', 6000, '2026-10-28'), // payée
  tx({ accountId: 'acc', amount: 77886, date: '2026-10-03', label: 'Courses' }), // dépense non récurrente
  tx({ accountId: 'acc', type: 'income', amount: 1000000, date: '2026-10-01', label: 'Salaire' }),
];
const snap = (transactions: Transaction[], occurrences: RecurringOccurrence[] = [], recurringRules = rules) => emptySnapshot({ recurringRules, transactions, occurrences });
const report = (transactions: Transaction[], period = monthPeriod('2026-10'), at = today, occurrences: RecurringOccurrence[] = []) => {
  const s = snap(transactions, occurrences);
  return recurringChargesReport(ctxOf(s), s, period, at);
};
const row = (r: ReturnType<typeof report>, id: string) => r.rows.find((x) => x.rule.id === id)!;

describe('Charges récurrentes — exemple des sept charges (octobre 2026)', () => {
  const r = report(october);

  it('composition : part de chaque charge dans le total des engagements', () => {
    expect(r.monthlyTotal).toBe(368978);
    expect(row(r, 'loyer').composition).toBeCloseTo(0.7589, 4);
    expect(row(r, 'wifi').composition).toBeCloseTo(0.0949, 4);
    expect(r.rows.reduce((a, x) => a + (x.composition ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it('statut de chaque échéance, en réutilisant le rapprochement existant', () => {
    const st = Object.fromEntries(r.rows.map((x) => [x.rule.id, x.occurrences.map((o) => o.status).join()]));
    expect(st).toEqual({ loyer: 'overdue', wifi: 'paid', claude: 'matched', netflix: 'paid', orange: 'partial', chatgpt: 'paid', ms: 'upcoming' });
    const netflix = row(r, 'netflix').occurrences[0];
    expect(netflix.paidDate! < netflix.dueDate).toBe(true); // anticipé
    expect(row(r, 'orange').occurrences[0]).toMatchObject({ paid: 6000, remaining: 4000 });
  });

  it('dépenses réelles : seuls les décaissements confirmés sont « payés », les détections à part', () => {
    expect(r.expenses).toBe(160900);
    expect(r.paid).toBe(35000 + 11907 + 6000 + 6000);
    expect(r.detected).toBe(24107);
    expect(row(r, 'claude').paid).toBe(0);
    expect(row(r, 'wifi').paidShare).toBeCloseTo(35000 / 160900, 10);
    expect(r.paidShare).toBeCloseTo(58907 / 160900, 10);
    // Les décaissements confirmés et détectés sont inclus dans les dépenses : jamais au-delà.
    expect(r.paid + r.detected).toBeLessThanOrEqual(r.expenses);
  });

  it('engagements de la période : peuvent dépasser les dépenses enregistrées, avec le reste à payer', () => {
    expect(r.committed).toBe(368978);
    expect(r.coverage).toBeCloseTo(368978 / 160900, 10); // ≈ 229,3 %
    expect(r.remaining).toBe(280000 + 4000 + 1964); // loyer en retard, reliquat Orange, Microsoft à venir
  });

  it('revenus : charges mensuelles ÷ revenus perçus', () => {
    expect(r.monthlyIncome).toBe(1000000);
    expect(r.incomeShare).toBeCloseTo(0.368978, 6);
    expect(row(r, 'loyer').incomeShare).toBeCloseTo(0.28, 10);
    expect(report(october.filter((t) => t.type !== 'income')).incomeShare).toBeNull();
  });
});

describe('Charges récurrentes — cas de paiement', () => {
  it('paiement fractionné en plusieurs opérations', () => {
    const r = report([paidTx('loyer', '2026-10-01', 150000, '2026-10-01'), paidTx('loyer', '2026-10-01', 130000, '2026-10-09')]);
    expect(row(r, 'loyer').occurrences[0]).toMatchObject({ status: 'paid', paid: 280000, remaining: 0 });
    expect(row(r, 'loyer').occurrences[0].transactionIds).toHaveLength(2);
    expect(row(r, 'loyer').paid).toBe(280000);
  });

  it('paiement partiel puis complément : partielle, puis payée', () => {
    const first = paidTx('loyer', '2026-10-01', 100000, '2026-10-01');
    expect(row(report([first]), 'loyer').occurrences[0]).toMatchObject({ status: 'partial', remaining: 180000 });
    expect(row(report([first, paidTx('loyer', '2026-10-01', 180000, '2026-10-15')]), 'loyer').occurrences[0]).toMatchObject({ status: 'paid', remaining: 0 });
  });

  it('paiement supérieur au prévu : payé pour le montant réel', () => {
    const r = report([paidTx('loyer', '2026-10-01', 300000, '2026-10-01')]);
    expect(row(r, 'loyer').occurrences[0]).toMatchObject({ status: 'paid', paid: 300000, remaining: 0 });
    expect(row(r, 'loyer').paid).toBe(300000);
  });

  it('reliquat soldé par l’utilisateur : réglée, le reste n’est plus attendu', () => {
    const st: RecurringOccurrence = { id: 'orange:2026-10-20', userId: UID, ruleId: 'orange', dueDate: '2026-10-20', status: 'paid', updatedAt: now };
    const o = row(report([paidTx('orange', '2026-10-20', 6000, '2026-10-20')], monthPeriod('2026-10'), today, [st]), 'orange').occurrences[0];
    expect(o).toMatchObject({ status: 'paid', settled: true, remaining: 0, paid: 6000 });
  });

  it('paiement anticipé d’un mois sur l’autre : la dépense reste au mois du décaissement', () => {
    const early = paidTx('loyer', '2026-11-01', 280000, '2026-10-28');
    const oct = report([early]);
    expect(row(oct, 'loyer').paid).toBe(280000); // décaissé en octobre
    expect(row(oct, 'loyer').occurrences[0].status).toBe('overdue'); // l'échéance d'octobre reste due
    const nov = report([early], monthPeriod('2026-11'), '2026-11-05');
    expect(row(nov, 'loyer').occurrences[0]).toMatchObject({ status: 'paid', remaining: 0 }); // échéance de novembre soldée
    expect(row(nov, 'loyer').paid).toBe(0); // rien n'est décaissé en novembre
    expect(nov.expenses).toBe(0);
  });

  it('absence d’opération : en retard ou en attente, rien de payé', () => {
    const r = report([]);
    expect(row(r, 'loyer').occurrences[0].status).toBe('overdue');
    expect(row(r, 'ms').occurrences[0].status).toBe('upcoming');
    expect(r.paid).toBe(0);
    expect(r.paidShare).toBeNull();
    expect(r.remaining).toBe(368978);
  });

  it('échéance ignorée : ni prévue ni restante', () => {
    const st: RecurringOccurrence = { id: 'loyer:2026-10-01', userId: UID, ruleId: 'loyer', dueDate: '2026-10-01', status: 'skipped', updatedAt: now };
    const r = report([], monthPeriod('2026-10'), today, [st]);
    expect(row(r, 'loyer')).toMatchObject({ committed: 0, remaining: 0 });
  });

  it('une opération associée n’est jamais détectée pour une autre échéance', () => {
    // 350 DH associés au Wifi : une seconde règle identique ne peut pas la « détecter » aussi.
    const twin = R('wifi2', 'Wifi Home', 35000, 5);
    const s = snap([paidTx('wifi', '2026-10-05', 35000, '2026-10-05', { label: 'Wifi Home' })], [], [...rules, twin]);
    const r = recurringChargesReport(ctxOf(s), s, monthPeriod('2026-10'), today);
    expect(row(r, 'wifi2').occurrences[0].status).toBe('overdue');
    expect(r.paid + r.detected).toBe(35000);
  });

  it('vue Année avec un suivi commencé en octobre : revenus non dilués', () => {
    const r = report(october, yearPeriod(2026));
    expect(r.monthlyIncome).toBe(1000000);
    expect(r.paid).toBe(58907);
  });

  it('règles inactives et de revenu exclues ; filtre de compte appliqué', () => {
    const s = snap(october, [], [...rules, R('off', 'Ancien', 9999, 3, { active: false }), R('sal', 'Salaire', 1000000, 1, { kind: 'income' }), R('autre', 'Autre compte', 5000, 2, { accountId: 'acc2' })]);
    expect(recurringChargesReport(ctxOf(s), s, monthPeriod('2026-10'), today).rows).toHaveLength(8);
    expect(recurringChargesReport(ctxOf(s), s, monthPeriod('2026-10'), today, { accountIds: ['acc2'] }).rows.map((x) => x.rule.id)).toEqual(['autre']);
  });
});

describe('Échéances partielles dans les prévisions et le rapprochement', () => {
  it('seul le reliquat reste attendu dans le prévisionnel', () => {
    const occ = listOccurrences(rules, [], [paidTx('orange', '2026-10-20', 6000, '2026-10-20')], monthPeriod('2026-10'), '2026-10-10');
    const orange = pendingOccurrences(occ).find((o) => o.rule.id === 'orange')!;
    expect(orange).toMatchObject({ status: 'partial', remaining: 4000 });
    const s = emptySnapshot({ recurringRules: [R('orange', 'Abonnements - Orange', 10000, 20)], transactions: [paidTx('orange', '2026-10-20', 6000, '2026-10-05')] });
    expect(forecastMonth(ctxOf(s), s, '2026-10-10').expectedRecurringExpenses).toBe(4000);
  });

  it('compatibilité : une ancienne échéance « payée » pour un montant inférieur reste réglée', () => {
    const st: RecurringOccurrence = { id: 'loyer:2026-10-01', userId: UID, ruleId: 'loyer', dueDate: '2026-10-01', status: 'paid', transactionId: 't-old', updatedAt: now };
    const occ = listOccurrences(rules, [st], [paidTx('loyer', '2026-10-01', 250000, '2026-10-02', { id: 't-old' })], monthPeriod('2026-10'), today);
    expect(occ.find((o) => o.rule.id === 'loyer')).toMatchObject({ status: 'paid', settled: true, remaining: 0, transactionId: 't-old' });
  });

  it('candidats au rapprochement manuel : même type et devise, non associés ailleurs, les plus proches d’abord', () => {
    const loyer = rules[0];
    const own = paidTx('loyer', '2026-10-01', 100000, '2026-10-01', { id: 'own' });
    const elsewhere = paidTx('wifi', '2026-10-05', 35000, '2026-10-05', { id: 'elsewhere' });
    const near = tx({ id: 'near', accountId: 'acc', amount: 180000, date: '2026-10-03', label: 'Loyer' });
    const far = tx({ id: 'far', accountId: 'acc', amount: 1000, date: '2026-10-25', label: 'Divers' });
    const income = tx({ id: 'inc', accountId: 'acc', type: 'income', amount: 280000, date: '2026-10-01' });
    const usd = tx({ id: 'usd', accountId: 'acc', amount: 280000, date: '2026-10-01', currency: 'USD' });
    const old = tx({ id: 'old', accountId: 'acc', amount: 280000, date: '2026-06-01' });
    expect(linkCandidates(loyer, '2026-10-01', [far, elsewhere, income, usd, old, near, own]).map((t) => t.id)).toEqual(['near', 'own', 'far']);
  });
});
