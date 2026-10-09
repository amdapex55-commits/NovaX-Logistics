#!/bin/sh
# Local only. Builds .claude/stress.html: the portal's demo, started with
# names, addresses and amounts as long as the longest real ones, and with
# scripts/dev/overflow-scan.js loaded so every piece of text can be measured
# against the box it sits in.
#
#   sh scripts/dev/make-stress-page.sh
#   preview server "novax-logistics", then open
#   http://localhost:8791/.claude/stress.html?demo=1
#   and in the page:  await __sweep(__ALL)      every screen
#                     await __drawers()         the parcel drawer in every status
#                     await __monkey("money")   press every button on one screen
#
# Run it at 360, 768, 1280 and 1440 wide before shipping anything that changes
# what the portal draws. Neither file is published: the site is built from an
# allowlist (scripts/build-public.mjs).
set -e
cd "$(dirname "$0")/../.."
mkdir -p .claude
python3 - <<'PY'
h = open('client.html', encoding='utf-8').read()
i = h.index('<head>') + len('<head>')
h = h[:i] + '\n<base href="/">\n<script>window.__STRESS_FROM_START=true;</script>\n<script src="/scripts/dev/overflow-scan.js"></script>\n' + h[i:]
open('.claude/stress.html', 'w', encoding='utf-8').write(h)
PY
echo "wrote .claude/stress.html"
