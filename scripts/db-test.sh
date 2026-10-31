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
# Variables : PG_BIN (binaires serveur, défaut /usr/lib/postgresql/16/bin),
#             RESULTS_JSON=<fichier> (export des résultats), DUMP_SCHEMA=<fichier>,
#             ADMIN_ROLE=service_role (simule un propriétaire qui ne contourne pas la RLS).
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
ADMIN_ROLE="${ADMIN_ROLE:-postgres}"
DSN_PASSWORD=""
if [ "$ADMIN_ROLE" = "postgres" ]; then
  as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --no-locale >/dev/null
else
  # Simulation d'un administrateur non superutilisateur (cas Supabase) : dblink exige alors une
  # connexion authentifiée par mot de passe. Mot de passe jetable, propre à ce cluster éphémère.
  echo "postgres" > "$WORK/pw" && chmod 600 "$WORK/pw" && { [ "$(id -u)" != "0" ] || chown postgres "$WORK/pw"; }
  as_pg "$PG_BIN/initdb" -D "$DATA" -U postgres -A scram-sha-256 --pwfile="$WORK/pw" -E UTF8 --no-locale >/dev/null
  export PGPASSWORD=postgres
  DSN_PASSWORD=" password=postgres"
fi
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
"${PSQL[@]}" -d "$DB" -v dsn="host=$WORK port=$PORT dbname=$DB user=postgres${DSN_PASSWORD}" -v admin_role="$ADMIN_ROLE" -f "$ROOT/supabase/db-tests/_setup.sql" >/dev/null

echo "== Tests"
for f in "$ROOT"/supabase/db-tests/[0-9]*.sql; do
  name="$(basename "$f")"
  PGOPTIONS="-c tests.file=$name -c role=$ADMIN_ROLE" "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
done

if [ -n "${DUMP_SCHEMA:-}" ]; then
  as_pg "$PG_BIN/pg_dump" -h "$WORK" -p "$PORT" -U postgres --schema-only --no-owner --no-privileges \
    -n public -n private "$DB" > "$DUMP_SCHEMA"
  echo "Schéma exporté : $DUMP_SCHEMA"
fi

if [ -n "${RESULTS_JSON:-}" ]; then
  "${PSQL[@]}" -d "$DB" -tA -c "
    select json_build_object(
      'server_version', current_setting('server_version'),
      'results', json_agg(json_build_object('file', file, 'name', name, 'ok', ok, 'detail', detail) order by n))
    from tests.results" > "$RESULTS_JSON"
  echo "Résultats exportés : $RESULTS_JSON"
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
