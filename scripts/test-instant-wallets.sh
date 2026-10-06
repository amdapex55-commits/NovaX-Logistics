#!/bin/sh
# Nova Instant money tests against the live database, always rolled back.
# Needs psql and the password in ~/.pgpass. Usage: scripts/test-instant-wallets.sh
# For a run that cannot touch the live database at all: npm run test:instant
cd "$(dirname "$0")/.." || exit 1
for t in scripts/test-instant-wallets.sql scripts/test-instant-audit.sql; do
psql "postgresql://postgres.rhzunbzbdzicajqtohwp@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres" \
  -X -q -v ON_ERROR_STOP=1 -f "$t" 2>&1 | grep -E "^psql:.*(NOTICE:  ok|ERROR)|ALL NOVA|FAIL" | sed 's/^psql:[^ ]* NOTICE:  /  /'
done
