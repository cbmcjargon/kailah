#!/usr/bin/env bash
# Mirror the current build to the second origin of the wallet,
# https://wallet.photoprompting.org (nginx on a VPS; the webroot is read from
# the site's nginx config).
#
# Netlify (`npm run build && npx netlify-cli deploy --prod --dir=dist --site …`)
# is the primary deploy; this keeps the second origin identical:
#   1. ships dist/ (tar over ssh into a staging dir, atomic swap, previous
#      build kept at <webroot>.prev for a one-command rollback);
#   2. regenerates EVERY security header in the nginx server block, and in
#      each of its location blocks, from public/_headers — nginx never reads
#      Netlify's _headers file, which is how the VPS copy once sat for two
#      months with a CSP trusting a dead RPC host. The managed set is
#      whatever the `/*` block of _headers lists.
#
# Usage:  npm run build && WALLET_VPS=root@<host> deploy/vps-redeploy.sh
# Auth:   your ssh-agent (ssh-add the key for that host first). Nothing
#         credential-related lives in this file. No rsync needed on the box.
set -euo pipefail

: "${WALLET_VPS:?set WALLET_VPS=user@host for the nginx box}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
remote() { ssh "${SSH_OPTS[@]}" "$WALLET_VPS" "$@"; }

cd "$(dirname "$0")/.."
[ -f dist/index.html ] || { echo "dist/ is missing — run: npm run build" >&2; exit 1; }

# Security headers → nginx add_header lines, straight from public/_headers.
HEADERS_FILE=$(mktemp)
awk '
  /^\/\*/ { in_block = 1; next }
  in_block && /^[[:space:]]+[A-Za-z-]+:/ {
    name = $1; sub(/:$/, "", name)
    val = $0; sub(/^[[:space:]]+[A-Za-z-]+:[[:space:]]*/, "", val)
    printf "    add_header %s \"%s\" always;\n", name, val
    next
  }
  in_block && !/^[[:space:]]/ { in_block = 0 }
' public/_headers > "$HEADERS_FILE"
MANAGED=$(sed -E 's/^[[:space:]]*add_header ([A-Za-z-]+) .*/\1/' "$HEADERS_FILE" | tr '\n' ' ')
[ -s "$HEADERS_FILE" ] || { echo "could not read security headers from public/_headers" >&2; exit 1; }
echo "managing headers: $MANAGED"

# Compression, managed the same way (Netlify compresses for us; stock nginx
# gzips only text/html, which once sent the 90 KB entry chunk as 280 KB).
# gzip_* directives inherit into locations, unlike add_header.
GZIP_FILE=$(mktemp)
cat > "$GZIP_FILE" <<'EOF'
    # kailah-gzip: managed by deploy/vps-redeploy.sh
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types text/css application/javascript application/json application/manifest+json image/svg+xml text/plain;
EOF

# Locate the server block and its webroot on the box.
SITE=$(remote 'grep -l "wallet.photoprompting.org" /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null | head -1')
[ -n "$SITE" ] || { echo "no nginx site file mentions wallet.photoprompting.org" >&2; exit 1; }
ROOT=$(remote "grep -E '^[[:space:]]*root ' '$SITE' | head -1 | awk '{print \$2}' | tr -d ';'")
[ -n "$ROOT" ] || { echo "could not find a root directive in $SITE" >&2; exit 1; }
echo "site file: $SITE"
echo "webroot:   $ROOT"

# 1. Files: stream dist/ into a staging dir, then swap it into place.
STAGE="$ROOT.new"
PREV="$ROOT.prev"
tar -C dist -cf - . | remote "rm -rf '$STAGE' && mkdir -p '$STAGE' && tar -C '$STAGE' -xf - 2>/dev/null \
  && chmod -R a+rX '$STAGE' && rm -rf '$PREV' && mv '$ROOT' '$PREV' && mv '$STAGE' '$ROOT'"

# 2. Headers + gzip: drop every managed add_header and gzip directive, print
#    the regenerated headers and gzip block right after the `root` directive,
#    and the headers again at the top of every location block. A location
#    with any add_header of its own (Cache-Control on /assets/ and /sw.js)
#    inherits NONE of the server-level ones, which once left the service
#    worker and the Argon2 worker without a CSP on this origin. A location
#    whose `{` is not on its own line stops the run before anything is
#    written. HTML responses also get "Cache-Control: no-cache"
#    (deploy/nginx-site.awk), so a browser never reuses a page whose chunks
#    a redeploy removed. sites-enabled/<name> is usually a symlink into
#    sites-available: back up and rewrite the REAL file so the backup never lands in an
#    include dir (nginx would load it as a duplicate server block).
#    Syntax-check, then reload.
scp "${SSH_OPTS[@]}" "$HEADERS_FILE" "$WALLET_VPS:/tmp/wallet-headers.conf"
scp "${SSH_OPTS[@]}" "$GZIP_FILE" "$WALLET_VPS:/tmp/wallet-gzip.conf"
# The rewrite itself (deploy/nginx-site.awk, run offline by check-headers)
# also adds "Cache-Control: no-cache" to every HTML response.
scp "${SSH_OPTS[@]}" deploy/nginx-site.awk "$WALLET_VPS:/tmp/wallet-site.awk"
rm -f "$HEADERS_FILE" "$GZIP_FILE"
remote "
  set -e
  real=\$(readlink -f '$SITE')
  cp -p \"\$real\" \"\$real.bak-\$(date +%Y%m%d-%H%M%S)\"
  awk -v hdrsfile=/tmp/wallet-headers.conf -v gzfile=/tmp/wallet-gzip.conf -v managed='$MANAGED' \\
    -f /tmp/wallet-site.awk \"\$real\" > /tmp/wallet-site.new
  cat /tmp/wallet-site.new > \"\$real\"
  rm -f /tmp/wallet-site.new /tmp/wallet-headers.conf /tmp/wallet-gzip.conf /tmp/wallet-site.awk
  nginx -t && systemctl reload nginx
"

# 3. Verify what the world now sees.
echo "--- live ---"
curl -sSI https://wallet.photoprompting.org | grep -iE '^(HTTP|strict-transport|cross-origin-opener|content-security-policy)' | cut -c1-110
echo "served bundle: $(curl -s https://wallet.photoprompting.org | grep -o 'assets/index-[^"]*\.js')"
echo "local  bundle: $(ls dist/assets | grep '^index-.*\.js$')"
ENTRY=$(grep -o 'assets/index-[^"]*\.js' dist/index.html | head -1)
echo "entry chunk on the wire: $(curl -s -o /dev/null -H 'Accept-Encoding: gzip' \
  -w '%header{content-encoding} %{size_download} bytes' "https://wallet.photoprompting.org/$ENTRY")" \
  "(raw $(wc -c < "dist/$ENTRY" | tr -d ' ') bytes)"
# The page must be re-checked on every visit; chunks keep their own policy.
PAGE_CACHE=$(curl -sSI https://wallet.photoprompting.org/ | grep -i '^cache-control:' | tr -d '\r')
echo "page ${PAGE_CACHE:-cache-control: (none)}"
echo "$PAGE_CACHE" | grep -qi 'no-cache' || { echo "the page is missing Cache-Control: no-cache" >&2; exit 1; }
# One path per location block: every one must carry the whole managed set.
WANT=$(echo "$MANAGED" | wc -w | tr -d ' ')
for P in / /sw.js "/$ENTRY"; do
  GOT=$(curl -sSI "https://wallet.photoprompting.org$P" | grep -ciE "^($(echo $MANAGED | tr ' ' '|')):")
  echo "security headers on $P: $GOT/$WANT"
  [ "$GOT" -eq "$WANT" ] || { echo "MISSING security headers on $P" >&2; exit 1; }
done
