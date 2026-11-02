/**
 * Parcours E2E sauvegarde / restauration v2 (navigateur réel, données FICTIVES).
 *
 * Isolation : `chromium.launch()` + `browser.newContext()` = profil temporaire vierge,
 * détruit à la fermeture. Aucun accès à un profil existant (Edge, Chrome…) ni à sa
 * base IndexedDB `nexora`. Les fichiers téléchargés sont écrits dans un dossier
 * temporaire supprimé à la fin.
 *
 * Prérequis : serveur lancé (npm run build && npm run preview) et Playwright disponible.
 * Usage : BASE_URL=http://localhost:4173 node e2e/backup.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:4173';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-e2e-backup-'));

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ok = (c, m) => {
    console.log((c ? 'PASS ' : 'FAIL ') + m);
    if (!c) process.exitCode = 1;
  };
  const main = async () => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
  const kpiExpenses = async () => (await main()).match(/Dépenses du mois\s*([\d\s.  ]+,\d{2})/)?.[1]?.replace(/[^\d,]/g, '');
  const settings = async () => {
    await page.goto(BASE + '/#/settings');
    await page.waitForTimeout(900);
  };
  const dashboard = async () => {
    await page.goto(BASE + '/#/');
    await page.waitForTimeout(1200);
  };

  // 1. Jeu de démonstration (fictif) + opération marqueur 777,77.
  await page.goto(BASE + '/');
  await page.waitForTimeout(800);
  await page.getByText('Explorer avec des données de démonstration').click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('n');
  await page.waitForTimeout(500);
  await page.getByLabel('Montant').fill('777,77');
  await page.getByRole('button', { name: 'Alimentation' }).first().click();
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.waitForTimeout(1000);
  await dashboard();
  const kpiA = await kpiExpenses();
  ok(!!kpiA, `KPI dépenses du mois (jeu A) lu : ${kpiA}`);

  // 2. Export de la sauvegarde A.
  await settings();
  const [dlA] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exporter une sauvegarde (JSON)' }).click()]);
  const fileA = path.join(tmp, 'A.json');
  await dlA.saveAs(fileA);
  const backupA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  ok(backupA.formatVersion === 2 && Array.isArray(backupA.data.attachments), 'export au format v2 (pièces jointes incluses)');
  const txA = backupA.data.transactions.length;

  // 3. Autre jeu (nouveaux identifiants) + filtre sur un compte de ce jeu + mois mémorisé.
  await page.getByRole('button', { name: 'Réinitialiser le jeu de démonstration' }).click();
  await page.getByRole('button', { name: 'Réinitialiser', exact: true }).click();
  await page.waitForTimeout(1500);
  await dashboard();
  const kpiB = (await kpiExpenses()) ?? '';
  await page.goto(BASE + '/#/transactions');
  await page.waitForTimeout(800);
  // Filtre mémorisé visant un identifiant absent du fichier A, et mois sans données.
  await page.evaluate(() => sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ period: 'all', accountId: 'compte-du-jeu-B' })));
  await page.evaluate(() => sessionStorage.setItem('nexora.month', '2001-01'));

  // 4. Fichier invalide (table absente) : refus, aucune écriture, aucun téléchargement.
  await settings();
  const bad = { ...backupA, data: { ...backupA.data } };
  delete bad.data.accounts;
  const badFile = path.join(tmp, 'invalide.json');
  fs.writeFileSync(badFile, JSON.stringify(bad));
  let unexpectedDownload = false;
  const onDl = () => (unexpectedDownload = true);
  page.on('download', onDl);
  await page.setInputFiles('[data-testid="restore-input"]', badFile);
  await page.waitForTimeout(1200);
  const bodyBad = await page.locator('body').innerText();
  ok(/Sauvegarde refusée/.test(bodyBad) && /Table absente du fichier : accounts/.test(bodyBad), 'fichier invalide refusé avec message explicite');
  ok((await page.locator('[data-testid="restore-preview"]').count()) === 0, 'aucun aperçu pour un fichier refusé');
  page.off('download', onDl);
  ok(!unexpectedDownload, 'aucun téléchargement pour un fichier refusé');

  // 5. Restauration de A : aperçu, confirmation, sauvegarde de sécurité téléchargée.
  await page.setInputFiles('[data-testid="restore-input"]', fileA);
  await page.waitForSelector('[data-testid="restore-preview"]', { timeout: 5000 });
  const previewTx = await page.locator('[data-testid="restore-preview"] tr[data-table="transactions"]').innerText();
  ok(previewTx.includes(String(txA)), `aperçu : transactions du fichier = ${txA}`);
  const [safety] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Restaurer', exact: true }).click()]);
  const safetyPath = path.join(tmp, 'securite.json');
  await safety.saveAs(safetyPath);
  ok(/^nexora-securite-.*\.json$/.test(safety.suggestedFilename()), `sauvegarde de sécurité téléchargée : ${safety.suggestedFilename()}`);
  const safetyFile = JSON.parse(fs.readFileSync(safetyPath, 'utf8'));
  ok(safetyFile.formatVersion === 2 && safetyFile.data.transactions.length > 0, 'sauvegarde de sécurité lisible (état précédent)');
  await page.waitForTimeout(1200);
  ok(/Sauvegarde restaurée/.test(await page.locator('body').innerText()), 'confirmation de restauration affichée');
  const storage = await page.evaluate(() => ({ f: sessionStorage.getItem('nexora.tx-filters'), m: sessionStorage.getItem('nexora.month') }));
  ok(storage.f === null && storage.m !== '2001-01', `filtres effacés, mois repositionné (${storage.m})`);

  // 6. Interface : données restaurées visibles, KPI identiques au jeu A.
  await page.goto(BASE + '/#/transactions');
  await page.waitForTimeout(1000);
  ok(/777,77/.test(await main()), 'opération marqueur du jeu A visible dans la liste');
  await dashboard();
  ok((await kpiExpenses()) === kpiA, `KPI dépenses du mois restauré (${await kpiExpenses()} = ${kpiA})`);

  // 6 bis. Annulation immédiate (P18) : bandeau visible partout, retour à l'état B.
  const banner = page.locator('[data-testid="restore-undo-banner"]');
  ok((await banner.count()) === 1, 'bandeau « Annuler la restauration » visible (tableau de bord)');
  await banner.getByRole('button', { name: 'Annuler la restauration' }).click();
  await page.getByRole('button', { name: "Revenir à l'état précédent" }).click();
  await page.waitForTimeout(1500);
  ok(/État précédent rétabli/.test(await page.locator('body').innerText()), 'annulation confirmée');
  ok((await banner.count()) === 0, 'bandeau retiré après annulation');
  ok((await kpiExpenses()) === kpiB, `KPI revenu à l’état précédent (${await kpiExpenses()} = ${kpiB})`);
  await page.goto(BASE + '/#/transactions');
  await page.waitForTimeout(1000);
  ok(!/777,77/.test(await main()), 'opération marqueur absente après annulation');

  // 6 ter. Nouvelle restauration de A (pour la persistance) : annulation de nouveau proposée.
  await settings();
  await page.setInputFiles('[data-testid="restore-input"]', fileA);
  await page.waitForSelector('[data-testid="restore-preview"]', { timeout: 5000 });
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Restaurer', exact: true }).click()]);
  await page.waitForTimeout(1500);
  ok((await banner.count()) === 1, 'bandeau d’annulation après la nouvelle restauration');

  // 7. Persistance après rechargement ; l'annulation (mémoire de l'onglet) n'est plus proposée.
  await dashboard();
  await page.reload();
  await page.waitForTimeout(1500);
  ok((await kpiExpenses()) === kpiA, 'données restaurées persistantes après rechargement');
  ok((await banner.count()) === 0, 'après rechargement : annulation immédiate plus disponible (limite documentée)');

  // 8. Sauvegarde V1 historique (31/10/2026, FICTIVE, fixture du dépôt) : migrée et restaurée.
  const v1Path = path.join(__dirname, '..', 'src', 'data', 'backup', '__fixtures__', 'backup-v1-2026-10-31.json');
  await settings();
  await page.setInputFiles('[data-testid="restore-input"]', v1Path);
  await page.waitForSelector('[data-testid="restore-preview"]', { timeout: 5000 });
  const pv = await page.locator('[data-testid="restore-preview"]').innerText();
  ok(/Ancien format de sauvegarde \(v1\), converti au format v2/.test(pv) && /3 avertissements/.test(pv), 'V1 du 31/10 : migration et avertissements affichés');
  await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Restaurer', exact: true }).click()]);
  await page.waitForTimeout(1500);
  await page.goto(BASE + '/#/transactions');
  await page.waitForTimeout(800);
  await page.evaluate(() => sessionStorage.setItem('nexora.tx-filters', JSON.stringify({ period: 'all' })));
  await page.reload();
  await page.waitForTimeout(1500);
  ok(/Commerçant fictif|Remboursement fictif|Import 1/.test(await main()), 'V1 du 31/10 : opérations historiques visibles');

  console.log('PAGE ERRORS:', errors.length ? errors : 'none');
  if (errors.length) process.exitCode = 1;
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  fs.rmSync(tmp, { recursive: true, force: true });
});
