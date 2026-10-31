#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
PID="$ROOT/data/service.pid"
case "${1:-status}" in
  start)
    if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo '服务已经运行'; exit 0; fi
    BUN_BIN=${BUN_BIN:-bun}
    "$BUN_BIN" -e '
      const {spawn}=await import("node:child_process");
      const {openSync,writeFileSync,mkdirSync}=await import("node:fs");
      mkdirSync("data",{recursive:true});
      const log=openSync("data/service.log","a",0o600);
      const child=spawn(process.execPath,["server/index.ts"],{detached:true,stdio:["ignore",log,log],env:process.env});
      writeFileSync("data/service.pid",String(child.pid)); child.unref();
    '
    sleep 2
    if kill -0 "$(cat "$PID")" 2>/dev/null; then echo '服务已启动：http://127.0.0.1:3080'; else echo '启动失败，请查看 data/service.log'; exit 1; fi
    ;;
  stop)
    if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then kill "$(cat "$PID")"; echo '已请求停止服务'; else echo '服务未运行'; fi
    rm -f "$PID"
    ;;
  status)
    if [ -f "$PID" ] && kill -0 "$(cat "$PID")" 2>/dev/null; then echo '服务运行中：http://127.0.0.1:3080'; else echo '服务未运行'; exit 1; fi
    ;;
  *) echo '用法：scripts/service.sh {start|stop|status}'; exit 2 ;;
esac
