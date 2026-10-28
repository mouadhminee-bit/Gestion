# NEXORA — Personal Finance OS

Plateforme de gestion des finances personnelles : comptes, transactions, budgets,
objectifs, paiements récurrents, dettes, patrimoine, analyses, prévisions et assistant —
avec des indicateurs **calculés, vérifiables et jamais inventés**.

* Interface premium sombre/clair, responsive (mobile d’abord), animations sobres
  respectant « réduire les animations ».
* Configuration initiale Maroc : français, **MAD (DH)**, `Africa/Casablanca`,
  JJ/MM/AAAA, semaine commençant le lundi, période budgétaire = mois civil.
* **Local-first** : données dans IndexedDB (navigateur), aucune connexion bancaire,
  aucun serveur requis. Architecture cloud (Supabase + RLS) préparée.

Documentation technique : [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Démarrage

Prérequis : Node.js ≥ 18 (testé avec Node 22) et npm.

```bash
npm install          # installer les dépendances
npm run dev          # lancer en local → http://localhost:5173
npm test             # exécuter les tests unitaires et d'intégration (Vitest)
npm run typecheck    # vérification TypeScript stricte
npm run build        # construire la version de production (dossier dist/)
npm run preview      # servir la version de production → http://localhost:4173
```

Test de bout en bout (optionnel, nécessite Playwright et un serveur lancé) :

```bash
npm i -D playwright && npx playwright install chromium
npm run dev &                                   # dans un autre terminal
BASE_URL=http://localhost:5173 npm run test:e2e
```

Configuration : copier `.env.example` vers `.env.local` si besoin. Aucune variable
n’est nécessaire en mode local ; le fichier ne contient aucun secret.

`dist/` est un site statique (routage par hash) déployable sur n’importe quel
hébergement statique.

## Données de démonstration

Au premier lancement, choisissez **« Explorer avec des données de démonstration »**
(profil **fictif** en MAD sur 6 mois : 13 000 DH de revenus, loyer 2 800 DH,
5 comptes dont un en EUR, budgets, objectifs, récurrences, crédit auto, prêt à un
proche, remboursement mutuelle, dépenses exceptionnelles, valorisations).
Les données sont générées de façon déterministe à partir de la date du jour ; un badge
« Démo / Données fictives » est affiché tant qu’elles sont actives.

* **Réinitialiser** : Paramètres → Données → *Réinitialiser le jeu de démonstration*.
* **Repartir de zéro** : Paramètres → Données → *Repartir de zéro*.

## Fonctionnalités et état réel

| Module | État | Détails |
|---|---|---|
| Dashboard | ✅ Opérationnel | 6 KPI avec définitions, revenus vs dépenses (3/6/12 mois), évolution du solde, répartition, taux d’épargne, mois vs mois précédent, objectifs, insights, activité récente |
| Transactions | ✅ | 5 types de saisie (dépense, revenu, transfert, remboursement reçu, ajustement justifié), saisie rapide (touche **N**), catégories fréquentes, détails repliés, justificatif (image/PDF), recherche, filtres (période, catégorie, compte, type, montant), tri, sélection multiple (suppression, recatégorisation), chargement progressif, export CSV filtré, détection de doublons |
| Catégories | ✅ | Structure initiale complète, création, sous-catégories, icône, couleur, nature fixe/variable, réorganisation, archivage (suppression seulement si inutilisée) |
| Comptes | ✅ | 6 types, multidevise, solde initial daté, archivage, historique + courbe 90 j, transfert, périmètre du solde total, export CSV |
| Budgets | ✅ | Global + par catégorie/sous-catégorie, copie du mois précédent, application aux mois suivants, seuils d’alerte, restant / consommation / écarts / projection, historique 6 mois, export CSV |
| Objectifs | ✅ | Progression plafonnée, contribution nécessaire, écart, date estimée, objectifs atteints / dépassés, suivi de compte, affectations et historique |
| Récurrences | ✅ | 7 fréquences dont personnalisée, fins de mois et bissextiles, échéancier, payer (création explicite de l’opération), ignorer, associer un paiement détecté, annuler |
| Dettes & créances | ✅ | 6 types, mouvement initial optionnel, remboursements principal/intérêts, restant dû, retards, historique |
| Patrimoine | ✅ | Actifs/passifs, répartition, évolution 12 mois, variation mensuelle, valorisations manuelles marquées « Estimation » |
| Analyses & rapports | ✅ | Filtres (période, catégorie, compte, type, étiquette), comparaison explicite, fixes/variables, commerçants, moyennes, soldes, patrimoine, récurrents, exceptionnels ; rapports mensuel / trimestriel / annuel imprimables (PDF via le navigateur) |
| Prévisions | ✅ | Solde fin de mois en cascade, méthode et hypothèses affichées, risque budgétaire, simulateur de scénarios (sans modification des données) |
| Assistant | ✅ (règles) | Questions en langage naturel sur 10 intentions, réponses chiffrées avec source ; données insuffisantes signalées |
| Import CSV | ✅ | Assistant : fichier → aperçu → colonnes → dates/montants → catégories → vérification (corrections, erreurs, doublons) → rapport |
| Export | ✅ | CSV transactions / comptes / budgets, sauvegarde & restauration JSON |
| Paramètres | ✅ | Profil, devise, formats, fuseau, thème, symbole DH/MAD, confidentialité, notifications, seuils, taux de change, données |
| Notifications | ✅ in-app | Budgets, échéances, dettes, objectifs ; sans répétition (état lu/masqué persisté) |
| Mode cloud (Supabase, auth, RLS) | 🟡 Préparé | `supabase/schema.sql` + interface du repository ; **non activé** (aucun identifiant) |
| Extension IA | 🟡 Préparée | Interface `AssistantProvider` ; aucun appel externe |
| Langue anglaise | ⏳ À développer | Interface en français ; formats numériques déjà multi-locales |

## Résultats des tests (exécutés)

`npm test` — **121 tests, 7 fichiers, tous au vert** :

| Fichier | Tests | Couverture |
|---|---|---|
| `domain/money.test.ts` | 26 | parsing exact, séparateurs, devises à 0/3 décimales, 0,1 + 0,2, formats, arrondis, montants nuls/négatifs |
| `domain/dates.test.ts` | 7 | bissextiles, dates limites, fins de mois, formats, périodes, fuseau Casablanca |
| `domain/calc/ledger.test.ts` | 18 | revenus, dépenses, épargne, taux (non calculable), sous-catégories, fixes/variables, filtrage par période, transferts sans double comptage, remboursements, ajustements, intérêts seuls, soldes et ancrage, série quotidienne, multidevise avec/sans taux |
| `domain/calc/modules.test.ts` | 28 | budgets (restant, écarts, dépassement, budget nul, projection, disponible), objectifs (atteint, dépassé, en retard, compte suivi), échéances (fins de mois, bissextiles, fréquences, rapprochement), dettes, patrimoine (double comptage, historique), prévisions, simulateur |
| `domain/csv.test.ts` | 9 | CSV (guillemets, BOM, CRLF, injection de formules), dates, montants, doublons |
| `domain/assistant.test.ts` | 9 | intentions de l’assistant, cohérence des chiffres, données insuffisantes, insights comparables, notifications |
| `data/repository.test.ts` | 24 | CRUD, validation, transferts (création, modification, conversion, suppression, multidevise), **persistance après réouverture**, sauvegarde/restauration, **isolation entre utilisateurs**, archivage, budgets, récurrences, dettes, objectifs, import, export, cohérence du jeu de démo et des totaux du dashboard |

`npm run test:e2e` — parcours réel dans Chromium (exécuté, 11/11) : onboarding,
saisie d’une dépense et mise à jour du solde et des KPI, persistance après
rechargement, import CSV (erreur et doublon détectés), transfert sans effet sur le
solde total ni sur les dépenses, mode confidentialité.

Vérifications manuelles effectuées : captures de tous les écrans en desktop (1440 px)
et mobile (390 px, aucun débordement horizontal), thèmes sombre et clair, impression du
rapport, absence d’erreur console.

## Hypothèses retenues

* Un « remboursement » dans la saisie = **remboursement reçu** d’une dépense (réduit la
  dépense de sa catégorie). Le remboursement d’une dette se fait depuis *Dettes & créances*.
* Le solde initial d’un compte est daté ; les opérations antérieures n’affectent pas le
  solde actuel (elles alimentent l’historique et les analyses).
* Les opérations « en attente » comptent dans les soldes et les indicateurs (statut informatif).
* Le budget disponible du dashboard se fonde sur le budget global, sinon sur la somme des
  budgets de catégories.
* Les intérêts de dettes sont classés en « Échéances de crédit » (dépense) ou
  « Dividendes et intérêts » (revenu).
* Une opération est dans la devise de son compte ; les taux de change sont saisis manuellement.

## Sécurité et confidentialité

Mode local : données en clair dans IndexedDB de ce navigateur (pas de chiffrement au
repos) ; le mode confidentialité masque l’affichage mais ne chiffre pas. Exportez des
sauvegardes. NEXORA ne demande jamais d’identifiants bancaires et ne simule aucune
connexion bancaire. Voir `docs/ARCHITECTURE.md` §7–8 pour la cible cloud et les limites.
