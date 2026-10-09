#!/bin/sh
# Nova Recover database tests on a throwaway Postgres on this Mac: nothing
# here can reach the live database. It builds an empty database, applies the
# Nova Recover file twice (proving it installs from nothing and again), runs
# the tests, then deletes everything.
# Needs Homebrew PostgreSQL (initdb, pg_ctl, psql). Usage: npm run test:recover
cd "$(dirname "$0")/.." || exit 1
for b in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /usr/local/opt/postgresql@17/bin; do
  [ -x "$b/initdb" ] && PATH="$b:$PATH" && break
done
command -v initdb >/dev/null || { echo "PostgreSQL is not installed (brew install postgresql@17)."; exit 1; }
D=$(mktemp -d /tmp/nvrc-test.XXXXXX) || exit 1
export LC_ALL=en_US.UTF-8   # macOS: without a real locale the server refuses to start
PORT=$((55000 + $$ % 900))
stop() { pg_ctl -D "$D/data" -m immediate stop >/dev/null 2>&1; rm -rf "$D"; }
trap stop EXIT INT TERM
initdb -D "$D/data" -U postgres -A trust -E UTF8 >/dev/null || exit 1
pg_ctl -D "$D/data" -o "-c listen_addresses='' -c unix_socket_directories='$D' -p $PORT -c fsync=off" -l "$D/log" -w start >/dev/null || { cat "$D/log"; exit 1; }
DB="postgresql:///postgres?host=$D&port=$PORT&user=postgres"
psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/recover-local-stubs.sql >/dev/null || exit 1
for f in sql_novax_recover_20261008.sql sql_novax_recover_p2_20261008.sql sql_novax_recover_p3_20261008.sql sql_novax_recover_phone_20261010.sql; do
  psql "$DB" -X -q -1 -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "FAILED: $f did not apply."; exit 1; }
  psql "$DB" -X -q -1 -v ON_ERROR_STOP=1 -f "$f" >/dev/null 2>&1 || { echo "FAILED: $f does not apply a second time."; exit 1; }
done
echo "Applied twice from an empty database."
OUT=$(psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/test-recover.sql 2>&1); RC=$?
echo "$OUT" | grep -c "NOTICE:  ok " | sed 's/$/ checks passed./'
echo "$OUT" | grep -v "NOTICE:  ok " | sed 's/^psql:[^ ]* //'
[ $RC -eq 0 ] || { echo "FAILED: database tests."; exit 1; }
OUT=$(psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/test-recover-p2.sql 2>&1); RC=$?
echo "$OUT" | grep -c "NOTICE:  ok " | sed 's/$/ checks passed./'
echo "$OUT" | grep -v "NOTICE:  ok " | sed 's/^psql:[^ ]* //'
[ $RC -eq 0 ] || { echo "FAILED: phase 2 database tests."; exit 1; }
OUT=$(psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/test-recover-p3.sql 2>&1); RC=$?
echo "$OUT" | grep -c "NOTICE:  ok " | sed 's/$/ checks passed./'
echo "$OUT" | grep -v "NOTICE:  ok " | sed 's/^psql:[^ ]* //'
[ $RC -eq 0 ] || { echo "FAILED: phase 3 database tests."; exit 1; }
OUT=$(psql "$DB" -X -q -v ON_ERROR_STOP=1 -f scripts/test-recover-phone.sql 2>&1); RC=$?
echo "$OUT" | grep -c "NOTICE:  ok " | sed 's/$/ checks passed./'
echo "$OUT" | grep -v "NOTICE:  ok " | sed 's/^psql:[^ ]* //'
[ $RC -eq 0 ] || { echo "FAILED: phone number database tests."; exit 1; }
