#!/usr/bin/env bash
# Refresh backend/functions/production_functions.sql from the live database.
# Dumps every public function whose definition is not already in a repo .sql,
# and refuses to write the file if a secret appears in any function body.
set -euo pipefail
cd "$(dirname "$0")/.."
export PGPASSFILE="${PGPASSFILE:-$HOME/.pgpass}"
PG=(psql -h aws-1-ap-southeast-2.pooler.supabase.com -p 5432 -U postgres.rhzunbzbdzicajqtohwp -d postgres -At)
"${PG[@]}" -c "select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'" | sort -u > /tmp/db_fns.txt
grep -ohoE "create or replace function public\.[a-z0-9_]+" ./*.sql | sed 's/.*public\.//' | sort -u > /tmp/repo_fns.txt
comm -23 /tmp/db_fns.txt /tmp/repo_fns.txt > /tmp/missing.txt
LIST=$(paste -sd, /tmp/missing.txt | sed "s/,/','/g")
"${PG[@]}" -o /tmp/fns_raw.sql -c "select string_agg(pg_get_functiondef(p.oid), E';\n\n' order by p.proname) || ';' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' and p.proname in ('$LIST')"
if grep -qiE 'eyJhbGciOi|service_role|bearer [A-Za-z0-9._-]{20}' /tmp/fns_raw.sql; then
  echo "REFUSING TO WRITE: a secret appears in a function body." >&2; exit 1
fi
echo "$(wc -l < /tmp/missing.txt) functions dumped"
