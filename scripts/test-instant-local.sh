#!/bin/sh
# Nova Instant database tests on a throwaway Postgres on this Mac: nothing
# here can reach the live database. It builds an empty database, applies the
# Nova Instant files in order (proving they install from nothing), runs
# the money tests and the audit tests, then deletes everything.
# Needs Homebrew PostgreSQL (initdb, pg_ctl, psql). Usage: npm run test:instant
cd "$(dirname "$0")/.." || exit 1
for b in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@17/bin; do
  [ -x "$b/initdb" ] && PATH="$b:$PATH" && break
done
command -v initdb >/dev/null || { echo "PostgreSQL is not installed (brew install postgresql@17)."; exit 1; }
D=$(mktemp -d /tmp/nvi-test.XXXXXX) || exit 1
export LC_ALL=en_US.UTF-8   # macOS: without a real locale the server refuses to start
PORT=$((54000 + $$ % 900))
stop() { pg_ctl -D "$D/data" -m immediate stop >/dev/null 2>&1; rm -rf "$D"; }
trap stop EXIT INT TERM
initdb -D "$D/data" -U postgres -A trust -E UTF8 >/dev/null || exit 1
pg_ctl -D "$D/data" -o "-c listen_addresses='' -c unix_socket_directories='$D' -p $PORT -c fsync=off" -l "$D/log" -w start >/dev/null || { cat "$D/log"; exit 1; }
DB="postgresql:///postgres?host=$D&port=$PORT&user=postgres"
psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/instant-local-stubs.sql >/dev/null || exit 1
sh scripts/instant-migrate.sh "$DB" || exit 1
sh scripts/instant-migrate.sh "$DB" >/dev/null || { echo "FAILED: the files do not apply a second time."; exit 1; }
echo "Applied twice from an empty database."
# An older file run by itself must refuse: it would put older functions back over newer ones.
if psql "$DB" -X -q -1 -v ON_ERROR_STOP=1 -f sql_novax_instant_wallets_20261005.sql >/dev/null 2>&1; then
  echo "FAILED: an older file ran by itself over a newer one."; exit 1
fi
echo "An older file refuses to run alone."
bad=0
for t in scripts/test-instant-wallets.sql scripts/test-instant-audit.sql; do
  out=$(psql "$DB" -X -q -v ON_ERROR_STOP=1 -f "$t" 2>&1)
  echo "$out" | grep -E "^psql:.*(NOTICE:  ok|ERROR)|ALL NOVA|FAIL" | sed 's/^psql:[^ ]* NOTICE:  /  /'
  echo "$out" | grep -q "^ALL NOVA" || bad=1
done
[ "$bad" = 0 ] && echo "NOVA INSTANT LOCAL TESTS PASSED" || { echo "NOVA INSTANT LOCAL TESTS FAILED"; exit 1; }
