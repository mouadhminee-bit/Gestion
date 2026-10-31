# NEXORA — Synthèse de passation de session

État au 31/10/2026, commit `27defa5` sur `claude/nexora-finance-platform-81blaa`
(local = distant, arbre propre, 27 commits, aucune PR). Version publique vérifiée :
<https://mflous.netlify.app/#/>. Documents de référence : [`README.md`](../README.md) et
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (§ 5 : règles métier des récurrences et des
mois suivis ; § 9 : limites).

Légende : ✅ confirmé (preuve : code, commit, test ou vérification effectuée) ·
🟡 partiel · ⏳ à faire · ❓ à vérifier.

---

## 1. Vision du produit

* **Objectif** : « Personal Finance OS » — piloter ses finances personnelles avec des
  indicateurs **calculés, vérifiables, jamais inventés** (définition ou source affichée).
* **Utilisateurs cibles** : particuliers, configuration par défaut **Maroc** (français,
  MAD/DH, `Africa/Casablanca`, JJ/MM/AAAA, semaine au lundi, mois civil), 24 langues.
* **Proposition de valeur** : local-first (IndexedDB, aucune connexion bancaire, aucun
  serveur applicatif), montants exacts en unités minimales, assistant déterministe sans IA
  externe, interface premium sombre/clair responsive.

## 2. État technique ✅

* **Stack** : React 18 + TypeScript strict + Vite 6, Tailwind 3, react-router-dom 6
  (**routage par hash** `#/...`), Recharts 2, Dexie 4 (IndexedDB), Radix, lucide-react,
  polices Inter / Space Grotesk / Noto Sans Arabic & Hebrew. Tests : Vitest 3 +
  fake-indexeddb ; e2e Playwright (`e2e/smoke.cjs`).
* **Structure** : `src/domain/` (règles pures ; `calc/` = ledger, fx, budgets, goals,
  recurring, debts, networth, forecast, scenario, analytics, insights, notifications),
  `src/data/` (`db.ts` schéma Dexie versionné — **inchangé**, `repository.ts` scopé par
  `userId`, `demo.ts`), `src/i18n/`, `src/app/`, `src/components/`, `src/features/`
  (dont `recurring/` : `status.ts`, `RecurringChargesCard.tsx`,
  `LinkOccurrenceDialog.tsx`), `src/pages/` (14 écrans + Onboarding), `supabase/schema.sql`.
* **Routes** : `/`, `/transactions`, `/budgets`, `/accounts`, `/goals`, `/recurring`,
  `/debts`, `/net-worth`, `/analytics`, `/report`, `/forecast`, `/assistant`,
  `/settings`, `/import`.
* **Scripts** : `npm test` · `npm run typecheck` (= `tsc -b --noEmit` ; **`npm run lint`
  est le même typecheck**, pas d’ESLint) · `npm run build` · e2e : `npm run build` puis
  `npx vite preview --port 4173` et `BASE_URL=http://localhost:4173 node e2e/smoke.cjs`.
  ⚠ `npx tsc -p .` ne vérifie rien (tsconfig racine à références) : utiliser `tsc -b`.
* **Dernier passage (commit `27defa5`)** : **232 tests, 9 fichiers, verts** ;
  typecheck OK ; build OK ; e2e français **11/11**, aucune erreur de page.

## 3. Fonctionnalités

* ✅ **Terminées** (détail : README « Fonctionnalités et état réel ») : dashboard,
  transactions, catégories, comptes multidevises, budgets, objectifs, récurrences, dettes
  & créances, patrimoine, analyses & rapports imprimables, prévisions + simulateur,
  assistant à règles, import CSV, exports CSV/JSON, paramètres, notifications in-app,
  onboarding, mode confidentialité, thèmes, 24 langues.
* ✅ **Ajouté dans cette session (commits `6e5f81f`, `331cecb`, `27defa5`)** :
  * **Carte « Dépenses récurrentes »** (Analyses) en 3 onglets jamais mélangés :
    Composition (mensuel ÷ total des charges, Σ = 100,0 %) ; Dépenses réelles
    (décaissements **confirmés** datés dans la période ÷ dépenses enregistrées ; détectés
    non confirmés, échéances de la période — peut dépasser 100 % avec explication — et
    reste à payer affichés à part) ; Revenus (mensuel ÷ revenus perçus par mois suivi).
    Pourcentages à 1 décimale fixe, montants selon la devise.
  * **Échéance ≠ décaissement** : la transaction porte le lien (`recurringRuleId` +
    `recurringDueDate`) ; sa `date` reste celle du paiement réel (paiement anticipé non
    déplacé). Une échéance peut être réglée par plusieurs opérations ; une opération ne
    règle qu’une échéance.
  * **Rapprochement manuel** « Associer des opérations » (total, partiel, fractionné,
    anticipé, excédent), dissocier, **Clôturer** (reliquat abandonné, `closure: 'waived'`),
    **Rouvrir**. Aucune transaction créée lors d’une association.
  * **Statuts** : Payée / Reçue (intégralement) · Payée / Reçue partiellement (reliquat
    dû ; rouge si en retard) · Clôturée (abandon explicite, ou ancienne échéance marquée
    payée pour moins — donnée jamais réécrite) · Détecté, à confirmer · En retard ·
    À venir · Ignorée. « Reçue » pour les revenus, « Payée » pour les dépenses.
  * **Retards** : indicateur et notifications incluent les reliquats dus après échéance ;
    prévisions, insights et notifications n’attendent que le reliquat.
  * **« Moyenne / mois »** (Analyses) : ÷ **mois suivis** (méthode : ARCHITECTURE § 5) ;
    0 mois → « non calculable ».
  * **Badge Netlify** : règle CSS `#nl-badge-frame` (mobile < lg) qui le place au-dessus
    de la barre de navigation (vérifié sur le site public : 5 boutons cliquables).
* 🟡 **Préparées, non activées** : mode cloud Supabase (schéma + RLS, jamais exécutés),
  extension IA (`AssistantProvider`, aucun appel externe).
* ⏳ **Non implémentées** : authentification / synchro multi-appareils, chiffrement au
  repos, push / e-mail, sources externes de taux, pièces jointes dans la sauvegarde JSON,
  transactions en devise ≠ devise du compte, **répartition d’une opération sur plusieurs
  échéances** (reporté par décision utilisateur : nécessiterait une migration).

## 4. Internationalisation ✅ (relecture native à faire)

* 24 langues (`src/i18n/languages.ts`) : fr (référence), en, ar, es, pt, de, it, nl, tr,
  ru, uk, pl, ro, sv, el, cs, he, fa, hi, zh, ja, ko, id, vi ; **ar, he, fa en RTL**.
* Règles : `fr.ts` source (`MessageKey`), autres typés `Messages` ; pluriels via
  `Intl.PluralRules` ; `{pct}` déjà formaté avec % sauf `notif.budgetThreshold.title`,
  `assist.whatIf.textCategory/Total`, `budget.dayOf`, `budget.thresholdsHint`,
  `goal.realPct`. Mots-clés `assist.kw.*` sans accents ; fr + en toujours actifs.
  Calendrier grégorien imposé (`gregorian()`).
* Cette session : ~55 clés ajoutées / modifiées dans les 24 langues (carte récurrente,
  rapprochement, statuts, vocabulaire « reçu », mois suivis). En RTL, montants et
  pourcentages isolés par `<bdi>` dans la carte (vérifié ar / he / fa).
* `src/i18n/i18n.test.ts` (79 tests) : clés, variables, pluriels, assistant, pourcentages
  formatés une seule fois et à décimale fixe dans les 24 langues.
* ❓ Traductions **produites par IA, non relues** par des natifs.

## 5. Interface et expérience utilisateur

* ✅ Design system maison, navigation latérale + barre mobile, RTL logique, grilles
  `grid-cols-1` sous breakpoint, tableau du simulateur en `overflow-x-auto`.
* ✅ Vérifié dans cette session (Playwright, Chromium ; ordinateur 1440 et émulation
  iPhone 13) : carte à 3 onglets, dialogue d’association, statuts partiel / clôturé /
  rouvert / en retard, prévisions avec reliquat, « Moyenne / mois », aucun débordement,
  aucune erreur console ; site public : badge au-dessus de la barre.
* ❓ Non vérifié : Safari réel sur iPhone, thème clair pour les nouveaux écrans,
  impression du rapport en RTL.

## 6. État du code (vérifié par `git`)

* Branche : `claude/nexora-finance-platform-81blaa` ; `HEAD` = `origin` = `27defa5`
  (avant le commit de ce fichier) ; arbre propre ; 27 commits ; aucune PR.
* Derniers commits : `27defa5` statuts de clôture, vocabulaire revenus, mois suivis,
  badge mobile · `331cecb` charges récurrentes en 3 lectures + rapprochement manuel ·
  `6e5f81f` part récurrente sur mois suivis · `5133522` passation · `30cf76f` calendrier
  grégorien.
* Aucune migration de schéma Dexie dans cette session (champ optionnel `closure` sur
  `RecurringOccurrence`, non indexé ; la restauration JSON recopie les échéances telles
  quelles).

## 7. Déploiement ✅

* **Architecture** : déploiement **automatique** GitHub → Netlify ; **tout push sur la
  branche déclenche un déploiement** de <https://mflous.netlify.app/>. L’absence de
  `NETLIFY_AUTH_TOKEN` dans l’environnement n’empêche pas le déploiement.
* Vérifié pour `27defa5` : publication ≈ 20 s après le push ; les 77 fichiers publiés
  sont identiques octet par octet au build local ; règle CSS du badge servie.
* Accès réseau : `mflous.netlify.app` a été autorisé par l’utilisateur dans les réglages
  de l’environnement (sinon 403 du proxy). Le tableau de bord Netlify reste inaccessible
  d’ici ; GitHub n’affiche ni statut ni déploiement Netlify sur les commits.
* Méthode de vérification : comparer `assets/index-*.js` servi à celui de `dist/`
  (puis `cmp` de chaque fichier) ; contrôle fonctionnel Playwright sur le site public
  avec les données de démo (profil isolé, jamais les données réelles).
* `netlify.toml` : build `npm run build`, publish `dist`, Node 22, repli SPA, en-têtes de
  sécurité ; `VITE_DATA_BACKEND=local` n’est lu nulle part (inerte).

## 8. Bugs et corrections

* ✅ Résolus cette session :
  * Part récurrente gonflée (637 %) : division par les mois entamés d’une période sans
    données → mois suivis (`6e5f81f`).
  * 174 % (vue Mois) : dépenses enregistrées < loyer non saisi → indicateur repensé en
    3 lectures ; détections non confirmées jamais comptées comme payées.
  * Double comptage possible d’un paiement partiel (prévisions attendaient le montant
    plein) → seul le reliquat est attendu.
  * Badge Netlify masquant +, Budgets, Plus sur iPhone → CSS.
  * Ordre montant / % inversé en RTL dans la carte → `<bdi>`.
* ❓ À surveiller / limites :
  * « Annuler » une échéance réglée par « Marquer payée / reçue » (nouvelle version) ne
    propose plus de supprimer l’opération créée : elle est seulement dissociée (à
    supprimer depuis Opérations). Les anciennes échéances gardent la proposition.
  * Détection automatique : montant exact, ±5 jours ; un paiement partiel saisi à la main
    se rattache via « Associer des opérations ».
  * Candidats au rapprochement : même type et devise, ±62 jours, non associés ailleurs.
  * Collisions possibles de mots-clés de l’assistant (scripts sans espaces / marques
    combinantes).

## 9. Décisions déjà prises (ne pas remettre en cause sans raison)

* Local-first IndexedDB ; Supabase seulement préparé ; **données de démo fictives
  uniquement** ; ne jamais modifier ni réinitialiser les données réelles de l’utilisateur
  (Edge) — tests et captures uniquement dans des profils de navigateur isolés.
* Montants entiers ; transferts = 2 transactions ; prévisionnel jamais stocké ;
  archivage plutôt que suppression avec historique.
* Récurrences : jamais de transaction créée automatiquement ; trois indicateurs séparés
  (engagements prévisionnels / décaissements réels / revenus perçus) ; statut détecté
  « à confirmer » réutilisant le rapprochement existant ; revenus de référence = revenus
  réellement perçus ; anciennes données jamais transformées automatiquement ; une
  opération = une échéance (répartition multi-échéances reportée, sans migration).
* Assistant déterministe à règles ; français = référence ; calendrier grégorien ;
  routage par hash.
* Git : travailler et pousser uniquement sur `claude/nexora-finance-platform-81blaa`
  (`git push -u origin <branche>`) ; **pousser = déployer** : ne pousser qu’avec l’accord
  explicite de l’utilisateur quand il l’a demandé ; pas de PR sans demande ; messages de
  commit terminés par les lignes `Co-Authored-By` / `Claude-Session` ; aucun identifiant
  de modèle dans le code ou les commits ; ne jamais demander de jeton en clair.

## 10. Prochaines étapes (sur demande de l’utilisateur)

1. Validation fonctionnelle sur iPhone réel (Safari) et dans Edge avec les données
   réelles (rechargement de l’onglet pour charger `27defa5`).
2. Arbitrer : retrouver la suppression de l’opération créée lors d’« Annuler » (marqueur
   à ajouter sur l’échéance ou la transaction).
3. Contrôle du thème clair et de l’impression RTL ; captures des autres langues.
4. Relecture native des traductions.
5. Plus tard : répartition d’une opération sur plusieurs échéances (migration), et les
   chantiers ⏳ du § 3.

## 11. Instructions de reprise

* **Immédiatement** : `cd /home/user/Gestion && git status && git log --oneline -3` ;
  vérifier `HEAD` = `origin/claude/nexora-finance-platform-81blaa` ; `npm test`
  (attendu **232** verts) ; lire ce fichier puis attendre la demande de l’utilisateur.
* **Vérifier la version publique** : `curl -sS https://mflous.netlify.app/ | grep -o
  'assets/index-[^"]*\.js'` comparé à `dist/index.html` après `npm run build`.
* **Ne pas refaire** : dictionnaires, RTL, tests i18n, carte récurrente, rapprochement
  manuel, statuts, mois suivis, correctif du badge, `netlify.toml`, documentation.
* **Ne pas** : pousser sans accord quand l’utilisateur l’a exigé, créer une PR non
  demandée, toucher aux données réelles, introduire des données réelles dans la démo.
* **Piège shell** : ne jamais arrêter le serveur de prévisualisation avec
  `pkill -f "vite preview"` ou `ps … | grep "vite preview"` (tue le shell courant) ;
  utiliser `fuser -k 4173/tcp`.
