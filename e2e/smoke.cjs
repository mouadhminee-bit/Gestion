/**
 * Test de bout en bout (parcours utilisateur réel dans un navigateur).
 * Prérequis : serveur lancé (npm run dev ou npm run preview) et Playwright disponible
 * (npm i -D playwright && npx playwright install chromium).
 * Usage : BASE_URL=http://localhost:5173 node e2e/smoke.cjs
 */
const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.BASE_URL || 'http://localhost:5173';
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
  await page.goto(BASE + '/'); await page.waitForTimeout(800);
  // Onboarding vierge
  await page.getByText('Commencer avec mes propres données').click();
  await page.getByPlaceholder('Ex : Sara').fill('Test');
  await page.locator('input[inputmode="decimal"]').fill('1000');
  await page.getByRole('button', { name: 'Démarrer' }).click();
  await page.waitForTimeout(1500);
  const bal = async () => (await page.locator('main').innerText()).match(/Solde total aujourd’hui[\s\S]*?([\d\s.  ]+,\d{2})\s*DH/)?.[1]?.replace(/[^\d,]/g, '');
  ok((await bal()) === '1000,00', 'solde initial 1000,00 affiché (' + (await bal()) + ')');
  // Ajout d'une dépense via le formulaire (clavier N)
  await page.keyboard.press('n'); await page.waitForTimeout(500);
  await page.getByLabel('Montant').fill('120,50');

  await page.getByRole('button', { name: 'Alimentation' }).first().click();
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await page.waitForTimeout(1000);
  ok((await bal()) === '879,50', 'dépense 120,50 → solde 879,50 (' + (await bal()) + ')');
  const kpi = await page.locator('main').innerText();
  ok(/Dépenses du mois[\s\S]*?120,50/.test(kpi), 'KPI dépenses du mois = 120,50');
  // Persistance après rechargement
  await page.reload(); await page.waitForTimeout(1500);
  ok((await bal()) === '879,50', 'persistance après rechargement');
  // Import CSV
  await page.goto(BASE + '/#/import'); await page.waitForTimeout(800);
  await page.setInputFiles('input[type=file]', path.join(__dirname, 'fixtures/releve.csv'));
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Continuer' }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Continuer' }).click(); await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Vérifier les lignes' }).click(); await page.waitForTimeout(500);
  const ver = await page.locator('main').innerText();
  ok(/3 à importer/.test(ver), '3 lignes valides à importer (erreur + doublon exclus)');
  ok(/1 en erreur/.test(ver) && /1 doublon/.test(ver), '1 erreur et 1 doublon détectés');
  await page.getByRole('button', { name: /Importer 3 opération/ }).click(); await page.waitForTimeout(1200);
  ok(/Import terminé/.test(await page.locator('main').innerText()), 'rapport final affiché');
  await page.goto(BASE + '/#/'); await page.waitForTimeout(1200);
  // Lignes antérieures au solde initial (déclaré aujourd'hui) : historique uniquement, solde inchangé.
  ok((await bal()) === '879,50', 'import antérieur au solde initial : solde inchangé (' + (await bal()) + ')');
  // Transfert : créer un 2e compte et transférer, total inchangé
  await page.goto(BASE + '/#/accounts'); await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Nouveau compte' }).click();
  await page.getByPlaceholder('Ex : Compte courant').fill('Épargne');
  await page.getByRole('button', { name: 'Enregistrer' }).click(); await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Transférer' }).first().click(); await page.waitForTimeout(400);
  await page.getByLabel('Montant').fill('500');
  await page.locator('select').nth(2).selectOption({ label: 'Épargne · MAD' });
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click(); await page.waitForTimeout(800);
  await page.goto(BASE + '/#/'); await page.waitForTimeout(1200);
  ok((await bal()) === '879,50', 'transfert interne : solde total inchangé (' + (await bal()) + ')');
  const k2 = await page.locator('main').innerText();
  ok(/Dépenses du mois[\s\S]*?410,80/.test(k2), 'transfert non compté en dépense (dépenses = 410,80)');
  // Mode confidentialité
  await page.getByLabel('Mode confidentialité').click(); await page.waitForTimeout(500);
  ok(!/\d,\d{2}\s*DH/.test(await page.locator('main').innerText()), 'mode confidentialité masque les montants');
  console.log('PAGE ERRORS:', errors.length ? errors : 'none');
  await browser.close();
})();
