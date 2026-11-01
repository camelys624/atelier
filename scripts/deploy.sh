#!/usr/bin/env bash
# Deploy atelier on the server from this checkout with Docker Compose.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

PULL=1
BACKUP=1
PRUNE=0
TIMEOUT=120
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3080/health}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [options]

Run from the repository on the server: pull -> check .env -> back up database
-> build image -> restart container -> wait for health check.

Options:
  --no-pull        Deploy the current checkout without pulling
                   (default: git pull --ff-only on the current branch)
  --skip-backup    Skip the database backup (default: back up to backups/)
  --prune          Remove dangling images after a successful deploy
  --timeout <sec>  Max seconds to wait for the health check (default: 120)
  -h, --help       Show this help

Environment:
  HEALTH_URL       Health check URL (default: http://127.0.0.1:3080/health)
  BACKUP_DIR       Backup directory (default: <repo>/backups)
EOF
}

ARGS=("$@")
while (($# > 0)); do
  case "$1" in
    --no-pull) PULL=0; shift ;;
    --skip-backup) BACKUP=0; shift ;;
    --prune) PRUNE=1; shift ;;
    --timeout) TIMEOUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "Deploy failed: $*" >&2; exit 1; }

[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || fail "--timeout needs a whole number of seconds"
docker compose version >/dev/null 2>&1 || fail "docker compose not found; install Docker and the Compose plugin"
command -v curl >/dev/null 2>&1 || fail "curl not found"

if ((PULL)); then
  log "Pulling latest code"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "working tree has uncommitted changes; resolve them or use --no-pull to deploy the current checkout"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only
  if [[ "$(git rev-parse HEAD)" != "$BEFORE" ]]; then
    # Re-run the updated script so new deploy steps take effect.
    exec "$ROOT/scripts/deploy.sh" ${ARGS[@]+"${ARGS[@]}"} --no-pull
  fi
fi

log "Checking .env"
[[ -f .env ]] || fail ".env is missing; run bun run setup or copy .env.example"
env_value() { sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^["'\'']//; s/["'\'']$//'; }
ADMIN_KEY_VALUE=$(env_value ADMIN_KEY)
MASTER_KEY_VALUE=$(env_value MASTER_KEY)
BASE_URL_VALUE=$(env_value BASE_URL)
[[ -n "$ADMIN_KEY_VALUE" && "$ADMIN_KEY_VALUE" != replace-with-* ]] || fail "ADMIN_KEY is not set in .env"
[[ "$MASTER_KEY_VALUE" =~ ^[0-9a-fA-F]{64}$ ]] || fail "MASTER_KEY in .env must be 64 hex characters"
[[ -n "$BASE_URL_VALUE" ]] || fail "BASE_URL is not set in .env"
[[ "$BASE_URL_VALUE" == https://* ]] || echo "Warning: BASE_URL is not HTTPS ($BASE_URL_VALUE); set it to the public HTTPS domain in production"

echo "Deploying $(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"

if ((BACKUP)); then
  if [[ -n "$(docker compose ps -q --status running atelier 2>/dev/null)" ]]; then
    log "Backing up database"
    mkdir -p "$BACKUP_DIR"
    STAMP=$(date +%Y%m%d-%H%M%S)
    SNAPSHOT="/app/data/deploy-backup-$STAMP.sqlite"
    # VACUUM INTO writes a consistent snapshot, including writes still in the WAL.
    docker compose exec -T atelier bun -e "const { Database } = await import('bun:sqlite'); new Database('/app/data/atelier.sqlite').run(\"VACUUM INTO '$SNAPSHOT'\")"
    docker compose cp "atelier:$SNAPSHOT" "$BACKUP_DIR/atelier-$STAMP.sqlite"
    docker compose exec -T atelier rm -f "$SNAPSHOT"
    chmod 600 "$BACKUP_DIR/atelier-$STAMP.sqlite"
    echo "Backed up to $BACKUP_DIR/atelier-$STAMP.sqlite"
  else
    echo "Container not running; skipping backup"
  fi
fi

log "Building image"
docker compose build

log "Restarting service"
docker compose up -d --remove-orphans

log "Waiting for health check: $HEALTH_URL"
deadline=$((SECONDS + TIMEOUT))
until curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    docker compose ps
    docker compose logs --tail 100 atelier
    fail "health check did not pass within ${TIMEOUT}s; see logs above"
  fi
  sleep 2
done
curl -fsS --max-time 5 "$HEALTH_URL"; echo

if ((PRUNE)); then
  log "Removing dangling images"
  docker image prune -f
fi

log "Deploy complete"
docker compose ps
