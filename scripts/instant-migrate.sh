#!/bin/sh
# Applies the Nova Instant database files, in order, each in one transaction
# (a file that fails leaves nothing behind). The three always go together:
# a later file replaces functions an earlier one makes.
# Usage: scripts/instant-migrate.sh "<postgres connection string>"
cd "$(dirname "$0")/.." || exit 1
[ -n "$1" ] || { echo "Usage: scripts/instant-migrate.sh \"<connection string>\""; exit 1; }
for f in sql_novax_nova_instant_20261004.sql sql_novax_instant_wallets_20261005.sql sql_novax_instant_audit_20261006.sql; do
  echo "== $f"
  psql "$1" -X -q -1 -v ON_ERROR_STOP=1 -f "$f" >/dev/null || { echo "FAILED in $f: nothing from this file was kept."; exit 1; }
done
echo "Nova Instant database files applied."
