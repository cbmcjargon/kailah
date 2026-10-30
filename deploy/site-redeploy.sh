#!/usr/bin/env bash
# Mirror the marketing site (site/) to the nginx box that serves the wallet's
# second origin, as its OWN server block and webroot: the wallet's site file,
# headers and CSP are never touched. Netlify stays the site's primary host.
#
# Usage:  SITE_HOST=<hostname> WALLET_VPS=user@host deploy/site-redeploy.sh [--install]
#   SITE_HOST  the name the site answers on; its DNS A record must point at
#              the box (DNS only, not proxied), as the wallet's does.
#   --install  the first time only: writes the server block from
#              deploy/nginx-site-marketing.conf, enables it, creates the
#              webroot and asks certbot for a certificate (HTTP-01, so the
#              DNS check above is enforced first). Later runs need no flag.
#
# Every run then:
#   1. ships site/ (without _headers and README.md) into a staging dir and
#      swaps it in; the previous copy stays at <webroot>.prev for a rollback;
#   2. regenerates every security header from site/_headers in the server
#      block and in every location block, through deploy/nginx-site.awk (the
#      wallet's deploy does the same from public/_headers), plus
#      "Cache-Control: no-cache" on HTML and the gzip block, under the site's
#      own map variable so the two site files never define the same one;
#   3. checks the live result: every managed header on the page, the
#      stylesheet and an image; the page re-checked on every visit; a 404 for
#      an unknown path and for /_headers; index.html byte-identical to site/;
#      the webroot holding exactly the files of site/ and nothing else.
# Auth: your ssh-agent, as for deploy/vps-redeploy.sh. Nothing credential-
# related lives in this file.
set -euo pipefail

: "${WALLET_VPS:?set WALLET_VPS=user@host for the nginx box}"
: "${SITE_HOST:?set SITE_HOST=<hostname> for the marketing site (its DNS must point at the box)}"
INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1
case "$SITE_HOST" in
  '' | *[!A-Za-z0-9.-]* | .* | *.) echo "SITE_HOST must be a bare hostname, got '$SITE_HOST'" >&2; exit 1 ;;
esac
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15)
remote() { ssh "${SSH_OPTS[@]}" "$WALLET_VPS" "$@"; }

cd "$(dirname "$0")/.."
[ -f site/index.html ] || { echo "site/index.html is missing" >&2; exit 1; }
WEBROOT=${SITE_WEBROOT:-/srv/kailah-site}   # used by --install only; later runs read it from the site file
SITE_FILE=/etc/nginx/sites-available/kailah-site
VAR=kailah_site_html_cache   # the HTML cache map variable; the wallet's file owns kailah_html_cache

# Security headers → nginx add_header lines, straight from site/_headers
# (the same converter as deploy/vps-redeploy.sh; check-headers runs both).
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
' site/_headers > "$HEADERS_FILE"
MANAGED=$(sed -E 's/^[[:space:]]*add_header ([A-Za-z-]+) .*/\1/' "$HEADERS_FILE" | tr '\n' ' ')
[ -s "$HEADERS_FILE" ] || { echo "could not read security headers from site/_headers" >&2; exit 1; }
echo "managing headers: $MANAGED"

GZIP_FILE=$(mktemp)
cat > "$GZIP_FILE" <<'EOF'
    # kailah-gzip: managed by deploy/site-redeploy.sh
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_types text/css application/javascript application/json image/svg+xml text/plain;
EOF

# The server block: found, or installed once.
find_site() {
  remote "grep -lE '^[[:space:]]*server_name[[:space:]]+$SITE_HOST;' /etc/nginx/sites-enabled/* /etc/nginx/conf.d/* 2>/dev/null | head -1" || true
}
SITE=$(find_site)
if [ -z "$SITE" ]; then
  if [ "$INSTALL" != 1 ]; then
    echo "no nginx site on the box answers $SITE_HOST yet; once its DNS record points at the box, run again with --install" >&2
    exit 1
  fi
  BOX=${WALLET_VPS#*@}
  BOX_IP=$(dig +short "$BOX" A 2>/dev/null | tail -1)
  [ -n "$BOX_IP" ] || BOX_IP=$BOX
  HOST_IP=$(dig +short "$SITE_HOST" A 2>/dev/null | tail -1)
  if [ "$HOST_IP" != "$BOX_IP" ]; then
    echo "$SITE_HOST resolves to '${HOST_IP:-nothing}', not to the box ($BOX_IP): add its A record first (DNS only, not proxied), then retry" >&2
    exit 1
  fi
  echo "installing the server block for $SITE_HOST ($SITE_FILE, webroot $WEBROOT)"
  sed -e "s#@SITE_HOST@#$SITE_HOST#g" -e "s#@ROOT@#$WEBROOT#g" deploy/nginx-site-marketing.conf |
    remote "set -e
      [ ! -e '$SITE_FILE' ] || { echo '$SITE_FILE already exists; refusing to overwrite it' >&2; exit 1; }
      cat > '$SITE_FILE'
      mkdir -p '$WEBROOT'
      ln -sfn '$SITE_FILE' /etc/nginx/sites-enabled/kailah-site
      nginx -t && systemctl reload nginx"
  # The certificate: certbot's nginx plugin adds the TLS listen lines and the
  # http→https redirect to the block it just found, as it did for the wallet.
  remote "certbot --nginx -d '$SITE_HOST' --redirect --non-interactive"
  SITE=$(find_site)
  [ -n "$SITE" ] || { echo "the server block for $SITE_HOST is not enabled after the install" >&2; exit 1; }
fi
ROOT=$(remote "grep -E '^[[:space:]]*root ' '$SITE' | head -1 | awk '{print \$2}' | tr -d ';'")
[ -n "$ROOT" ] || { echo "could not find a root directive in $SITE" >&2; exit 1; }
echo "site file: $SITE"
echo "webroot:   $ROOT"

# 1. Files: stream site/ into a staging dir, then swap it into place. The
#    Netlify headers file and the README are not part of the site.
#    COPYFILE_DISABLE: macOS tar otherwise adds a ._name entry for every file
#    with an extended attribute (com.apple.provenance is on all of them), and
#    nginx would serve those as ordinary files. --no-same-owner: the box's root
#    owns the webroot, not whichever uid made the archive on this Mac.
STAGE="$ROOT.new"
PREV="$ROOT.prev"
COPYFILE_DISABLE=1 tar -C site --exclude='./_headers' --exclude='./README.md' --exclude='.DS_Store' -cf - . | remote "rm -rf '$STAGE' && mkdir -p '$STAGE' && tar --no-same-owner -C '$STAGE' -xf - 2>/dev/null \
  && chmod -R a+rX '$STAGE' && rm -rf '$PREV' && { [ ! -e '$ROOT' ] || mv '$ROOT' '$PREV'; } && mv '$STAGE' '$ROOT'"

# 2. Headers + HTML no-cache + gzip, rewritten the way the wallet's are
#    (see deploy/vps-redeploy.sh): back up the real file, rewrite, syntax-check,
#    reload. The map variable is the site's own.
scp "${SSH_OPTS[@]}" "$HEADERS_FILE" "$WALLET_VPS:/tmp/kailah-site-headers.conf"
scp "${SSH_OPTS[@]}" "$GZIP_FILE" "$WALLET_VPS:/tmp/kailah-site-gzip.conf"
scp "${SSH_OPTS[@]}" deploy/nginx-site.awk "$WALLET_VPS:/tmp/kailah-site.awk"
rm -f "$HEADERS_FILE" "$GZIP_FILE"
remote "
  set -e
  real=\$(readlink -f '$SITE')
  cp -p \"\$real\" \"\$real.bak-\$(date +%Y%m%d-%H%M%S)\"
  awk -v hdrsfile=/tmp/kailah-site-headers.conf -v gzfile=/tmp/kailah-site-gzip.conf -v managed='$MANAGED' -v var=$VAR \\
    -f /tmp/kailah-site.awk \"\$real\" > /tmp/kailah-site.new
  cat /tmp/kailah-site.new > \"\$real\"
  rm -f /tmp/kailah-site.new /tmp/kailah-site-headers.conf /tmp/kailah-site-gzip.conf /tmp/kailah-site.awk
  nginx -t && systemctl reload nginx
"

# 3. Verify what the world now sees.
U="https://$SITE_HOST"
echo "--- live: $U ---"
curl -sSI "$U/" | grep -iE '^(HTTP|strict-transport|content-security-policy|cache-control)' | cut -c1-110
WANT=$(echo "$MANAGED" | wc -w | tr -d ' ')
for P in / /styles.css /img/og.jpg; do
  GOT=$(curl -sSI "$U$P" | grep -ciE "^($(echo $MANAGED | tr ' ' '|')):")
  echo "security headers on $P: $GOT/$WANT"
  [ "$GOT" -eq "$WANT" ] || { echo "MISSING security headers on $P" >&2; exit 1; }
done
curl -sSI "$U/" | grep -i '^cache-control:' | grep -qi 'no-cache' || { echo "the page is missing Cache-Control: no-cache" >&2; exit 1; }
for P in /nope /_headers /README.md /._index.html; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$U$P")
  echo "$P → $CODE"
  [ "$CODE" = 404 ] || { echo "$P should be a 404" >&2; exit 1; }
done
TYPE=$(curl -s -o /dev/null -w '%{content_type}' "$U/img/og.jpg")
[ "$TYPE" = image/jpeg ] || { echo "og.jpg served as '$TYPE', not image/jpeg" >&2; exit 1; }
if cmp -s <(curl -s "$U/index.html") site/index.html; then
  echo "index.html: byte-identical to site/"
else
  echo "index.html on $SITE_HOST differs from site/index.html" >&2
  exit 1
fi
# The webroot on disk: the same names with the same bytes, and nothing extra.
LOCAL_SHA=sha256sum
command -v sha256sum >/dev/null || LOCAL_SHA='shasum -a 256'
WANT_TREE=$(cd site && find . -type f ! -name _headers ! -name README.md ! -name .DS_Store | LC_ALL=C sort | xargs $LOCAL_SHA)
GOT_TREE=$(remote "cd '$ROOT' && find . -type f | LC_ALL=C sort | xargs sha256sum")
if [ "$WANT_TREE" = "$GOT_TREE" ]; then
  echo "webroot: $(echo "$WANT_TREE" | wc -l | tr -d ' ') files, each identical to site/, nothing extra"
else
  diff <(echo "$WANT_TREE") <(echo "$GOT_TREE") >&2 || true
  echo "the webroot on the box differs from site/" >&2
  exit 1
fi
