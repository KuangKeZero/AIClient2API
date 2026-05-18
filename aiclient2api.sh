#!/usr/bin/env bash

set -u

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${PID_FILE:-$PROJECT_DIR/.aiclient2api.pid}"
LOG_DIR="${LOG_DIR:-$PROJECT_DIR/logs}"
LOG_FILE="${LOG_FILE:-$LOG_DIR/aiclient2api.out.log}"
STOP_TIMEOUT="${STOP_TIMEOUT:-20}"

cd "$PROJECT_DIR" || exit 1

usage() {
    cat <<EOF
用法: $0 {start|stop|restart|status} [启动参数...]

示例:
  $0 start
  $0 start --no-ui
  $0 stop
  $0 restart
  $0 status

环境变量:
  PID_FILE      PID 文件路径，默认: $PID_FILE
  LOG_FILE      输出日志路径，默认: $LOG_FILE
  STOP_TIMEOUT  停止等待秒数，默认: $STOP_TIMEOUT
EOF
}

info() {
    printf '[AIClient2API] %s\n' "$*"
}

fail() {
    printf '[AIClient2API][错误] %s\n' "$*" >&2
    exit 1
}

read_pid() {
    if [ -f "$PID_FILE" ]; then
        sed -n '1{s/[^0-9].*$//;p;}' "$PID_FILE"
    fi
}

is_running() {
    local pid="$1"
    [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1
}

is_project_process() {
    local pid="$1"

    if [ -d "/proc/$pid" ] && [ -L "/proc/$pid/cwd" ]; then
        [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$PROJECT_DIR" ]
        return
    fi

    # macOS 等无 /proc 环境下只能确认进程存在。
    is_running "$pid"
}

collect_tree() {
    local root="$1"
    local child

    for child in $(pgrep -P "$root" 2>/dev/null || true); do
        collect_tree "$child"
    done

    printf '%s\n' "$root"
}

wait_for_exit() {
    local deadline=$((SECONDS + STOP_TIMEOUT))
    local pid
    shift

    while [ "$SECONDS" -lt "$deadline" ]; do
        local alive=0
        for pid in "$@"; do
            if is_running "$pid"; then
                alive=1
                break
            fi
        done

        [ "$alive" -eq 0 ] && return 0
        sleep 1
    done

    return 1
}

ensure_ready_to_start() {
    command -v node >/dev/null 2>&1 || fail "未检测到 Node.js"
    command -v npm >/dev/null 2>&1 || fail "未检测到 npm"
    [ -f "$PROJECT_DIR/package.json" ] || fail "未找到 package.json，请在项目根目录运行"
    [ -f "$PROJECT_DIR/src/core/master.js" ] || fail "未找到 src/core/master.js"
}

start_app() {
    local pid
    pid="$(read_pid)"

    if is_running "$pid"; then
        if is_project_process "$pid"; then
            info "服务已在运行，PID: $pid"
            info "日志: $LOG_FILE"
            return 0
        fi

        fail "PID 文件指向了其他仍在运行的进程: $pid，请先检查 $PID_FILE"
    fi

    ensure_ready_to_start
    mkdir -p "$LOG_DIR"

    info "正在启动服务..."
    info "日志输出: $LOG_FILE"

    if command -v setsid >/dev/null 2>&1; then
        nohup setsid npm start -- "$@" >>"$LOG_FILE" 2>&1 &
    else
        nohup npm start -- "$@" >>"$LOG_FILE" 2>&1 &
    fi

    pid=$!
    printf '%s\n' "$pid" >"$PID_FILE"

    sleep 2
    if is_running "$pid"; then
        info "启动成功，PID: $pid"
        info "管理界面: http://localhost:3000"
        return 0
    fi

    fail "启动失败，请查看日志: $LOG_FILE"
}

stop_app() {
    local pid
    pid="$(read_pid)"

    if ! is_running "$pid"; then
        info "服务未运行"
        rm -f "$PID_FILE"
        return 0
    fi

    if ! is_project_process "$pid"; then
        fail "PID 文件指向了其他进程: $pid，已取消停止操作"
    fi

    local pgid
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')"

    local pids
    pids="$(collect_tree "$pid" | awk 'NF' | sort -rn)"

    info "正在停止服务，PID: $pid"

    if [ "$pgid" = "$pid" ]; then
        kill -TERM "-$pid" >/dev/null 2>&1 || true
    else
        # 旧脚本启动的进程可能没有独立进程组，按进程树逐个发送信号。
        while IFS= read -r tree_pid; do
            kill -TERM "$tree_pid" >/dev/null 2>&1 || true
        done <<EOF
$pids
EOF
    fi

    if ! wait_for_exit dummy $pids; then
        info "等待超时，强制结束残留进程"
        if [ "$pgid" = "$pid" ]; then
            kill -KILL "-$pid" >/dev/null 2>&1 || true
        else
            while IFS= read -r tree_pid; do
                kill -KILL "$tree_pid" >/dev/null 2>&1 || true
            done <<EOF
$pids
EOF
        fi
    fi

    rm -f "$PID_FILE"
    info "服务已停止"
}

status_app() {
    local pid
    pid="$(read_pid)"

    if is_running "$pid" && is_project_process "$pid"; then
        info "服务运行中，PID: $pid"
        ps -fp "$pid" 2>/dev/null || true
        info "日志: $LOG_FILE"
        return 0
    fi

    info "服务未运行"
    return 1
}

command="${1:-}"
[ -n "$command" ] && shift || true

case "$command" in
    start)
        start_app "$@"
        ;;
    stop)
        stop_app
        ;;
    restart)
        stop_app
        start_app "$@"
        ;;
    status)
        status_app
        ;;
    -h|--help|help|'')
        usage
        ;;
    *)
        usage
        fail "未知命令: $command"
        ;;
esac
