#!/usr/bin/env bash
# =============================================================================
# NEXORA — tests du schéma PostgreSQL sur une base ÉPHÉMÈRE et ISOLÉE.
#
# 1. crée un cluster PostgreSQL temporaire dans /tmp (socket Unix uniquement, aucun
#    port TCP ouvert) ;
# 2. applique l'émulation Supabase de test, puis les migrations dans l'ordre ;
# 3. exécute les tests SQL et affiche le bilan ;
# 4. arrête et SUPPRIME le cluster dans tous les cas (trap).
#
# Ne se connecte à aucune base existante ni à Supabase.
# Variables : PG_BIN (défaut /usr/lib/postgresql/16/bin), KEEP_LOG=1 pour garder le journal.
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d /tmp/nexora-pgtest.XXXXXX)"
DATA="$WORK/data"
PORT=5432          # port logique de la socket (aucune écoute TCP)
DB=nexora_test

as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

cleanup() {
  status=$?
  if [ -f "$DATA/postmaster.pid" ]; then
    as_pg "$PG_BIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
  if [ -e "$WORK" ]; then echo "ATTENTION : $WORK n'a pas pu être supprimé" >&2; else echo "Cluster temporaire détruit : $WORK"; fi
  exit $status
}
trap cleanup EXIT INT TERM

[ "$(id -u)" = "0" ] && chown postgres "$WORK"
as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >/dev/null
as_pg "$PG_BIN/pg_ctl" -D "$DATA" -l "$WORK/postgres.log" -w \
  -o "-c listen_addresses='' -k $WORK -p $PORT -c fsync=off -c max_connections=30" start >/dev/null
echo "Cluster temporaire démarré : $DATA ($("$PG_BIN/postgres" --version))"

PSQL=(psql -X -q -v ON_ERROR_STOP=1 -h "$WORK" -p "$PORT" -U postgres)
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null

run() { "${PSQL[@]}" -d "$DB" -f "$1" >/dev/null; }

echo "== Émulation Supabase (tests uniquement)"
run "$ROOT/supabase/db-tests/shim/auth_shim.sql"

echo "== Migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  run "$f"
done

echo "== Outillage de test"
"${PSQL[@]}" -d "$DB" -v dsn="host=$WORK port=$PORT dbname=$DB user=postgres" -f "$ROOT/supabase/db-tests/_setup.sql" >/dev/null

echo "== Tests"
for f in "$ROOT"/supabase/db-tests/[0-9]*.sql; do
  name="$(basename "$f")"
  PGOPTIONS="-c tests.file=$name" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
done

if [ -n "${DUMP_SCHEMA:-}" ]; then
  as_pg "$PG_BIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --schema-only --no-owner --no-privileges \
    -n public -n private "$DB" > "$DUMP_SCHEMA"
  echo "Schéma exporté : $DUMP_SCHEMA"
fi

"${PSQL[@]}" -d "$DB" -P pager=off -c "
  select file, count(*) filter (where ok) as reussis, count(*) filter (where not ok) as echecs
  from tests.results group by file order by file;"
"${PSQL[@]}" -d "$DB" -P pager=off -c "
  select file, name, detail from tests.results where not ok order by n;"
FAILED=$("${PSQL[@]}" -d "$DB" -tA -c "select count(*) from tests.results where not ok")
TOTAL=$("${PSQL[@]}" -d "$DB" -tA -c "select count(*) from tests.results")
echo "Bilan : $TOTAL assertions, $FAILED échec(s)"
[ "$TOTAL" -gt 0 ] && [ "$FAILED" -eq 0 ]
