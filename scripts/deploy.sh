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
用法：scripts/deploy.sh [选项]

在服务器的仓库目录中执行：拉取代码 → 检查 .env → 备份数据库 → 构建镜像 → 重启容器 → 等待健康检查。

选项：
  --no-pull        跳过拉取，直接部署当前代码（默认先对当前分支执行 git pull --ff-only）
  --skip-backup    跳过数据库备份（默认备份到 backups/）
  --prune          部署成功后清理悬空镜像
  --timeout <秒>   等待健康检查的最长时间（默认 120）
  -h, --help       显示帮助

环境变量：
  HEALTH_URL       健康检查地址（默认 http://127.0.0.1:3080/health）
  BACKUP_DIR       备份目录（默认 <仓库>/backups）
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
    *) echo "未知选项：$1" >&2; usage >&2; exit 2 ;;
  esac
done

log() { printf '\n==> %s\n' "$*"; }
fail() { echo "部署失败：$*" >&2; exit 1; }

[[ "$TIMEOUT" =~ ^[0-9]+$ ]] || fail "--timeout 需要整数秒"
docker compose version >/dev/null 2>&1 || fail "未找到 docker compose，请先安装 Docker 与 Compose 插件"
command -v curl >/dev/null 2>&1 || fail "未找到 curl"

if ((PULL)); then
  log "拉取最新代码"
  [[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "工作区有未提交的修改，请先处理，或使用 --no-pull 部署当前代码"
  BEFORE=$(git rev-parse HEAD)
  git pull --ff-only
  if [[ "$(git rev-parse HEAD)" != "$BEFORE" ]]; then
    # 代码有更新时用新版本的脚本重新执行，避免沿用旧的部署步骤。
    exec "$ROOT/scripts/deploy.sh" ${ARGS[@]+"${ARGS[@]}"} --no-pull
  fi
fi

log "检查 .env"
[[ -f .env ]] || fail "缺少 .env，请先运行 bun run setup 或参照 .env.example 创建"
env_value() { sed -n "s/^$1=//p" .env | tail -n 1 | sed 's/^["'\'']//; s/["'\'']$//'; }
ADMIN_KEY_VALUE=$(env_value ADMIN_KEY)
MASTER_KEY_VALUE=$(env_value MASTER_KEY)
BASE_URL_VALUE=$(env_value BASE_URL)
[[ -n "$ADMIN_KEY_VALUE" && "$ADMIN_KEY_VALUE" != replace-with-* ]] || fail ".env 中的 ADMIN_KEY 未设置"
[[ "$MASTER_KEY_VALUE" =~ ^[0-9a-fA-F]{64}$ ]] || fail ".env 中的 MASTER_KEY 必须是 64 位十六进制"
[[ -n "$BASE_URL_VALUE" ]] || fail ".env 中的 BASE_URL 未设置"
[[ "$BASE_URL_VALUE" == https://* ]] || echo "提示：BASE_URL 不是 HTTPS（$BASE_URL_VALUE），线上请设置为实际访问的 HTTPS 域名"

echo "部署版本：$(git rev-parse --short HEAD) ($(git rev-parse --abbrev-ref HEAD))"

if ((BACKUP)); then
  if [[ -n "$(docker compose ps -q --status running atelier 2>/dev/null)" ]]; then
    log "备份数据库"
    mkdir -p "$BACKUP_DIR"
    STAMP=$(date +%Y%m%d-%H%M%S)
    SNAPSHOT="/app/data/deploy-backup-$STAMP.sqlite"
    # VACUUM INTO 生成一致的快照，WAL 中尚未落盘的写入也会包含在内。
    docker compose exec -T atelier bun -e "const { Database } = await import('bun:sqlite'); new Database('/app/data/atelier.sqlite').run(\"VACUUM INTO '$SNAPSHOT'\")"
    docker compose cp "atelier:$SNAPSHOT" "$BACKUP_DIR/atelier-$STAMP.sqlite"
    docker compose exec -T atelier rm -f "$SNAPSHOT"
    chmod 600 "$BACKUP_DIR/atelier-$STAMP.sqlite"
    echo "已备份到 $BACKUP_DIR/atelier-$STAMP.sqlite"
  else
    echo "容器未运行，跳过备份"
  fi
fi

log "构建镜像"
docker compose build

log "重启服务"
docker compose up -d --remove-orphans

log "等待健康检查：$HEALTH_URL"
deadline=$((SECONDS + TIMEOUT))
until curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; do
  if ((SECONDS >= deadline)); then
    docker compose ps
    docker compose logs --tail 100 atelier
    fail "${TIMEOUT} 秒内健康检查未通过，请查看上方日志"
  fi
  sleep 2
done
curl -fsS --max-time 5 "$HEALTH_URL"; echo

if ((PRUNE)); then
  log "清理悬空镜像"
  docker image prune -f
fi

log "部署完成"
docker compose ps
