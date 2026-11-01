#!/usr/bin/env bash
# =============================================================================
# NEXORA — étape 3b : qualification du schéma sur la VRAIE pile Supabase LOCALE.
#
# À lancer dans GitHub Codespaces (Docker requis) :   bash scripts/qualify-supabase.sh local
#
#  1. vérifie l'environnement et REFUSE toute cible autre que la pile locale « nexora » ;
#  2. démarre la pile Supabase locale (PostgreSQL, GoTrue/Auth, PostgREST, Kong, …) :
#     les 6 migrations sont appliquées par le CLI Supabase ;
#  3. exécute les suites SQL (01…08 + contrôles plateforme) sur la base Supabase ;
#  4. exécute la suite HTTP : deux utilisateurs réellement authentifiés via GoTrue ;
#  5. compare avec la référence PostgreSQL 16 et écrit le rapport dans docs/qualification/ ;
#  6. arrête la pile et SUPPRIME ses données (supabase stop --no-backup), même en cas d'échec.
#
# Mode « hosted » : DÉSACTIVÉ (étape 3b-4 reportée). Aucune connexion distante.
# Données : uniquement des comptes et des lignes fictifs (@example.test).
# Variables : KEEP_STACK=1 pour ne pas arrêter la pile (diagnostic).
# =============================================================================
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  local) ;;
  hosted)
    echo "REFUS : le mode « hosted » est désactivé (étape 3b-4 reportée). Aucune connexion distante n'est autorisée." >&2
    exit 3 ;;
  *)
    echo "Usage : bash scripts/qualify-supabase.sh local" >&2
    exit 2 ;;
esac

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
SUPABASE_CLI_VERSION="2.122.0"
SB=(npx --yes "supabase@${SUPABASE_CLI_VERSION}")
PROJECT_ID="nexora"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
EXPECTED_API="http://127.0.0.1:54321"
EXPECTED_DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
# Identifiants LOCAUX par défaut de la pile Supabase de développement (non secrets).
LOCAL_DSN_TAIL="port=5432 dbname=postgres user=postgres password=postgres"
OUT="$ROOT/docs/qualification"
RUN="$(mktemp -d /tmp/nexora-qualif.XXXXXX)"
STARTED=0

# Aucune information de projet hébergé ne doit être utilisée par ce script.
unset SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_ID SUPABASE_PROJECT_REF SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY || true

refuse() { echo "REFUS : $*" >&2; exit 3; }
step() { echo; echo "== $*"; }

cleanup() {
  status=$?
  trap - EXIT INT TERM   # une seule exécution (signal puis sortie)
  if [ "$STARTED" = "1" ] && [ "${KEEP_STACK:-}" != "1" ]; then
    step "Destruction de la pile locale (supabase stop --no-backup)"
    "${SB[@]}" stop --no-backup --project-id "$PROJECT_ID" >/dev/null 2>&1 || "${SB[@]}" stop --no-backup >/dev/null 2>&1 || true
    left_c=$(docker ps -a --filter "label=com.supabase.cli.project=${PROJECT_ID}" -q | wc -l)
    left_v=$(docker volume ls --filter "label=com.supabase.cli.project=${PROJECT_ID}" -q | wc -l)
    if [ "$left_c" = "0" ] && [ "$left_v" = "0" ]; then
      echo "Pile détruite : 0 conteneur, 0 volume restants."
    else
      echo "ATTENTION : ${left_c} conteneur(s) et ${left_v} volume(s) restants — voir docs/LOT3B_QUALIFICATION.md § 6." >&2
    fi
  fi
  rm -rf "$RUN"
  exit $status
}
trap cleanup EXIT INT TERM

# -----------------------------------------------------------------------------
step "1. Contrôles préalables"
command -v docker >/dev/null || refuse "Docker introuvable (Codespace sans Docker-in-Docker ? voir .devcontainer/devcontainer.json)."
docker info >/dev/null 2>&1 || refuse "le démon Docker ne répond pas."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || refuse "Node 22 ou plus est requis."
grep -Eq '^project_id = "nexora"$' supabase/config.toml || refuse "supabase/config.toml : project_id doit être « nexora »."
[ ! -e supabase/.temp/project-ref ] || refuse "ce dépôt est lié à un projet Supabase hébergé (supabase/.temp/project-ref) : supprimez ce lien avant la qualification locale."
ls supabase/migrations/*.sql >/dev/null || refuse "aucune migration trouvée."
echo "Docker OK, Node $(node -v), CLI Supabase ${SUPABASE_CLI_VERSION}, projet local « ${PROJECT_ID} »."

# -----------------------------------------------------------------------------
step "2. Démarrage de la pile Supabase locale (applique les migrations)"
STARTED=1
EXCLUDE="studio,imgproxy,realtime,edge-runtime,logflare,vector"
if ! "${SB[@]}" start -x "$EXCLUDE" 2>&1 | tee "$RUN/start.log"; then
  echo "Démarrage avec exclusions refusé ; nouvel essai avec tous les services." | tee -a "$RUN/start.log"
  "${SB[@]}" start 2>&1 | tee -a "$RUN/start.log"
fi

"${SB[@]}" status -o env > "$RUN/status.env" 2>/dev/null
val() { grep -E "^$1=" "$RUN/status.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
API_URL="$(val API_URL)"
DB_URL="$(val DB_URL)"
ANON_KEY="$(val ANON_KEY)"
[ -n "$ANON_KEY" ] || ANON_KEY="$(val PUBLISHABLE_KEY)"

# Garde-fous : uniquement la pile locale explicitement identifiée.
[ "$API_URL" = "$EXPECTED_API" ] || refuse "URL d'API inattendue « ${API_URL} » (attendu ${EXPECTED_API})."
[ "$DB_URL" = "$EXPECTED_DB" ] || refuse "URL de base inattendue (attendu ${EXPECTED_DB})."
[ -n "$ANON_KEY" ] || refuse "clé anon locale introuvable dans « supabase status »."
[ "$(docker inspect -f '{{ index .Config.Labels "com.supabase.cli.project" }}' "$DB_CONTAINER" 2>/dev/null)" = "$PROJECT_ID" ] \
  || refuse "conteneur ${DB_CONTAINER} absent ou non étiqueté pour le projet ${PROJECT_ID}."
echo "Cible vérifiée : ${API_URL} / conteneur ${DB_CONTAINER}."

# Connexions des sessions concurrentes (dblink, depuis la base elle-même) : boucle locale,
# puis adresse du conteneur — dblink_connect exige, pour un non-superutilisateur, une
# connexion réellement authentifiée par mot de passe (la boucle locale peut être en « trust »).
DB_IP="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$DB_CONTAINER" | awk '{print $1}')"
INNER_DSN="host=127.0.0.1 ${LOCAL_DSN_TAIL}"
[ -n "$DB_IP" ] && INNER_DSN="${INNER_DSN}|host=${DB_IP} ${LOCAL_DSN_TAIL}"

psqlx() {
  docker exec -i -e PGPASSWORD=postgres -e PGOPTIONS="${PGOPTS:-}" "$DB_CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d postgres "$@"
}
SERVER_VERSION="$(psqlx -tA -c 'select version()')"
psqlx -tA -c "select count(*) from auth.users where coalesce(email, '') not like '%@example.test'" > "$RUN/real_users"
[ "$(cat "$RUN/real_users")" = "0" ] || refuse "la base contient des utilisateurs non fictifs : ce n'est pas une base de qualification."
APPLIED="$(psqlx -tA -c "select string_agg(version, ' ' order by version) from supabase_migrations.schema_migrations")"
EXPECTED_MIG="$(ls supabase/migrations/*.sql | xargs -n1 basename | cut -d_ -f1 | tr '\n' ' ' | sed 's/ $//')"
[ "$APPLIED" = "$EXPECTED_MIG" ] || refuse "migrations appliquées « ${APPLIED} » ≠ attendues « ${EXPECTED_MIG} »."
echo "Serveur : ${SERVER_VERSION}"
echo "Migrations appliquées : ${APPLIED}"

# -----------------------------------------------------------------------------
step "3. Suites SQL sur la base Supabase"
# Q1 : si postgres ne contourne pas la RLS forcée, l'outillage administre via service_role.
ADMIN_ROLE="$(psqlx -tA -c "select case when rolsuper or rolbypassrls then 'postgres' else 'service_role' end from pg_roles where rolname = 'postgres'")"
echo "Rôle administrateur des tests : ${ADMIN_ROLE}"
psqlx -v dsn="$INNER_DSN" -v admin_role="$ADMIN_ROLE" < supabase/db-tests/_setup.sql
SQL_ERRORS=""
for f in supabase/db-tests/[0-9]*.sql supabase/db-tests/platform/*.sql; do
  name="$(basename "$f")"
  echo "   ${name}"
  if ! PGOPTS="-c tests.file=${name} -c role=${ADMIN_ROLE}" psqlx < "$f" > "$RUN/${name}.log" 2>&1; then
    SQL_ERRORS="${SQL_ERRORS}${name} "
    echo "   ÉCHEC D'EXÉCUTION : ${name} (journal ci-dessous)"; tail -5 "$RUN/${name}.log"
  fi
done
psqlx -tA -c "
  select json_build_object('server_version', current_setting('server_version'),
    'results', json_agg(json_build_object('file', file, 'name', name, 'ok', ok, 'detail', detail) order by n))
  from tests.results" > "$RUN/sql.json"

# -----------------------------------------------------------------------------
step "4. Suite HTTP : deux utilisateurs réellement authentifiés (GoTrue + PostgREST)"
HTTP_STATUS=0
SUPABASE_API_URL="$API_URL" SUPABASE_ANON_KEY="$ANON_KEY" RESULTS_JSON="$RUN/http.json" \
  node supabase/db-tests/http/rls.mjs | tee "$RUN/http.log" || HTTP_STATUS=$?

# -----------------------------------------------------------------------------
step "5. Comparaison avec la référence PostgreSQL 16 et rapport"
CMP_STATUS=0
node supabase/db-tests/compare-results.mjs supabase/db-tests/baseline/pg16.json "$RUN/sql.json" --md "$RUN/compare.md" | tee "$RUN/compare.log" || CMP_STATUS=$?

mkdir -p "$OUT"
mask() { sed -E 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[jeton masqué]/g; s/sb_(publishable|secret)_[A-Za-z0-9_-]+/[clé masquée]/g'; }
mask < "$RUN/sql.json" > "$OUT/3b-local-sql.json"
mask < "$RUN/http.json" > "$OUT/3b-local-http.json"
IMAGES="$(docker ps --filter "label=com.supabase.cli.project=${PROJECT_ID}" --format '| `{{.Names}}` | `{{.Image}}` |' | sort)"
{
  echo "# NEXORA — étape 3b : résultats bruts de la qualification sur la pile Supabase locale"
  echo
  echo "*Généré par \`scripts/qualify-supabase.sh local\` le $(date -u +%Y-%m-%dT%H:%M:%SZ) (UTC). Données fictives uniquement ; jetons et clés masqués.*"
  echo
  echo "| Élément | Valeur |"
  echo "|---|---|"
  echo "| Serveur | \`${SERVER_VERSION}\` |"
  echo "| CLI Supabase | \`${SUPABASE_CLI_VERSION}\` |"
  echo "| Migrations appliquées | \`${APPLIED}\` |"
  echo "| Rôle administrateur des tests (Q1) | \`${ADMIN_ROLE}\` |"
  echo "| Fichiers SQL interrompus | ${SQL_ERRORS:-aucun} |"
  echo "| Code de sortie HTTP / comparaison | ${HTTP_STATUS} / ${CMP_STATUS} |"
  echo
  echo "## Composants de la pile"
  echo
  echo "| Conteneur | Image |"
  echo "|---|---|"
  echo "$IMAGES"
  echo
  echo "## Suites SQL : comparaison avec PostgreSQL 16 local"
  echo
  cat "$RUN/compare.md"
  echo
  echo "## Constats plateforme (Q1–Q5)"
  echo
  echo "| Constat | Valeur |"
  echo "|---|---|"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const r of j.results ?? []) if (r.name.startsWith("CONSTAT") || r.name.startsWith("Q")) console.log(`| ${r.ok ? "" : "❌ "}${r.name.replaceAll("|", "/")} | ${String(r.detail ?? "").replaceAll("|", "/")} |`);
  ' "$OUT/3b-local-sql.json"
  echo
  echo "## Suite HTTP (deux utilisateurs authentifiés)"
  echo
  echo '```'
  mask < "$RUN/http.log"
  echo '```'
} > "$OUT/3b-local-report.md"
echo "Rapport : docs/qualification/3b-local-report.md (+ 3b-local-sql.json, 3b-local-http.json)"

if [ -n "$SQL_ERRORS" ] || [ "$HTTP_STATUS" != "0" ] || [ "$CMP_STATUS" != "0" ]; then
  echo "QUALIFICATION : ÉCARTS DÉTECTÉS (voir le rapport)."
  exit 1
fi
echo "QUALIFICATION : AUCUN ÉCART."
