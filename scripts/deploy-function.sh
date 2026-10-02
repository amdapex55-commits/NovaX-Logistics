#!/bin/zsh
# Deploy one Supabase Edge Function only if it type-checks (and, for the shared
# destination checker, only if its tests pass). The JWT setting is read from
# the function as deployed now, so a redeploy never changes who may call it.
# Usage: zsh scripts/deploy-function.sh <function-name>
set -e
cd "${0:A:h}/.."
F="$1"; [ -n "$F" ] && [ -f "supabase/functions/$F/index.ts" ] || { echo "Usage: deploy-function.sh <name>"; exit 2; }
CFG=scripts/deno/deno.json
echo "Type-checking $F ..."
deno check --config "$CFG" "supabase/functions/$F/index.ts"
if grep -q '_shared/destination.ts' "supabase/functions/$F/index.ts"; then
  deno test --config "$CFG" --allow-net=jsr.io supabase/functions/_shared/destination_test.ts
fi
TOKEN=$(zsh -ic 'echo $SUPABASE_TOKEN_NOVAX' 2>/dev/null)
REF=rhzunbzbdzicajqtohwp
VERIFY=$(SUPABASE_ACCESS_TOKEN=$TOKEN supabase functions list --project-ref $REF -o json 2>/dev/null |
  python3 -c "import json,sys; d={f['slug']:f.get('verify_jwt') for f in json.load(sys.stdin)}; print({True:'yes',False:'no'}.get(d.get('$F'),'new'))")
case "$VERIFY" in
  no)  FLAG=--no-verify-jwt ;;
  yes) FLAG= ;;
  *)   echo "$F is not deployed yet: decide its JWT setting and deploy it by hand once."; exit 3 ;;
esac
SUPABASE_ACCESS_TOKEN=$TOKEN supabase functions deploy "$F" $FLAG --project-ref $REF
