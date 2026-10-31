# Rewrites the mirror's nginx site file (deploy/vps-redeploy.sh runs it on
# the box). Kept in its own file so check-headers can run it offline.
#
#   -v hdrsfile=…  a file of the managed add_header lines, from public/_headers
#   -v gzfile=…    a file of the managed gzip block
#   -v managed=…   the managed header names: any add_header of these is dropped
#                  and re-printed, so a header removed from _headers goes too
#   -v var=…       the HTML cache map variable (default kailah_html_cache, the
#                  wallet's); the marketing site's file uses its own name, since
#                  two site files in the same nginx must not define one variable
#   -v nolog=1     keep no access log (the marketing site's file): every
#                  access_log line goes and "access_log off;" follows each
#                  server_name, so it also reaches the redirect block certbot
#                  added, which would otherwise inherit the http-level log. The
#                  wallet's deploy doesn't pass it: PRIVACY.md discloses its log.
# (Files, not -v values: not every awk takes a newline in a -v value.)
#
# 1. Drops every managed add_header, every gzip directive, and every line
#    marked kailah-html-cache.
# 2. Prints the HTML cache map first (http context: a site file is included
#    inside http {}). Every text/html response gets "Cache-Control: no-cache",
#    so a browser re-checks the page after a redeploy instead of reusing one
#    whose hashed chunks are gone (review 2026-10-29; Netlify already sends
#    max-age=0, must-revalidate). Other types get an empty value, which nginx
#    doesn't send, so /assets/ and /sw.js keep their own Cache-Control.
# 3. Prints the headers, the cache line and the gzip block after `root`, and
#    the headers and the cache line again at the top of every location block:
#    a location with any add_header of its own inherits none from the server.
#    A location whose `{` isn't on its own line stops the run (exit 3).
BEGIN {
  while ((getline line < hdrsfile) > 0) hdrs = hdrs (hdrs == "" ? "" : "\n") line
  while ((getline line < gzfile) > 0) gz = gz (gz == "" ? "" : "\n") line
  # an empty read would drop every security header from the site
  if (hdrs == "" || gz == "") { print "no headers or gzip block read from " hdrsfile ", " gzfile > "/dev/stderr"; exit 4 }
  n = split(managed, arr, " "); for (i = 1; i <= n; i++) if (arr[i] != "") m[arr[i]] = 1
  if (var == "") var = "kailah_html_cache"
  cache = "    add_header Cache-Control $" var " always; # kailah-html-cache"
  loc = "    " hdrs "\n" cache; gsub(/\n/, "\n    ", loc)
  print "map $sent_http_content_type $" var " { ~^text/html \"no-cache\"; default \"\"; } # kailah-html-cache"
}
{
  drop = 0
  if ($0 ~ /^[[:space:]]*add_header[[:space:]]/) {
    name = $0; sub(/^[[:space:]]*add_header[[:space:]]+/, "", name); sub(/[[:space:]].*/, "", name)
    if (name in m) drop = 1
  }
  if ($0 ~ /^[[:space:]]*gzip(_[a-z_]+)?[[:space:]]/ || $0 ~ /kailah-gzip/) drop = 1
  if ($0 ~ /kailah-html-cache/) drop = 1
  if (nolog != "" && $0 ~ /^[[:space:]]*access_log[[:space:]]/) drop = 1
  if (!drop) print
  if (nolog != "" && $0 ~ /^[[:space:]]*server_name[[:space:]]/) print "    access_log off;"
  if (!done && $0 ~ /^[[:space:]]*root[[:space:]]/) { print hdrs; print cache; print gz; done = 1 }
  if ($0 ~ /^[[:space:]]*location[[:space:]]/) {
    if ($0 !~ /\{[[:space:]]*(#.*)?$/) { print "location without { on its line: " $0 > "/dev/stderr"; exit 3 }
    print loc
  }
}
