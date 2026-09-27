#!/usr/bin/env bash
#
# Local divinedrop database for testing the card processor before touching
# production. Runs MySQL 8.0 in Docker (the dump is from 8.0.39 and uses
# utf8mb4_0900_ai_ci, which MariaDB cannot load) and restores database.sql
# into it.
#
#   ./local-db.sh up       create the container and load database.sql
#   ./local-db.sh reset    wipe everything and load it again from scratch
#   ./local-db.sh down     stop and remove the container (keeps the data)
#   ./local-db.sh dump     write the database back out to a .sql (or .sql.gz)
#   ./local-db.sh status   show container, port and row counts
#   ./local-db.sh shell    open a mysql prompt as the app user
#   ./local-db.sh query    run one statement, e.g. ./local-db.sh query "SELECT 1"
#
# Overridable: DD_PORT, DD_IMAGE, DD_CONTAINER, DD_DB, DD_USER, DD_PASS, DD_ROOT_PASS
set -euo pipefail

cd "$(dirname "$0")"

DUMP="${DD_DUMP:-database.sql}"
IMAGE="${DD_IMAGE:-mysql:8.0}"
CONTAINER="${DD_CONTAINER:-divinedrop-mysql}"
VOLUME="${CONTAINER}-data"
DB="${DD_DB:-divinedrop}"
# defaults match the credentials hardcoded in phases/worker.js
USER="${DD_USER:-ddadmin}"
PASS="${DD_PASS:-password}"
ROOT_PASS="${DD_ROOT_PASS:-rootpassword}"

say()  { printf '%s\n' "$*"; }
die()  { printf '🚨 %s\n' "$*" >&2; exit 1; }

port_free() {
    ! ss -ltn 2>/dev/null | grep -q ":$1 "
}

pick_port() {
    if [ -n "${DD_PORT:-}" ]; then
        printf '%s' "$DD_PORT"
        return
    fi
    # 3306 is what worker.js expects, but do not fight another project for it
    for candidate in 3306 3307 3308 3309; do
        if port_free "$candidate"; then
            printf '%s' "$candidate"
            return
        fi
    done
    die "no free port found in 3306-3309, set DD_PORT"
}

container_exists() {
    docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"
}

container_running() {
    docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"
}

host_port() {
    docker port "$CONTAINER" 3306/tcp 2>/dev/null | head -1 | sed 's/.*://'
}

mysql_root() {
    docker exec -i -e MYSQL_PWD="$ROOT_PASS" "$CONTAINER" \
        mysql -uroot --default-character-set=utf8mb4 "$@"
}

table_count() {
    mysql_root "$DB" -N -B -e \
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB'" \
        2>/dev/null | tr -d '[:space:]'
}

require_docker() {
    command -v docker >/dev/null || die "docker is not installed"
    docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
}

wait_ready() {
    say "⏳ Waiting for MySQL to accept connections"
    for _ in $(seq 1 90); do
        if mysql_root -e "SELECT 1" "$DB" >/dev/null 2>&1; then
            say "✔️  MySQL is ready"
            return 0
        fi
        sleep 1
    done
    say "🚨 MySQL did not come up. Last 20 log lines:"
    docker logs --tail 20 "$CONTAINER" || true
    exit 1
}

start_container() {
    local port
    port="$(pick_port)"
    if [ "$port" != "3306" ]; then
        say "⚠️  Port 3306 is taken by something else, using $port instead."
        say "   phases/worker.js hardcodes localhost:3306, so point it at $port before running phase 5."
    fi
    say "🐳 Starting $IMAGE as $CONTAINER on port $port"
    docker run -d \
        --name "$CONTAINER" \
        -e MYSQL_ROOT_PASSWORD="$ROOT_PASS" \
        -e MYSQL_DATABASE="$DB" \
        -e MYSQL_USER="$USER" \
        -e MYSQL_PASSWORD="$PASS" \
        -p "$port":3306 \
        -v "$VOLUME":/var/lib/mysql \
        "$IMAGE" \
        --character-set-server=utf8mb4 \
        --collation-server=utf8mb4_0900_ai_ci >/dev/null
}

# cat or zcat, depending on the extension
read_dump() {
    if [ "${1##*.}" = "gz" ]; then
        gzip -dc "$1"
    else
        cat "$1"
    fi
}

load_dump() {
    [ -f "$DUMP" ] || die "$DUMP not found in $(pwd)"
    say "💽 Loading $DUMP ($(du -h "$DUMP" | cut -f1)) into $DB - this takes a moment"
    # This dump was written with mysqldump's stderr redirected into it, so line 1
    # is a "[Warning] Using a password..." line that MySQL tries to parse as SQL.
    # LC_ALL=C because the card text contains invalid UTF-8.
    local noise
    noise="$(read_dump "$DUMP" | LC_ALL=C grep -ac '^mysqldump: \[Warning\]' || true)"
    if [ "${noise:-0}" != "0" ]; then
        say "   (stripping $noise stray mysqldump warning line(s))"
    fi
    # The dump carries DROP TABLE but no CREATE DATABASE, so the database has to
    # already exist; the container's MYSQL_DATABASE env var takes care of that.
    if ! read_dump "$DUMP" | LC_ALL=C sed '/^mysqldump: \[Warning\]/d' | mysql_root "$DB"; then
        die "loading the dump failed (see the error above)"
    fi
    say "✔️  Dump loaded"
}

summarise() {
    local port
    port="$(host_port)"
    say ""
    say "=== $DB on 127.0.0.1:$port ==="
    # exact counts: information_schema.TABLES.TABLE_ROWS is only an InnoDB estimate
    local tables sql
    tables="$(mysql_root "$DB" -N -B -e \
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA='$DB' ORDER BY TABLE_NAME" \
        2>/dev/null)"
    sql=""
    for table in $tables; do
        sql="${sql}${sql:+ UNION ALL }SELECT '$table' AS t, COUNT(*) AS n FROM \`$table\`"
    done
    if [ -n "$sql" ]; then
        mysql_root "$DB" -B -e "$sql" 2>/dev/null \
            | awk 'NR>1 {printf "  %-18s %10s\n", $1, $2}'
    fi
    say ""
    say "  mysql prompt:  mariadb -h127.0.0.1 -P$port -u$USER -p$PASS $DB"
    say ""
    say "  point the card processor at it either with a one-off:"
    say "    DB_HOST=127.0.0.1 DB_PORT=$port node index.js -p 5"
    say "  or by putting this in .env:"
    say "    DSN=mysql://$USER:$PASS@127.0.0.1:$port/$DB"
}

cmd_up() {
    require_docker
    if container_running; then
        say "✔️  $CONTAINER is already running on port $(host_port)"
    elif container_exists; then
        say "▶️  Starting existing container $CONTAINER"
        docker start "$CONTAINER" >/dev/null
    else
        start_container
    fi
    wait_ready
    if [ "$(table_count)" = "0" ]; then
        load_dump
    else
        say "✔️  $DB already has $(table_count) tables, skipping the dump (./local-db.sh reset to reload)"
    fi
    summarise
}

cmd_down() {
    require_docker
    if container_exists; then
        say "🛑 Removing $CONTAINER (volume $VOLUME kept)"
        docker rm -f "$CONTAINER" >/dev/null
    else
        say "  nothing to remove"
    fi
}

cmd_reset() {
    require_docker
    say "♻️  Resetting: this destroys the local $DB volume, production is untouched"
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    start_container
    wait_ready
    load_dump
    summarise
}

cmd_dump() {
    require_docker
    container_running || die "$CONTAINER is not running"
    local out="${1:-divinedrop-$(date +%Y%m%d-%H%M%S).sql}"
    [ -e "$out" ] && die "$out already exists, pick another name"

    say "💾 Dumping $DB to $out"
    # MYSQL_PWD keeps the password off the command line. Passing -p<pass> makes
    # the client print "[Warning] Using a password ..." on stderr, and that is
    # exactly the line that ended up as line 1 of the original database.sql and
    # stopped it restoring. stderr is deliberately left alone here, never merged
    # into the file.
    #
    # --hex-blob writes the binary(16) id columns as 0x... instead of _binary''
    # escapes, which keeps the file valid text so grep and friends behave.
    # No --databases, so the dump has no CREATE DATABASE/USE and restores into
    # whichever database you point it at - the same shape as the original.
    local ok=0
    if [ "${out##*.}" = "gz" ]; then
        docker exec -e MYSQL_PWD="$ROOT_PASS" "$CONTAINER" \
            mysqldump -uroot --single-transaction --default-character-set=utf8mb4 \
            --hex-blob --no-tablespaces --set-gtid-purged=OFF "$DB" | gzip > "$out" || ok=1
    else
        docker exec -e MYSQL_PWD="$ROOT_PASS" "$CONTAINER" \
            mysqldump -uroot --single-transaction --default-character-set=utf8mb4 \
            --hex-blob --no-tablespaces --set-gtid-purged=OFF "$DB" > "$out" || ok=1
    fi
    [ "$ok" = "0" ] || { rm -f "$out"; die "mysqldump failed"; }

    # Refuse to hand back a dump with the defect the original had.
    if read_dump "$out" | LC_ALL=C head -5 | grep -q '^mysqldump: '; then
        die "$out begins with a mysqldump warning and would not restore - not keeping it"
    fi
    if ! read_dump "$out" | LC_ALL=C tail -3 | grep -q 'Dump completed'; then
        die "$out has no 'Dump completed' marker, it is truncated - not keeping it"
    fi

    say "✔️  Wrote $out ($(du -h "$out" | cut -f1))"
    say "   tables: $(read_dump "$out" | LC_ALL=C grep -ac '^CREATE TABLE')"
    say "   restore elsewhere with:  mysql -u<user> -p <database> < $out"
}

cmd_status() {
    require_docker
    if container_running; then
        say "✔️  $CONTAINER running on port $(host_port)"
        summarise
    elif container_exists; then
        say "⏸️  $CONTAINER exists but is stopped - ./local-db.sh up to start it"
    else
        say "❌ $CONTAINER does not exist - ./local-db.sh up to create it"
    fi
}

cmd_shell() {
    require_docker
    container_running || die "$CONTAINER is not running"
    docker exec -it "$CONTAINER" mysql -u"$USER" -p"$PASS" "$DB"
}

cmd_query() {
    require_docker
    container_running || die "$CONTAINER is not running"
    [ $# -gt 0 ] || die 'usage: ./local-db.sh query "SELECT 1"'
    mysql_root "$DB" -e "$*"
}

case "${1:-up}" in
    up)     cmd_up ;;
    down)   cmd_down ;;
    reset)  cmd_reset ;;
    dump)   shift; cmd_dump "$@" ;;
    status) cmd_status ;;
    shell)  cmd_shell ;;
    query)  shift; cmd_query "$@" ;;
    *)      say "usage: ./local-db.sh {up|down|reset|dump|status|shell|query}"; exit 1 ;;
esac
