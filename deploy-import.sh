#!/usr/bin/env bash
#
# Ships the card manifest to a server and applies it there, downloading a
# backup of the database first.
#
#   ./deploy-import.sh --host prod.example.com --user deploy --dry-run
#   ./deploy-import.sh --host prod.example.com --user deploy
#   ./deploy-import.sh --host prod.example.com --user deploy --prune
#
# Eight files go over the wire: import.js, the three library files it needs,
# the db-cnf.js the backup uses, a package.json naming its dependencies, the
# gzipped manifest, and the import.meta.json phase 5 wrote beside it - which is
# what tells the far side whether the manifest describes every card or whether
# phase 5 was interrupted. The images are already in R2 by the time this runs,
# and Decks and Sleeves are never written - the whole reason this exists instead
# of a database dump, which would carry real user rows over with it.
#
# Deck_Cards is the one exception, and only under --prune or --remove-withdrawn.
# Both delete slots naming a card that does not exist, because once the card is
# gone the row points at nothing: the deck comes up short rather than showing a
# blank. The decks themselves are never deleted.
#
# Before any of that is applied, mysqldump runs on the server and the gzipped
# result is downloaded to backups/, checked against its checksum on the far side
# and read for the trailer that says it is not truncated. If any of that fails
# the import does not run. db-cnf.js names the database for the dump by reading
# the remote .env through lib/db.js - the same file import.js resolves through -
# so the backup is of the database that is about to be written to and not some
# other one. --dry-run has nothing to save and skips it; --no-backup skips it
# deliberately.
#
# The dump reads its password from a defaults file written mode 600 on the
# server and deleted as soon as mysqldump exits, so it is never an argument in
# a process list. What comes back holds every user row the database has - that
# is the point of a backup - so it lands mode 600 under backups/, which is
# gitignored. ./local-db.sh takes it as DD_DUMP.
#
# The local .env is never shipped. It holds R2 credentials the importer has no
# use for, and the database it names is the local one. The server keeps its own
# .env in the target directory; --env-file sends one if it does not have it.
#
# Overridable by environment: DD_HOST, DD_USER, DD_SSH_PORT, DD_DIR, DD_RUNNER,
# DD_NODE_IMAGE, DD_MYSQL_IMAGE, DD_NETWORK, DD_BACKUP_DIR.
set -euo pipefail

cd "$(dirname "$0")"

HOST="${DD_HOST:-}"
SSH_USER="${DD_USER:-}"
SSH_PORT="${DD_SSH_PORT:-22}"
DIR="${DD_DIR:-~/card-import}"
RUNNER="${DD_RUNNER:-auto}"           # auto | node | docker
NODE_IMAGE="${DD_NODE_IMAGE:-node:18-alpine}"
MYSQL_IMAGE="${DD_MYSQL_IMAGE:-mysql:8.0}"
NETWORK="${DD_NETWORK:-host}"         # docker network the importer joins
BACKUP_DIR="${DD_BACKUP_DIR:-backups}"
MANIFEST="import.jsonl"
ENV_FILE=""
ASSUME_YES=0
BACKUP=1
KEEP_REMOTE=0
DRY_RUN=0
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
  --backup-dir <dir>   where the backup lands, default backups
                                                      (or DD_BACKUP_DIR)
  --no-backup          import without backing the database up first. Only
                       sensible if something else just did.
  --keep-remote-backup leave the server's copy of the dump where it was made
                       instead of removing it once it is safely down
  --mysql-image <ref>  image the dump runs from when it runs in a container,
                       default mysql:8.0              (or DD_MYSQL_IMAGE)
  --yes                do not ask before writing to the database
  --dry-run            parse and report on the server, write nothing
  --prune              after importing, delete rows nothing can render: a
                       printing with no hash, and anything hanging off a card
                       that is not there - deck slots included.
  --remove-withdrawn   delete cards the manifest no longer names - Scryfall has
                       withdrawn them. Removes the deck slots that named them.
                       Refused unless import.meta.json says the manifest is
                       complete.
  --withdrawn-max-share <n>
                       override the 0.05 ceiling that refuses a sweep which
                       would remove too much of the catalogue
  --assume-complete    treat the manifest as covering every card even though
                       import.meta.json is missing or says otherwise. Only
                       sensible if you know why it is short.
  --limit <n>          import only the first n cards
  -h, --help           this

Both sweeps report what they would do on every run and delete only when asked,
so an ordinary refresh shows the drift without acting on it. The whole sequence
is written up in README.md.
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
        --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
        --no-backup) BACKUP=0; shift ;;
        --keep-remote-backup)
                     KEEP_REMOTE=1; shift ;;
        --mysql-image) MYSQL_IMAGE="$2"; shift 2 ;;
        --yes)       ASSUME_YES=1; shift ;;
        --dry-run)   PASSTHROUGH+=("--dry-run"); ASSUME_YES=1; DRY_RUN=1; shift ;;
        --prune)     PASSTHROUGH+=("--prune"); shift ;;
        --remove-withdrawn)
                     PASSTHROUGH+=("--remove-withdrawn"); shift ;;
        --withdrawn-max-share)
                     PASSTHROUGH+=("--withdrawn-max-share" "$2"); shift 2 ;;
        --assume-complete)
                     PASSTHROUGH+=("--assume-complete"); shift ;;
        --limit)     PASSTHROUGH+=("--limit" "$2"); shift 2 ;;
        -h|--help)   usage ;;
        *)           die "unknown option $1 (try --help)" ;;
    esac
done

[ -n "$HOST" ] || die "no host. Pass --host or set DD_HOST"
[ -n "$SSH_USER" ] || die "no user. Pass --user or set DD_USER"
[ -f "$MANIFEST" ] || die "no manifest at $MANIFEST. Run phase 5 first."

# A dry run writes nothing, so there is nothing for a backup to be taken ahead
# of, however the flags arrived.
[ "$DRY_RUN" -eq 1 ] && BACKUP=0

SSH=(ssh -p "$SSH_PORT" "$SSH_USER@$HOST")
TARGET="$SSH_USER@$HOST"

# ---------------------------------------------------------------- preflight

cards=$(wc -l < "$MANIFEST" | tr -d '[:space:]')
[ "$cards" -gt 0 ] || die "$MANIFEST is empty"

say "🚀 Deploying card import to $TARGET:$DIR"
say "   📝 $MANIFEST holds $cards cards"

# What phase 5 recorded about the manifest. Read here as well as on the far side
# so a --remove-withdrawn that is going to be refused is refused before 40MB
# goes over the wire, and grepped rather than parsed because the server side is
# the authority and jq is not guaranteed anywhere.
META="${MANIFEST%.jsonl}.meta.json"
ASSUME_COMPLETE=0
case " ${PASSTHROUGH[*]:-} " in *" --assume-complete "*) ASSUME_COMPLETE=1 ;; esac
if [ -f "$META" ]; then
    if grep -q '"complete": *true' "$META"; then
        say "   ✅ $META says it describes every card"
    else
        say "   ⛔ $META says the manifest is incomplete"
        grep -E '"(deferred|failed|limited|skippedUpload)"' "$META" | sed 's/^/      /'
    fi
else
    say "   ⚠️  no $META beside it - phase 5 writes that, and nothing else records what the manifest covers"
fi

case " ${PASSTHROUGH[*]:-} " in
    *" --remove-withdrawn "*)
        if [ "$ASSUME_COMPLETE" -ne 1 ] && ! grep -q '"complete": *true' "$META" 2>/dev/null; then
            say ""
            say "   --remove-withdrawn deletes cards, and the deck slots naming them, on the"
            say "   strength of a card being absent from this manifest. Nothing here says the"
            say "   manifest covers every card, so absent may just mean phase 5 stopped early."
            die "re-run phase 5 until it reports the manifest complete, or pass --assume-complete"
        fi
        ;;
esac

# One round trip rather than one per question: what the server has to work with,
# and whether its mysqldump is MariaDB's, which has never had --set-gtid-purged.
CAPS=$("${SSH[@]}" '
for c in node docker mysqldump; do
    command -v "$c" >/dev/null 2>&1 && printf "%s " "$c"
done
mysqldump --version 2>/dev/null | grep -qi mariadb && printf "mariadb "
exit 0' 2>/dev/null) || die "cannot ssh to $TARGET on port $SSH_PORT"

has() { case " $CAPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

# Decide how the importer will be run before anything is copied, so a server
# with neither node nor docker fails here rather than after the upload.
if [ "$RUNNER" = "auto" ]; then
    if has node; then
        RUNNER="node"
    elif has docker; then
        RUNNER="docker"
    else
        die "$TARGET has neither node nor docker"
    fi
fi
say "   🏃 runner: $RUNNER"

# Where mysqldump comes from, decided here for the same reason. db-cnf.js runs
# under whichever runner the import will use, so that both read .env by the same
# rules - and that settles who can read the defaults file back: one written
# inside a container belongs to root, which the host's own mysqldump could not
# open, so a docker runner dumps from a container too. The other way round is
# fine; root inside a container can read what the ssh user wrote.
DUMPER=""
MARIADB_DUMPER=0
if [ "$BACKUP" -eq 1 ]; then
    if [ "$RUNNER" = "docker" ]; then
        DUMPER="docker"
    elif has mysqldump && ! has mariadb; then
        DUMPER="host"
    elif has docker; then
        DUMPER="docker"
        has mariadb && say "   ℹ️  the server's mysqldump is MariaDB's, dumping from $MYSQL_IMAGE instead"
    elif has mysqldump; then
        DUMPER="host"
        MARIADB_DUMPER=1
        say "   ⚠️  the server's mysqldump is MariaDB's, and it is the only one there. Dumping"
        say "      with it, without the --set-gtid-purged it does not have. Check that what"
        say "      comes back restores before relying on it."
    else
        die "nothing on $TARGET can take a backup: no mysqldump, no docker. Install one, or pass --no-backup to deploy without one."
    fi
    say "   💾 backup: $DUMPER mysqldump -> $BACKUP_DIR"
else
    [ "$DRY_RUN" -eq 1 ] || say "   ⚠️  --no-backup: the database will be written to without being saved first"
fi

if [ ${#PASSTHROUGH[@]} -gt 0 ]; then
    say "   ⚙️  import flags: ${PASSTHROUGH[*]}"
fi

# Whether this run can delete deck slots, so the prompt says so instead of
# promising that user tables are out of reach. They are, until one of these.
TOUCHES_DECKS=0
if [ ${#PASSTHROUGH[@]} -gt 0 ]; then
    case " ${PASSTHROUGH[*]} " in
        *" --prune "*|*" --remove-withdrawn "*) TOUCHES_DECKS=1 ;;
    esac
fi

if [ "$ASSUME_YES" -ne 1 ]; then
    say ""
    say "   This writes $cards cards to the database on $HOST. Not a dry run."
    if [ "$TOUCHES_DECKS" -eq 1 ]; then
        say "   WARNING: Deck_Cards slots WILL be deleted where they name a card"
        say "   that does not exist. Decks, Sleeves and other user rows are not."
    else
        say "   Only card tables are written. No deck or user row is touched."
    fi
    if [ "$BACKUP" -eq 1 ]; then
        say "   A backup of the whole database comes down to $BACKUP_DIR first, and"
        say "   nothing is imported unless it arrives intact."
    else
        say "   WARNING: --no-backup. Nothing will be saved before this writes."
    fi
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
cp import.js db-cnf.js "$STAGE/"
cp lib/importer.js lib/constants.js lib/db.js "$STAGE/lib/"

# Sent under the name the remote manifest will have, since the far side derives
# it from --file and that is always import.jsonl there.
if [ -f "$META" ]; then
    cp "$META" "$STAGE/import.meta.json"
fi

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
scp -P "$SSH_PORT" -q "$STAGE/import.js" "$STAGE/db-cnf.js" "$STAGE/package.json" "$STAGE/import.jsonl.gz" "$TARGET:$DIR/"
if [ -f "$STAGE/import.meta.json" ]; then
    scp -P "$SSH_PORT" -q "$STAGE/import.meta.json" "$TARGET:$DIR/"
else
    # Removed rather than left behind: a stale one from a previous deploy would
    # vouch for a manifest it has never seen.
    "${SSH[@]}" "rm -f $DIR/import.meta.json"
fi
scp -P "$SSH_PORT" -q "$STAGE/lib/importer.js" "$STAGE/lib/constants.js" "$STAGE/lib/db.js" "$TARGET:$DIR/lib/"

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

# How each remote step is run. Built once, here, because every one of them
# changes shape with the runner - and $(pwd) is left for the remote shell to
# expand, since $DIR may be ~/card-import and a quoted tilde is not a path.
WORK='-v "$(pwd)":/work -w /work'
CNF=".backup.cnf"
if [ "$RUNNER" = "docker" ]; then
    # A throwaway container, so the server needs nothing but docker. It joins
    # the host network by default, which is how it reaches a database that
    # compose publishes on 3306; pass --network for a compose network instead,
    # and set DB_HOST to the service name in the remote .env.
    NPM_RUN="docker run --rm $WORK $NODE_IMAGE npm"
    NODE_RUN="docker run --rm $WORK --network $NETWORK --env-file .env $NODE_IMAGE node"
else
    NPM_RUN="npm"
    NODE_RUN="node"
fi

# The same flags local-db.sh dumps with, so what comes back is a file it can
# load as it stands: --single-transaction for a consistent read without locking
# anyone out, --hex-blob so the binary(16) ids stay printable text, and
# --no-tablespaces because the app's user has no PROCESS grant. No --databases,
# so the dump carries no CREATE DATABASE and restores into whatever it is
# pointed at.
DUMP_FLAGS="--single-transaction --default-character-set=utf8mb4 --hex-blob --no-tablespaces"
[ "$MARIADB_DUMPER" -eq 1 ] || DUMP_FLAGS="$DUMP_FLAGS --set-gtid-purged=OFF"
if [ "$DUMPER" = "docker" ]; then
    # --protocol=TCP because .env usually says localhost, and a client inside a
    # container would read that as a unix socket that is not in there with it.
    DUMP_RUN="docker run --rm $WORK --network $NETWORK --entrypoint mysqldump $MYSQL_IMAGE --defaults-extra-file=/work/$CNF --protocol=TCP"
else
    DUMP_RUN="mysqldump --defaults-extra-file=\"\$(pwd)/$CNF\""
fi

backup() {
    local ts stamp remote_base local_file dump_sum local_sum tables opening trailer

    ts="$(date +%Y%m%d-%H%M%S)"
    stamp="$(printf '%s' "$HOST" | sed 's/[^A-Za-z0-9._-]/_/g')"
    remote_base="backup-$ts.sql"
    local_file="$BACKUP_DIR/divinedrop-$stamp-$ts.sql.gz"

    mkdir -p "$BACKUP_DIR"
    [ -e "$local_file" ] && die "$local_file already exists"

    say "   💾 Backing up the database before anything is written to it"

    # One remote command for the whole dump, so the defaults file holding the
    # password cannot outlive it whichever way this ends. db-cnf.js prints the
    # database to dump on stdout and says which one it is on stderr, which is
    # why that line appears in this output.
    if ! dump_sum=$("${SSH[@]}" sh -s <<EOF
set -e
cd $DIR
db=\$($NODE_RUN db-cnf.js $CNF)
status=0
$DUMP_RUN $DUMP_FLAGS "\$db" > $remote_base || status=\$?
rm -f $CNF
if [ \$status -ne 0 ]; then
    rm -f $remote_base
    echo "mysqldump exited \$status" >&2
    exit 1
fi
# A dump that stopped early is a valid file that is simply short, and mysqldump
# does not report that it was. This trailer is the last thing it writes.
if ! tail -3 $remote_base | grep -q 'Dump completed'; then
    rm -f $remote_base
    echo "the dump has no 'Dump completed' trailer, so it is truncated" >&2
    exit 1
fi
gzip -f $remote_base
sha256sum $remote_base.gz | cut -d' ' -f1
EOF
    ); then
        die "the backup failed on $HOST. Nothing was imported."
    fi

    say "   📥 Downloading it to $local_file"
    scp -P "$SSH_PORT" -q "$TARGET:$DIR/$remote_base.gz" "$local_file"
    chmod 600 "$local_file"

    # A file that fails any of the checks below is renamed out of the way before
    # anything else happens. Left where it is it would sit in backups/ looking
    # exactly like a backup, and be reached for on the day one is needed.
    discard() {
        mv -f "$local_file" "$local_file.corrupt" 2>/dev/null || true
        die "$1. What arrived is at $local_file.corrupt - the import did not run"
    }

    local_sum="$(sha256sum "$local_file" | cut -d' ' -f1)"
    [ "$dump_sum" = "$local_sum" ] || discard "backup checksum mismatch: $dump_sum on the server, $local_sum here"
    gzip -t "$local_file" 2>/dev/null || discard "the backup did not arrive as intact gzip"

    # The two defects the original database.sql shipped with, checked now rather
    # than discovered on the day the backup is needed: a mysqldump warning on
    # line 1 that a restore tries to parse as SQL, and a file that stops mid
    # dump. Captured into variables rather than piped into grep because head
    # closing the pipe early is a pipefail failure on its own.
    opening="$(gzip -dc "$local_file" 2>/dev/null | LC_ALL=C head -5 || true)"
    case "$opening" in
        "mysqldump: "*) discard "the backup begins with a mysqldump warning, so it would not restore" ;;
    esac
    trailer="$(gzip -dc "$local_file" 2>/dev/null | LC_ALL=C tail -3 || true)"
    case "$trailer" in
        *"Dump completed"*) ;;
        *) discard "the backup has no 'Dump completed' trailer, so it arrived short" ;;
    esac
    tables="$(gzip -dc "$local_file" | LC_ALL=C grep -ac '^CREATE TABLE' || true)"

    say "      ✔️  $(du -h "$local_file" | cut -f1), $tables tables, mode 600"
    say "         load it with:  DD_DUMP=$local_file ./local-db.sh reset"

    if [ "$KEEP_REMOTE" -eq 1 ]; then
        say "      the server's copy is still at $DIR/$remote_base.gz"
    else
        "${SSH[@]}" "rm -f $DIR/$remote_base.gz"
    fi
}

say "   📦 Unpacking and installing dependencies"
"${SSH[@]}" "cd $DIR && gzip -df import.jsonl.gz && $NPM_RUN install --omit=dev --no-audit --no-fund --loglevel=error"

if [ "$BACKUP" -eq 1 ]; then
    backup
fi

say "   🗂️  Importing"
say ""
"${SSH[@]}" "cd $DIR && $NODE_RUN import.js $IMPORT_ARGS"

say ""
say "✔️  Import finished on $HOST"
say "   The manifest and its errors are in $DIR on the server."
