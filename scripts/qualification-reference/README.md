# Références de complétude des preuves de qualification

`scripts/check-qualification-evidence.mjs` vérifie qu'un jeu de preuves
(`docs/qualification/<préfixe>-*.json` et `-report.md`) est **complet**, pas seulement
cohérent : il compare les assertions aux références de ce dossier.

| Fichier | Jeu de preuves | Contenu |
|---|---|---|
| `3b-local.json` | étape 3b, migrations 1 à 7 | 1 152 assertions SQL, 143 HTTP |
| `lot4-local.json` | Lot 0 (étapes 4.5 / 4.6), migrations 1 à 8 | 1 847 assertions SQL, 302 HTTP |
| `v41-local.json` | V4.1 (M9), migrations 1 à 9, traçabilité exigée | 1 905 assertions SQL, 320 HTTP |

Chaque référence contient :

* les **signatures exactes** de chaque assertion (`fichier :: nom`), avec leur multiplicité ;
* le nombre d'assertions par suite ;
* les **catégories critiques** et leur nombre attendu (isolation, protocole de la migration 8,
  clé canonique, écritures directes, précision, rôle anonyme, plateforme) ;
* la version majeure de PostgreSQL et la liste exacte des migrations appliquées.

## Ce qui est refusé

Assertion supprimée, ajoutée ou renommée ; suite absente ou inattendue ; catégorie critique
incomplète ; nombre total différent ; version de PostgreSQL ou liste des migrations différente.
Les compteurs du rapport ne servent pas de référence : ils sont comparés à la référence,
pas l'inverse.

## Protection de la référence

* La référence est lue dans le **dépôt**, à côté du contrôleur, jamais dans le dossier des
  preuves analysées.
* Son empreinte SHA-256 est **épinglée** dans la constante `REFERENCE_SHA256` du contrôleur.
  Une référence modifiée sans mise à jour de cette constante est refusée. Modifier ensemble
  preuves, rapport et référence ne suffit donc pas : il faut aussi modifier le contrôleur,
  ce qui apparaît dans la revue du commit.
* Le contrôleur n'écrit jamais aucun fichier ; il ne met jamais une référence à jour seul.

Limite assumée : une personne qui modifie à la fois les preuves, la référence **et** la
constante du contrôleur obtient une preuve acceptée. Seules la revue des commits et la
reproduction indépendante de la qualification protègent de ce cas.

## Provenance des références actuelles

Produites le 14/11/2026 par `--print-reference` à partir des preuves complètes versionnées
(`3b-local-*`) et des preuves du Lot 0 (`lot4-local-*`, session cloud). Pour `lot4-local`, les
signatures sont identiques à celles de la qualification exécutée dans le Codespace, d'après la
comparaison indépendante du responsable du projet (même nombre d'assertions, aucun test
manquant ni supplémentaire, aucun statut divergent).

*Précision du 18/11/2026 :* les preuves `docs/qualification/lot4-local-*` du dépôt sont celles
du **Codespace** (rapport du 2026-11-14T14:58:35Z), et non celles de la session cloud qui ont
servi à produire `lot4-local.json`. Le contrôleur les déclare complètes par rapport à cette
référence (15 et 18/11/2026) : les signatures sont identiques. La référence elle-même et son
empreinte épinglée ne changent pas.

## Mise à jour volontaire (après un changement assumé des suites de tests)

1. Requalifier et contrôler les nouvelles preuves (toutes les assertions doivent réussir).
2. Produire la référence candidate, **sans rien écrire** :
   ```bash
   node scripts/check-qualification-evidence.mjs --print-reference docs/qualification lot4-local > /tmp/reference-candidate.json
   ```
3. Comparer avec la référence actuelle et **justifier chaque différence** (assertion
   ajoutée, retirée ou renommée) :
   ```bash
   diff scripts/qualification-reference/lot4-local.json /tmp/reference-candidate.json
   ```
4. Remplacer le fichier, puis reporter son empreinte dans `REFERENCE_SHA256` :
   ```bash
   sha256sum scripts/qualification-reference/lot4-local.json
   ```
5. Relancer les tests du contrôleur et le contrôleur :
   ```bash
   node --test scripts/check-qualification-evidence.test.mjs
   node scripts/check-qualification-evidence.mjs docs/qualification lot4-local
   ```
6. Commiter **dans un même commit** la référence, la constante et la justification.

Un nouveau jeu de preuves (par exemple hébergé) reçoit sa propre référence et son propre
préfixe, avec `"traceability": "required"` : le rapport doit alors indiquer l'environnement,
le commit et l'empreinte des migrations.

## Provenance de `v41-local.json` (V4.1, 22/11/2026)

Produite par `--print-reference` à partir des preuves `docs/qualification/v41-local-*`
(qualification sur la pile Supabase locale du Codespace, PostgreSQL 17.11, migrations 1 à 9,
toutes les assertions réussies). Différences avec `lot4-local.json`, toutes volontaires :

* migration 9 (`pull_changes`) ajoutée à la liste des migrations ; `"traceability": "required"` ;
* suite `12_pull_changes.sql` ajoutée (51 assertions) ;
* `07_sync.sql` : les 16 assertions portent sur la vraie fonction (préfixe « M9 ») au lieu du
  prototype `tests.pull` ;
* `01_catalog.sql` et `P1_supabase_platform.sql` : inventaire exact étendu à la troisième fonction
  publique (`pull_changes`) ; P1 : 2 assertions de plus (droits et propriétaire de la fonction) ;
* HTTP : 18 assertions « M9 » ajoutées (récupération sous l'identité de chaque utilisateur).

La référence PostgreSQL 16 (`supabase/db-tests/baseline/pg16.json`) n'a pas été régénérée
(binaires PostgreSQL 16 absents du Codespace) : les 17 assertions remplacées y sont déclarées
dans `supabase/db-tests/baseline/pg16-declared-deltas.json` et contrôlées exactement par
`compare-results.mjs --declared` ; elles ne sont pas requalifiées sur PostgreSQL 16, pas plus que
les assertions nouvelles.
