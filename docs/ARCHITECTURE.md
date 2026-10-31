# NEXORA — Documentation technique

## 1. Vue d’ensemble

NEXORA est une application web monopage (SPA) **local-first** : toutes les données
sont stockées dans le navigateur (IndexedDB). Aucun serveur n’est nécessaire pour
l’utiliser. Une cible cloud (Supabase + PostgreSQL + Row Level Security) est
**préparée** (`supabase/schema.sql`, interface du repository) mais **non activée**.

```
┌────────────── Interface (React) ──────────────┐
│ pages/  features/  components/ui  charts      │  ← présentation uniquement
└───────────────▲───────────────────────────────┘
                │ instantané en lecture (useLiveQuery) / appels repository
┌───────────────┴───────────────┐   ┌──────────────────────────────────┐
│ data/ (Dexie, repository,     │   │ domain/ (TypeScript pur, testé)  │
│ démo, sauvegarde)             │──▶│ money, dates, types, validation, │
└───────────────────────────────┘   │ calc/ (règles financières)       │
                                    └──────────────────────────────────┘
```

* **domain/** ne dépend ni de React ni du navigateur : toutes les règles financières
  y sont centralisées et testées. Les pages n’effectuent aucun calcul financier
  propre : elles appellent les fonctions du domaine.
* **data/** : persistance (Dexie/IndexedDB), validation avant écriture, opérations
  atomiques, jeu de démonstration, sauvegarde/restauration.
* **app/** : contexte applicatif (instantané live, formateurs respectant le mode
  confidentialité, mois sélectionné, « aujourd’hui » dans le fuseau de l’utilisateur).

## 2. Dépendances principales

| Dépendance | Rôle |
|---|---|
| React 18, React Router 6 (HashRouter) | UI, navigation (le routage par hash fonctionne sur tout hébergement statique) |
| TypeScript 5 (strict) | typage explicite |
| Vite 6 | build et serveur de développement |
| Tailwind CSS 3 | design system par jetons CSS (thèmes sombre/clair) |
| Radix UI (dialog, tooltip, popover) | primitives accessibles (focus, clavier, ARIA), à la manière de shadcn/ui |
| Recharts 2 | graphiques |
| Dexie 4 + dexie-react-hooks | IndexedDB, migrations de schéma, requêtes live |
| lucide-react | icônes |
| Vitest 3 + fake-indexeddb | tests unitaires et d’intégration de la persistance |

## 3. Structure des dossiers

```
src/
  domain/                 Règles métier pures
    money.ts              Montants exacts (entiers), devises, parsing, formatage, arrondis
    dates.ts              Dates calendaires AAAA-MM-JJ, mois, périodes, fuseau
    types.ts              Modèle de données
    validation.ts         Validation des saisies (UI + repository)
    csv.ts                Lecture/écriture CSV, normalisation dates/montants
    duplicates.ts         Détection de doublons potentiels
    assistant.ts          Assistant à règles + interface AssistantProvider
    categories.seed.ts    Catégories initiales
    settings.ts           Paramètres par défaut (Maroc : MAD, fr-MA, Africa/Casablanca)
    calc/
      ledger.ts           Moteur comptable : flux, synthèse de période, soldes
      fx.ts               Taux de change datés, conversion
      budgets.ts          Budgets, seuils, projections
      goals.ts            Objectifs d’épargne
      recurring.ts        Échéances récurrentes (fins de mois, bissextiles), rapprochement
      debts.ts            Dettes et créances
      networth.ts         Patrimoine net et historique
      forecast.ts         Prévisions de fin de mois
      scenario.ts         Simulateur de scénarios
      analytics.ts        Séries, commerçants, dépenses exceptionnelles, comparaisons
      insights.ts         Moteur d’insights explicables
      notifications.ts    Alertes calculées (identifiants déterministes)
  i18n/
    core.ts               t() / td(), pluriels (Intl.PluralRules), chargement à la demande
    languages.ts          Les 24 langues : code, nom natif, sens d’écriture, locale par défaut
    I18nProvider.tsx      Langue active, attributs lang/dir, remontage au changement
    labels.ts             Libellés traduits paresseux, noms de devises (Intl)
    locales/              Un dictionnaire par langue (fr.ts = référence)
  data/
    db.ts                 Schéma Dexie versionné
    repository.ts         Accès aux données (scopé par utilisateur, transactions atomiques)
    demo.ts               Jeu de démonstration déterministe
  app/                    Contexte applicatif, navigation
  components/             UI réutilisable (ui/, layout/, charts/)
  features/               Briques fonctionnelles (formulaire de saisie, lignes, insights, exports)
  pages/                  14 écrans
  test/                   Fixtures et configuration de test
supabase/schema.sql       Schéma cloud cible avec RLS
e2e/smoke.cjs             Parcours utilisateur de bout en bout (Playwright)
```

## 4. Modèle de données

Toutes les entités personnelles portent `userId`, `id` (UUID), `createdAt`, `updatedAt`.

| Entité | Points clés |
|---|---|
| `UserSettings` | devise principale, locale, fuseau, format de date, thème, confidentialité, seuils d’alerte |
| `Account` | type, devise, solde initial **daté**, `archived`, `includeInTotal` |
| `Category` | `kind` (income / expense / savings), `nature` (fixed / variable), `parentId` (1 niveau), icône, couleur, `archived`, ordre |
| `Transaction` | `type` (expense, income, transfer, refund, adjustment, debt), `direction` (in/out), `amount` > 0 en unités minimales, devise = devise du compte, `transferId` + `counterpartAccountId` (transferts), `refundOfId`, `debtId`/`debtPaymentId`/`interestAmount`, `recurringRuleId`/`recurringDueDate`, `importBatchId`, `status` (cleared/pending), pièce jointe |
| `Budget` | mois `AAAA-MM`, `categoryId` (null = global), montant, seuils spécifiques |
| `SavingsGoal` + `GoalContribution` | cible, montant affecté, date cible, contribution souhaitée, compte suivi éventuel |
| `RecurringRule` + `RecurringOccurrence` | règle de fréquence ; seules les échéances traitées (payée / ignorée) sont stockées |
| `Debt` + `DebtPayment` | `direction` payable (= **Liability**) ou receivable (= **Receivable**), paiements principal + intérêts |
| `Asset` + `AssetValuation` | actifs valorisés manuellement, éventuellement liés à un compte |
| `ExchangeRate` | 1 base = rate quote, à une date |
| `NotificationState` | état lu / masqué d’une alerte calculée |
| `ImportBatch` | traçabilité des imports |

Relations : un transfert = **deux transactions** liées par `transferId` (une sortie,
une entrée), ce qui permet les transferts multidevises et la traçabilité des deux
côtés. Les entités référencées par l’historique (comptes, catégories) sont
**archivées** plutôt que supprimées.

Opérations réelles vs prévisionnelles : les transactions sont toujours réelles ; le
prévisionnel est **calculé** (échéances récurrentes non payées, projections) et
n’est jamais stocké comme transaction.

## 5. Règles métier

### Montants
* Entiers en unités minimales (centimes pour MAD ; 0 décimale pour JPY/XOF ; 3 pour TND/KWD).
* Saisie convertie par analyse de chaîne (aucun passage par un flottant) ; formats acceptés :
  `1 234,56`, `1.234,56`, `1,234.56`, `(12,50)`…
* Arrondis : demi vers l’extérieur, à l’unité minimale (pourcentages, conversions).

### Définitions (fonctions communes à tous les écrans)
| Indicateur | Définition |
|---|---|
| Revenus | transactions `income` + intérêts perçus sur créances |
| Dépenses | `expense` − `refund` + intérêts payés sur dettes |
| Épargne nette | Revenus − Dépenses |
| Taux d’épargne | Épargne nette ÷ Revenus ; « Non calculable » si revenus ≤ 0 |
| Solde d’un compte | solde initial + mouvements datés à partir de la date du solde initial |
| Solde total | somme des comptes actifs `includeInTotal`, convertis au dernier taux connu |
| Budget disponible | budget global (sinon somme des budgets de catégories) − dépenses du mois |
| Restant (budget) | budget − dépenses éligibles ; consommation = dépenses ÷ budget (non affichée si budget nul) ; écart = dépenses − budget |
| Progression objectif | constitué ÷ cible (affichage plafonné à 100 %) ; contribution nécessaire = restant ÷ mois restants |
| Patrimoine net | actifs (comptes une fois, valorisations, créances) − passifs (dettes) |

**Jamais revenus ni dépenses** : transferts internes (y compris vers l’épargne et
l’investissement), ajustements de solde, principal d’un emprunt / d’un prêt / d’un
remboursement de dette. Les catégories `savings` ne servent qu’à qualifier des transferts.

**Solde initial daté** : c’est un point d’ancrage. Une opération antérieure alimente
l’historique et les analyses de sa période, sans modifier le solde actuel (déjà inclus
dans le solde déclaré). L’interface le signale lors de la saisie et de l’import.

**Récurrences** : une règle ne crée jamais de transaction. « Marquer comme payée /
reçue » crée explicitement la transaction liée (montant et date ajustables). Une
transaction saisie manuellement qui correspond à une échéance (même compte, sens,
montant exact, ±5 jours, même catégorie ou libellé) est **détectée, à confirmer** : elle
n’est pas recomptée dans les prévisions, mais n’est jamais présentée comme réglée.

*Échéance et décaissement* : le lien est porté par la transaction (`recurringRuleId` +
`recurringDueDate` = échéance soldée) ; sa `date` reste celle du paiement réel. Un
paiement anticipé solde l’échéance sans déplacer la dépense vers son mois. Une échéance
peut être réglée par plusieurs opérations (paiement fractionné) ; une opération ne règle
qu’une seule échéance. « Associer des opérations » rattache des transactions existantes
(même type et devise, ±2 mois, non associées ailleurs) sans en créer.

*Statut d’une échéance* (calculé, jamais stocké sauf décision de l’utilisateur) :

| Statut | Règle | Libellé dépense / revenu |
|---|---|---|
| Payée intégralement | Σ opérations associées ≥ montant prévu | Payée / Reçue |
| Partielle | 0 < Σ associées < prévu ; reliquat attendu (prévisions, notifications) ; en retard si la date est passée | Payée / Reçue partiellement |
| Clôturée | état `paid` stocké et Σ < prévu : `closure: 'waived'` = reliquat abandonné par l’utilisateur ; sans marqueur = échéance marquée payée par une version antérieure au suivi des reliquats (conservée telle quelle, « Rouvrir » la rend partielle) | Clôturée |
| Détecté, à confirmer | opération correspondante non associée | Détecté, à confirmer |
| En retard / À venir / Ignorée | aucun paiement associé, date passée / future ; ignorée par l’utilisateur | — |

« En retard » (indicateur et notifications) = aucun paiement ou reliquat dû après la date
d’échéance.

**Charges récurrentes (Analyses)** : trois lectures séparées, jamais additionnées.
Composition = équivalent mensuel ÷ total des charges récurrentes. Dépenses réelles =
décaissements **confirmés** datés dans la période ÷ dépenses enregistrées (déjà incluses :
pas de double comptage) ; détections non confirmées, échéances de la période et reste à
payer affichés à part (échéances ÷ dépenses peut dépasser 100 %, avec explication).
Revenus = équivalent mensuel ÷ revenus perçus par mois suivi.

**Mois suivis** (dénominateur de « Par mois » et des revenus mensuels) : du mois de la
première opération enregistrée (tout type, virements compris) sur les comptes retenus
— tous, ou ceux du filtre de compte ; les filtres de catégorie, type et étiquette ne le
déplacent pas — jusqu’au mois en cours ou à la fin de la période, bornés à la période.
Un mois entamé compte pour un mois ; les mois sans opération après le début du suivi
comptent (revenus irréguliers : la moyenne inclut les mois sans revenu). Aucune
opération antérieure à la fin de la période → 0 mois, moyenne « non calculable ».

**Objectifs** : affectations, jamais ajoutés au patrimoine. Un objectif qui suit un
compte reflète son solde (l’argent reste compté une seule fois, via le compte).

**Investissements** : un actif lié à un compte remplace son solde comptable par la
dernière valorisation manuelle (une seule valorisation par compte, contrôlée).

**Multidevise** : aucune addition de devises différentes sans taux daté ≤ date de
valorisation ; sinon les montants sont affichés séparément et exclus des totaux.

**Prévisions** : solde actuel + récurrents attendus − dépenses variables projetées
(moyenne quotidienne observée sur 90 jours si ≥ 30 jours et ≥ 10 dépenses ; sinon
reste des budgets variables ; sinon « données insuffisantes »). Hypothèses affichées.

**Insights** : uniquement si les données sont comparables (même période du mois
précédent, ≥ 2 opérations par catégorie sur chaque période) ; chaque insight expose
son origine.

## 6. Persistance

* Base IndexedDB `nexora` via Dexie, schéma versionné (`db.version(n)`) ; une migration
  ajoute une version avec `.upgrade()`, sans modifier les versions publiées.
* L’interface lit un **instantané live** (`useLiveQuery`) ; toutes les écritures passent
  par `LocalRepository`, qui valide et exécute les opérations composées dans des
  transactions IndexedDB atomiques (transfert = 2 jambes, paiement de dette = paiement
  + transaction, etc.).
* `localStorage` / `sessionStorage` ne servent qu’à des préférences de confort (thème
  pour éviter le flash, dernier compte utilisé, filtres) — jamais aux données.
* Sauvegarde/restauration JSON complète (hors pièces jointes) ; exports CSV
  (séparateur `;`, BOM UTF-8, neutralisation des formules).

## 7. Passage au cloud (préparé)

1. Créer un projet Supabase, exécuter `supabase/schema.sql` (RLS activée et forcée).
2. Implémenter `SupabaseRepository` avec les mêmes méthodes que `LocalRepository`,
   en n’utilisant que la clé publique `anon` + la session de l’utilisateur.
3. Déplacer les opérations composées dans des fonctions RPC PostgreSQL
   (transactionnelles) et conserver les validations côté serveur (contraintes CHECK,
   triggers de cohérence de propriétaire).
4. Brancher l’authentification Supabase et sélectionner le backend via
   `VITE_DATA_BACKEND`.

Extension IA (facultative) : implémenter `AssistantProvider` via un **proxy serveur**
(la clé ne doit jamais être dans une variable `VITE_*`), n’envoyer que des agrégats
calculés, distinguer les réponses vérifiées des interprétations, interdire toute
modification sans confirmation.

## 8. Internationalisation

* `src/i18n/locales/fr.ts` est la source : il définit toutes les clés (`MessageKey`).
  Chaque autre dictionnaire est typé `Messages` — TypeScript refuse une clé manquante ou
  en trop. Les dictionnaires non français sont chargés à la demande (un fichier JS par
  langue, ~25 ko gzip).
* `t(clé, variables)` est une fonction pure, utilisée aussi par le domaine (insights,
  assistant, validations, prévisions). Interpolation `{nom}` ; pluriels sous forme
  d’objet `{ zero?, one, two?, few?, many?, other }` choisi par `Intl.PluralRules` de la
  langue active à partir de `count` (repli sur `other`).
* Au changement de langue, l’application est remontée : aucun texte n’est mis en cache
  dans la mauvaise langue. Le script de `index.html` applique `lang`/`dir` avant le
  premier rendu (pas de clignotement en RTL).
* RTL : utilitaires Tailwind logiques (`ms`/`me`, `ps`/`pe`, `start`/`end`,
  `text-start`…), icônes directionnelles retournées (`rtl:-scale-x-100`), graphiques
  forcés en `direction: ltr`.
* Montants : la langue ne change jamais la devise ; les formats numériques suivent la
  locale régionale choisie (par défaut celle de la langue, `fr-MA` pour le français).
* Assistant : les mots-clés `assist.kw.*` (listes séparées par `|`) sont comparés après
  normalisation (minuscules, accents et signes diacritiques retirés, ponctuation retirée,
  lettres ł/ı/đ/ø… repliées) ; les mots-clés français et anglais sont toujours actifs. Les
  noms de catégories sont reconnus même déclinés (« rozrywkę » ↔ « Rozrywka »).
* Import CSV : les en-têtes de colonnes sont aussi reconnus dans la langue active
  (`csv.date`, `csv.label`, `csv.amount`, `imp.col.debit`…).

Ajouter une langue :

1. Déclarer la langue dans `src/i18n/languages.ts` (code, nom natif, `dir`, locale).
2. Créer `src/i18n/locales/<code>.ts` (`const xx: Messages = { … }; export default xx;`)
   en partant de `en.ts` ; `npm run typecheck` signale toute clé manquante.
3. Points d’attention : `{pct}` déjà formaté avec « % » sauf pour `notif.budgetThreshold.title`,
   `assist.whatIf.text*`, `budget.dayOf`, `goal.realPct` (nombre brut) ; mots-clés de
   l’assistant sans accents ; `imp.letter.D/M/Y` et `set.dateFormat.*` ; en RTL, `fc.hint`
   dit « à droite ».
4. Pour une langue RTL, `dir: 'rtl'` suffit à inverser la mise en page ; ajouter si besoin
   une police Noto (`@fontsource-variable/…`) dans `index.css` et `tailwind.config.js`.
5. `npm test` : `src/i18n/i18n.test.ts` vérifie automatiquement les clés, les variables,
   les pluriels et que chaque question suggérée de l’assistant est comprise dans la langue.

Les traductions actuelles (hors français) ont été produites par IA : une relecture par des
locuteurs natifs reste à faire.

## 9. Limites connues

* Mode cloud, authentification et synchronisation multi-appareils : **non implémentés**
  (schéma et architecture prêts). Le test « isolation entre utilisateurs » porte sur le
  repository local (scoping par `userId`) ; les politiques RLS SQL n’ont pas été
  exécutées contre une instance Supabase.
* Traductions non relues par des locuteurs natifs (voir § 8). Les dates restent en
  calendrier grégorien pour toutes les langues.
* Pas de chiffrement au repos des données locales ; le mode confidentialité masque l’affichage.
* Taux de change et valorisations : saisie manuelle uniquement (aucune source externe).
* Notifications in-app uniquement (pas de push / e-mail).
* Les pièces jointes ne sont pas incluses dans la sauvegarde JSON.
* Transactions dans une devise différente de celle de leur compte : non gérées (la
  devise d’une opération est celle du compte ; utiliser un compte par devise).
* Une opération ne règle qu’une seule échéance : un virement unique couvrant plusieurs
  échéances (ex. deux loyers) ne peut pas être réparti entre elles. Il faudrait une table
  d’affectation (migration de schéma), reportée. Contournement : saisir une opération par
  échéance, ou associer l’opération à une échéance et clôturer l’autre.
* La détection automatique exige le montant exact (±5 jours) ; un paiement partiel saisi
  à la main se rattache par « Associer des opérations ».
* Le badge « Powered by Netlify » est injecté par l’hébergeur : sur mobile, une règle CSS
  (`#nl-badge-frame`) le place au-dessus de la barre de navigation.
