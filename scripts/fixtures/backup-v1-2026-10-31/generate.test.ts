/**
 * Générateur de la fixture « sauvegarde V1 du 31/10/2026 » (données 100 % FICTIVES).
 *
 * Ce fichier n'est PAS exécuté par la suite de tests du dépôt : `generate.sh` l'exécute
 * dans une copie du code EXACT du 31/10/2026 (commit 341f3da, identique pour les données
 * à 27defa5…341f3da), afin que la fixture soit produite par le code historique lui-même :
 * même `exportBackup`, mêmes règles d'écriture, même sérialisation que Settings.tsx
 * (`JSON.stringify(backup, null, 2)`).
 *
 * Couverture : 16 tables ; transfert multidevise ; sous-catégorie ; compte et catégorie
 * archivés ; remboursement ; ajustement ; import CSV ; budgets (global, catégorie, mois
 * suivants) ; objectif avec retrait ; échéances payée / partielle / clôturée / ignorée /
 * fractionnée / « payée pour moins » au format antérieur à 27defa5 ; dette avec origine et
 * paiements (avec / sans compte) ; actif et valorisations ; taux ; notifications ; pièce
 * jointe (non exportée en V1) ; liens historiques vers un compte supprimé.
 */
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.FIXTURE_OUT_DIR ?? '';
import { NexoraDB } from '@/data/db';
import { LocalRepository } from '@/data/repository';
import { generateDemoData } from '@/data/demo';
import type { TransactionDraft } from '@/domain/validation';

const U = 'local-user';
it('génère la fixture v1', async () => {
  if (!OUT) throw new Error('FIXTURE_OUT_DIR non défini (utiliser generate.sh)');
  const db = new NexoraDB('gen-v1');
  const repo = new LocalRepository(db, U);
  await repo.replaceWithSnapshot(generateDemoData(U, '2026-10-31', 'Sara'));
  await repo.updateSettings({ demoMode: false, displayName: 'Utilisateur fictif', privacyMode: true, budgetAlertThresholds: [70, 95], billReminderDays: 5 });
  let s = (await repo.snapshot())!;
  const bank = s.accounts.find((a) => a.type === 'bank')!;
  const cat = (k: string) => s.categories.find((c) => c.key === k)!;
  const d = (p: Partial<TransactionDraft>): TransactionDraft => ({ type: 'expense', amount: 1000, label: 'Fictif', date: '2026-10-20', categoryId: null, subcategoryId: null, accountId: bank.id, tags: [], status: 'cleared', ...p });

  const eur = await repo.createAccount({ name: 'Compte EUR fictif', type: 'bank', currency: 'EUR', initialBalance: 50000, initialBalanceDate: '2026-09-01', archived: false, includeInTotal: true, color: '#123456', order: 9, description: 'Compte de test' });
  await repo.createTransaction(d({ type: 'transfer', amount: 108600, toAccountId: eur.id, toAmount: 10000, label: '', date: '2026-10-21' }));
  const archived = await repo.createAccount({ name: 'Ancien compte', type: 'cash', currency: 'MAD', initialBalance: 0, initialBalanceDate: '2026-01-01', archived: false, includeInTotal: false, color: '#999999', order: 10 });
  await repo.archiveAccount(archived.id);
  const sub = await repo.createCategory({ name: 'Sous-catégorie fictive', kind: 'expense', parentId: cat('food').id, icon: 'Tag', color: '#aabbcc', archived: false, order: 99 });
  const oldCat = await repo.createCategory({ name: 'Catégorie archivée', kind: 'expense', parentId: null, icon: 'Tag', color: '#000000', archived: false, order: 100 });
  const [withSub] = await repo.createTransaction(d({ categoryId: cat('food').id, subcategoryId: sub.id, payee: 'Commerçant fictif', notes: 'Note fictive', tags: ['test', 'fictif'], paymentMethod: 'card', status: 'pending', amount: 4550 }));
  await repo.createTransaction(d({ categoryId: oldCat.id, amount: 1200 }));
  await repo.updateCategory(oldCat.id, { archived: true });
  await repo.createTransaction(d({ type: 'refund', categoryId: cat('food').id, refundOfId: withSub.id, amount: 1000, label: 'Remboursement fictif' }));
  await repo.createTransaction(d({ type: 'adjustment', direction: 'in', amount: 333, label: 'Ajustement fictif', notes: 'Écart de caisse fictif' }));
  // Pièce jointe (non exportée en V1, conservée dans la base Edge simulée).
  const attBytes = Uint8Array.from({ length: 2048 }, (_, i) => (i * 7) % 256);
  await repo.addAttachment(withSub.id, new File([attBytes], 'justificatif.pdf', { type: 'application/pdf' }));
  await repo.importTransactions({ fileName: 'releve-fictif.csv', rowCount: 3, importedCount: 2, skippedCount: 1, accountId: bank.id }, [
    d({ type: 'expense', amount: 2500, label: 'Import 1', categoryId: cat('food').id, tags: ['import'] }),
    d({ type: 'income', amount: 9000, label: 'Import 2', categoryId: cat('salary')?.id ?? s.categories.find((c) => c.kind === 'income')!.id, tags: ['import'], payee: 'Tiers fictif' }),
  ]);
  await repo.setBudget('2026-11', null, 900000, 'MAD', { alertThresholds: [80, 100], applyToFollowingMonths: 2 });
  await repo.setBudget('2026-11', cat('food').id, 250000, 'MAD');
  const goal = await repo.saveGoal({ name: 'Objectif fictif', description: 'desc', targetAmount: 1000000, currency: 'MAD', savedAmount: 0, targetDate: '2027-06-30', priority: 'high', linkedAccountId: bank.id, trackLinkedAccount: false, monthlyContribution: 50000, status: 'active', icon: 'Target', color: '#00ff00' });
  await repo.addGoalContribution(goal.id, 30000, '2026-10-01', 'Versement');
  await repo.addGoalContribution(goal.id, -5000, '2026-10-15');
  const rule = await repo.saveRecurringRule({ kind: 'expense', label: 'Abonnement fictif', amount: 20000, currency: 'MAD', accountId: bank.id, categoryId: cat('food').id, subcategoryId: sub.id, payee: 'Fournisseur', frequency: 'custom', customInterval: 2, customUnit: 'week', startDate: '2026-08-01', endDate: '2027-08-01', active: true, notes: 'n' });
  await repo.markOccurrencePaid(rule.id, '2026-08-01', { date: '2026-08-01', amount: 20000, accountId: bank.id });
  await repo.markOccurrencePaid(rule.id, '2026-08-15', { date: '2026-08-16', amount: 12000, accountId: bank.id }); // partiel
  await repo.markOccurrencePaid(rule.id, '2026-08-29', { date: '2026-08-29', amount: 8000, accountId: bank.id });
  await repo.settleOccurrence(rule.id, '2026-08-29'); // clôturée (closure: 'waived')
  await repo.skipOccurrence(rule.id, '2026-09-12');
  const [a1] = await repo.createTransaction(d({ amount: 10000, date: '2026-09-26', categoryId: cat('food').id }));
  const [a2] = await repo.createTransaction(d({ amount: 10000, date: '2026-09-27', categoryId: cat('food').id }));
  await repo.linkOccurrence(rule.id, '2026-09-26', [a1.id, a2.id]); // paiement fractionné
  // Ancienne échéance « payée pour moins » sans clôture (écrite par le code antérieur à 27defa5).
  const [legacy] = await repo.createTransaction(d({ amount: 5000, date: '2026-10-10', categoryId: cat('food').id }));
  await db.transactions.put({ ...legacy, recurringRuleId: rule.id, recurringDueDate: '2026-10-10' });
  await db.occurrences.put({ id: `${rule.id}:2026-10-10`, userId: U, ruleId: rule.id, dueDate: '2026-10-10', status: 'paid', transactionId: legacy.id, updatedAt: '2026-10-10T10:00:00.000Z' });
  const debt = await repo.createDebt({ label: 'Prêt fictif', type: 'borrowed', direction: 'payable', principal: 300000, currency: 'MAD', startDate: '2026-07-01', dueDate: '2027-07-01', counterparty: 'Ami fictif', interestRate: 3.5, installmentAmount: 25000, installmentFrequency: 'monthly', status: 'active', notes: '' }, { accountId: bank.id, date: '2026-07-01' });
  await repo.addDebtPayment(debt.id, { date: '2026-08-01', principal: 20000, interest: 1500, accountId: bank.id, note: 'Échéance' });
  await repo.addDebtPayment(debt.id, { date: '2026-09-01', principal: 20000, interest: 0 }); // sans compte
  await repo.saveAsset({ name: 'Actif fictif', type: 'vehicle', currency: 'MAD', archived: false, notes: 'note' }, { date: '2026-01-01', value: 8000000 });
  s = (await repo.snapshot())!;
  const asset = s.assets.find((a) => a.name === 'Actif fictif')!;
  await repo.addValuation(asset.id, '2026-10-01', 7500000, 'Décote');
  await repo.saveRate('EUR', 'MAD', 10.857, '2026-10-01');
  await repo.setNotificationState(['budget:global:2026-10:80', 'bill:x:2026-10-10'], { read: true });
  await repo.setNotificationState(['bill:x:2026-10-10'], { dismissed: true });
  // Liens historiques légitimement orphelins : compte sans opération supprimé, encore visé.
  const gone = await repo.createAccount({ name: 'Compte supprimé', type: 'ewallet', currency: 'MAD', initialBalance: 0, initialBalanceDate: '2026-01-01', archived: false, includeInTotal: true, color: '#111111', order: 11 });
  await repo.saveRecurringRule({ kind: 'income', label: 'Revenu fictif', amount: 1000, currency: 'MAD', accountId: gone.id, categoryId: null, frequency: 'monthly', startDate: '2026-01-05', active: false });
  await repo.saveGoal({ name: 'Objectif lié supprimé', targetAmount: 1000, currency: 'MAD', savedAmount: 0, priority: 'low', linkedAccountId: gone.id, trackLinkedAccount: true, status: 'paused', icon: 'Target', color: '#fff' });
  await repo.deleteAccount(gone.id);

  const backup = await repo.exportBackup();
  // Même sérialisation que Settings.tsx (31/10) : JSON.stringify(backup, null, 2).
  writeFileSync(join(OUT, 'backup-v1-2026-10-31.json'), JSON.stringify(backup, null, 2));
  const atts = await db.attachments.toArray();
  // Pièces jointes présentes dans la base au moment de l'export (non incluses en V1) :
  // simulent la base locale existante lors d'une restauration.
  writeFileSync(join(OUT, 'backup-v1-2026-10-31.local-attachments.json'), JSON.stringify(await Promise.all(atts.map(async (a) => ({ ...a, blob: undefined, bytes: Array.from(new Uint8Array(await a.blob.arrayBuffer())) })))));
  console.log('tables', Object.fromEntries(Object.entries(backup.data).map(([k, v]) => [k, v.length])));
});
