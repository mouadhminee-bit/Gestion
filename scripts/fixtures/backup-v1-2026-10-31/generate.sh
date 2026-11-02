#!/usr/bin/env bash
# Régénère la fixture « sauvegarde V1 du 31/10/2026 » (données FICTIVES) avec le code
# historique exact (commit 341f3da), dans un dossier temporaire. Ne lit ni n'écrit
# aucune base réelle : fake-indexeddb, base « gen-v1 » en mémoire.
#
# Usage (depuis la racine du dépôt, dépendances installées) :
#   bash scripts/fixtures/backup-v1-2026-10-31/generate.sh
# Sortie : src/data/backup/__fixtures__/backup-v1-2026-10-31{.json,.local-attachments.json}
#
# Les identifiants (UUID) et horodatages diffèrent à chaque génération : la fixture
# versionnée fait référence ; le test de non-régression vérifie son empreinte.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
REV=341f3da
HERE="$ROOT/scripts/fixtures/backup-v1-2026-10-31"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$ROOT" archive "$REV" | tar -x -C "$WORK"
ln -s "$ROOT/node_modules" "$WORK/node_modules"
mkdir -p "$WORK/src/zz"
cp "$HERE/generate.test.ts" "$WORK/src/zz/generate.test.ts"
mkdir -p "$ROOT/src/data/backup/__fixtures__"
(cd "$WORK" && FIXTURE_OUT_DIR="$ROOT/src/data/backup/__fixtures__" npx vitest run src/zz/generate.test.ts)
echo "Fixture régénérée dans src/data/backup/__fixtures__/ (commit historique $REV)."
