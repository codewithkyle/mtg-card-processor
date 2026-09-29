#!/usr/bin/env bash
#
# Ships the card manifest to a server and applies it there.
#
#   ./deploy-import.sh --host prod.example.com --user deploy --dry-run
#   ./deploy-import.sh --host prod.example.com --user deploy
#   ./deploy-import.sh --host prod.example.com --user deploy --prune
#
# Only five files go over the wire: import.js, the two library files it needs,
# a package.json naming its dependencies, and the gzipped manifest. The images
# are already in R2 by the time this runs, and the manifest can only touch card
# tables - Decks, Deck_Cards and Sleeves are not reachable from it, which is
# the whole reason this exists instead of a database dump.
#
# The local .env is never shipped. It holds R2 credentials the importer has no
# use for, and the database it names is the local one. The server keeps its own
# .env in the target directory; --env-file sends one if it does not have it.
#
# Overridable by environment: DD_HOST, DD_USER, DD_SSH_PORT, DD_DIR, DD_RUNNER,
# DD_NODE_IMAGE, DD_NETWORK.
set -euo pipefail

cd "$(dirname "$0")"

HOST="${DD_HOST:-}"
SSH_USER="${DD_USER:-}"
SSH_PORT="${DD_SSH_PORT:-22}"
DIR="${DD_DIR:-~/card-import}"
RUNNER="${DD_RUNNER:-auto}"           # auto | node | docker
NODE_IMAGE="${DD_NODE_IMAGE:-node:18-alpine}"
NETWORK="${DD_NETWORK:-host}"         # docker network the importer joins
MANIFEST="import.jsonl"
ENV_FILE=""
ASSUME_YES=0
PASSTHROUGH=()

say()  { printf '%s\n' "$*"; }
die()  { printf '🚨 %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; /^set -euo/d'
    cat <<'EOF'
Options:
  --host <host>        server to deploy to            (or DD_HOST)
  --user <user>        ssh user                       (or DD_USER)
  --ssh-port <port>    ssh port, default 22           (or DD_SSH_PORT)
  --dir <path>         remote directory               (or DD_DIR)
  --manifest <file>    local manifest, default import.jsonl
  --env-file <file>    send this file as the remote .env (mode 600)
  --runner <auto|node|docker>
                       how to run it remotely. auto uses the host's node when
                       it has one and falls back to a throwaway container.
  --network <name>     docker network to join, default host
  --yes                do not ask before writing to the database
  --dry-run            parse and report on the server, write nothing
  --prune              after importing, drop the pre-hash Card_Prints rows
  --limit <n>          import only the first n cards
  -h, --help           this
EOF
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --host)      HOST="$2"; shift 2 ;;
        --user)      SSH_USER="$2"; shift 2 ;;
        --ssh-port)  SSH_PORT="$2"; shift 2 ;;
        --dir)       DIR="$2"; shift 2 ;;
        --manifest)  MANIFEST="$2"; shift 2 ;;
        --env-file)  ENV_FILE="$2"; shift 2 ;;
        --runner)    RUNNER="$2"; shift 2 ;;
        --network)   NETWORK="$2"; shift 2 ;;
        --yes)       ASSUME_YES=1; shift ;;
        --dry-run)   PASSTHROUGH+=("--dry-run"); ASSUME_YES=1; shift ;;
        --prune)     PASSTHROUGH+=("--prune"); shift ;;
        --limit)     PASSTHROUGH+=("--limit" "$2"); shift 2 ;;
        -h|--help)   usage ;;
        *)           die "unknown option $1 (try --help)" ;;
    esac
done

[ -n "$HOST" ] || die "no host. Pass --host or set DD_HOST"
[ -n "$SSH_USER" ] || die "no user. Pass --user or set DD_USER"
[ -f "$MANIFEST" ] || die "no manifest at $MANIFEST. Run phase 5 first."

SSH=(ssh -p "$SSH_PORT" "$SSH_USER@$HOST")
TARGET="$SSH_USER@$HOST"

# ---------------------------------------------------------------- preflight

cards=$(wc -l < "$MANIFEST" | tr -d '[:space:]')
[ "$cards" -gt 0 ] || die "$MANIFEST is empty"

say "🚀 Deploying card import to $TARGET:$DIR"
say "   📝 $MANIFEST holds $cards cards"

"${SSH[@]}" true 2>/dev/null || die "cannot ssh to $TARGET on port $SSH_PORT"

# Decide how the importer will be run before anything is copied, so a server
# with neither node nor docker fails here rather than after the upload.
if [ "$RUNNER" = "auto" ]; then
    if "${SSH[@]}" "command -v node >/dev/null 2>&1"; then
        RUNNER="node"
    elif "${SSH[@]}" "command -v docker >/dev/null 2>&1"; then
        RUNNER="docker"
    else
        die "$TARGET has neither node nor docker"
    fi
fi
say "   🏃 runner: $RUNNER"

if [ ${#PASSTHROUGH[@]} -gt 0 ]; then
    say "   ⚙️  import flags: ${PASSTHROUGH[*]}"
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    say ""
    say "   This writes $cards cards to the database on $HOST."
    say "   User tables are not reachable from the manifest, but this is not a dry run."
    printf '   Continue? [y/N] '
    read -r reply
    case "$reply" in
        [yY]|[yY][eE][sS]) ;;
        *) die "aborted" ;;
    esac
fi

# ------------------------------------------------------------------ payload

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/lib"
cp import.js "$STAGE/"
cp lib/importer.js lib/constants.js "$STAGE/lib/"

# Pinned to what this repo resolved, so the server installs the same versions
# rather than whatever is newest on the day it runs.
cat > "$STAGE/package.json" <<'EOF'
{
  "name": "divinedrop-card-import",
  "private": true,
  "dependencies": {
    "cli-progress": "^3.9.1",
    "dotenv": "^8.6.0",
    "mysql2": "^3.6.0",
    "uuid": "^9.0.0",
    "yargs": "^16.2.0"
  }
}
EOF

say "   🗜️  Compressing the manifest"
gzip -c "$MANIFEST" > "$STAGE/import.jsonl.gz"
raw=$(wc -c < "$MANIFEST")
gz=$(wc -c < "$STAGE/import.jsonl.gz")
say "      $((raw / 1048576)) MB -> $((gz / 1048576)) MB"

# Checked on the far side, because a manifest that arrives truncated would
# import cleanly and simply leave cards out.
sum=$(cd "$STAGE" && sha256sum import.jsonl.gz | cut -d' ' -f1)

# -------------------------------------------------------------------- ship

say "   📤 Copying to $TARGET"
"${SSH[@]}" "mkdir -p $DIR/lib"
scp -P "$SSH_PORT" -q "$STAGE/import.js" "$STAGE/package.json" "$STAGE/import.jsonl.gz" "$TARGET:$DIR/"
scp -P "$SSH_PORT" -q "$STAGE/lib/importer.js" "$STAGE/lib/constants.js" "$TARGET:$DIR/lib/"

if [ -n "$ENV_FILE" ]; then
    [ -f "$ENV_FILE" ] || die "no env file at $ENV_FILE"
    say "   🔑 Installing $ENV_FILE as the remote .env"
    # Over stdin rather than as an argument, so the contents never appear in
    # the process list on either machine.
    "${SSH[@]}" "umask 077; cat > $DIR/.env" < "$ENV_FILE"
fi

say "   🔍 Verifying the transfer"
remote_sum=$("${SSH[@]}" "sha256sum $DIR/import.jsonl.gz | cut -d' ' -f1")
[ "$sum" = "$remote_sum" ] || die "checksum mismatch: sent $sum, arrived $remote_sum"

# --------------------------------------------------------------------- run

"${SSH[@]}" "test -f $DIR/.env" 2>/dev/null || {
    say ""
    say "   ⚠️  There is no .env in $DIR on $HOST."
    say "      The importer reads DSN, or DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME."
    say "      Create it there, or pass --env-file."
    die "no remote database configuration"
}

IMPORT_ARGS="--file import.jsonl"
if [ ${#PASSTHROUGH[@]} -gt 0 ]; then
    IMPORT_ARGS="$IMPORT_ARGS ${PASSTHROUGH[*]}"
fi

say "   📦 Installing dependencies and importing"
say ""

if [ "$RUNNER" = "docker" ]; then
    # A throwaway container, so the server needs nothing but docker. It joins
    # the host network by default, which is how it reaches a database that
    # compose publishes on 3306; pass --network for a compose network instead,
    # and set DB_HOST to the service name in the remote .env.
    "${SSH[@]}" "cd $DIR && gzip -df import.jsonl.gz && \
        docker run --rm \
            -v \"\$(pwd)\":/work -w /work \
            --network $NETWORK \
            --env-file $DIR/.env \
            $NODE_IMAGE \
            sh -c 'npm install --omit=dev --no-audit --no-fund --loglevel=error && node import.js $IMPORT_ARGS'"
else
    "${SSH[@]}" "cd $DIR && gzip -df import.jsonl.gz && \
        npm install --omit=dev --no-audit --no-fund --loglevel=error && \
        node import.js $IMPORT_ARGS"
fi

say ""
say "✔️  Import finished on $HOST"
say "   The manifest and its errors are in $DIR on the server."
