#!/bin/bash
# Is NovaX AI live? Run this after topping up the Anthropic balance.
#
# The edge function stays up and answers even when the model behind it does
# not, so "the function responds" is not the same as "the AI works". This
# checks deployment, then tells you the one thing that actually proves it.
cd "$(dirname "$0")"
SB=$(grep -oE 'https://[a-z0-9]+\.supabase\.co' client.html | head -1)
KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_-]+' client.html | head -1)

echo "project: $SB"
echo
echo "1. Are the functions deployed?"
for f in novax-ai novax-ai-support novax-autopilot-brain; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 -X POST \
    "$SB/functions/v1/$f" -H "content-type: application/json" -d '{}')
  case "$code" in
    401|400) echo "   OK      $f  (deployed, auth-gated)";;
    404)     echo "   absent  $f  (never deployed — expected for support/brain)";;
    *)       echo "   ?? $code  $f";;
  esac
done

echo
echo "2. Does it execute?"
OUT=$(curl -s --max-time 30 -X POST "$SB/functions/v1/novax-ai" \
  -H "content-type: application/json" -H "apikey: $KEY" \
  -H "Authorization: Bearer $KEY" -d '{"mode":"open"}')
echo "   $OUT" | head -c 200
echo
case "$OUT" in
  *"Could not read your account"*)
    echo "   OK — reached the account lookup. The publishable key has no merchant"
    echo "        identity, so this is as far as an unauthenticated check can go.";;
  *model_failed*|*"reasoning service"*)
    echo "   MODEL DOWN — the function ran but the Anthropic call failed."
    echo "        That is the balance. Top up, then re-run this.";;
esac

echo
echo "3. The check that actually proves it (30 seconds):"
echo "   Sign in to the merchant portal -> Support tab -> ask:"
echo "        \"what is my wallet balance?\""
echo "   Working  : a real figure, plus suggestion chips underneath."
echo "   Still out: \"I couldn't reach my reasoning service just now.\""
echo
echo "   If it still fails, the real error is in the function log:"
echo "   Supabase -> Edge Functions -> novax-ai -> Logs"
echo "   Look for 'NovaX AI model call failed:' — it prints Anthropic's own"
echo "   status and message, which names a credit problem explicitly."
