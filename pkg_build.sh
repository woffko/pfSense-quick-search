#!/bin/sh
# build_qs_pkg.sh
# Build pfSense pkg from local files:
#   diag_quicksearch.php
#   quicksearch_inline.js  (underscore)

set -eu

PKGNAME="pfsense-quicksearch"
PKGVER="0.4.8"

ROOT="/root/qs-pkg"
STAGE="$ROOT/stage"
META="$ROOT/meta"

# Source files live next to this script
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_PHP="$SRC_DIR/diag_quicksearch.php"
SRC_JS="$SRC_DIR/quicksearch_inline.js"   # <-- underscore

[ -f "$SRC_PHP" ] || { echo "ERROR: $SRC_PHP not found"; exit 1; }
[ -f "$SRC_JS"  ] || { echo "ERROR: $SRC_JS not found";  exit 1; }

echo "[*] Preparing $ROOT"
rm -rf "$ROOT"
mkdir -p "$STAGE/usr/local/www/js" "$META"

# Payload
install -m 0644 -o root -g wheel "$SRC_PHP" "$STAGE/usr/local/www/diag_quicksearch.php"
install -m 0644 -o root -g wheel "$SRC_JS"  "$STAGE/usr/local/www/js/quicksearch_inline.js"

# plist
cat > "$ROOT/pkg-plist" << 'EOF'
/usr/local/www/diag_quicksearch.php
/usr/local/www/js/quicksearch_inline.js
EOF

# ---- Detect current pfSense ABI and craft a tolerant arch pattern ----
# Example ABI: "FreeBSD:14:amd64:pfSense"
ABI="$(pkg config ABI 2>/dev/null || true)"
if [ -n "${ABI}" ]; then
  ABI_OS="${ABI%%:*}"          # "FreeBSD"
  ABI_TAIL="${ABI##*:}"        # "pfSense" (flavor)
  # Match any version & any arch, but keep pfSense flavor requirement:
  # Result: "FreeBSD:*:*:pfSense"
  ARCH_PATTERN="${ABI_OS}:*:*:${ABI_TAIL}"
else
  # Fallback: very permissive; pkg will still check dependencies.
  ARCH_PATTERN="FreeBSD:*"
fi

echo "[*] Using arch pattern: ${ARCH_PATTERN}"

# manifest
cat > "$META/+MANIFEST" << EOF
name: ${PKGNAME}
version: ${PKGVER}
origin: local/${PKGNAME}
comment: QuickSearch   full-text GUI search for pfSense (RAM-only index)
www: https://github.com/woffko/pfSense-quick-search
maintainer: w0wkin@gmail.com
arch: ${ARCH_PATTERN}
prefix: /
desc: |
  Installs diag_quicksearch.php and quicksearch_inline.js, and injects a script tag into head.inc.
  Files are bundled from the same directory as this build script.
EOF

# post-install: inject <script src="/js/quicksearch_inline.js?v=mtime">
cat > "$META/+POST_INSTALL" << 'EOF'
#!/bin/sh
set -e
HEAD="/usr/local/www/head.inc"
BAK="/usr/local/www/head.inc.qs.bak"
MARK="<!-- QS-HOOK -->"
JSF="/usr/local/www/js/quicksearch_inline.js"  # underscore

# backup once
if [ -f "$HEAD" ] && [ ! -f "$BAK" ]; then
  cp -p "$HEAD" "$BAK" || true
fi

# already hooked?
if grep -q "QS-HOOK" "$HEAD" 2>/dev/null; then
  exit 0
fi

# cache-busting value
if [ -f "$JSF" ]; then
  if stat -f '%m' "$JSF" >/dev/null 2>&1; then
    TS="$(stat -f '%m' "$JSF")"
  else
    TS="$(date +%s)"
  fi
else
  TS="$(date +%s)"
fi

TMP="${HEAD}.qs.new"
awk -v hook="${MARK}<script src=\"/js/quicksearch_inline.js?v=${TS}\"></script>" '
  BEGIN{done=0}
  /<\/head>/{ if(!done){ print hook; done=1 } }
  { print }
' "$HEAD" > "$TMP" && mv "$TMP" "$HEAD" || true
exit 0
EOF
chmod +x "$META/+POST_INSTALL"

# post-deinstall: remove hook (or restore backup)
cat > "$META/+POST_DEINSTALL" << 'EOF'
#!/bin/sh
set -e
HEAD="/usr/local/www/head.inc"
BAK="/usr/local/www/head.inc.qs.bak"

if [ -f "$HEAD" ]; then
  if [ -f "$BAK" ]; then
    cp -p "$BAK" "$HEAD" || true
  else
    awk '!/QS-HOOK/ && !/quicksearch_inline\.js/' "$HEAD" > "${HEAD}.qs.strip" && mv "${HEAD}.qs.strip" "$HEAD" || true
  fi
fi
exit 0
EOF
chmod +x "$META/+POST_DEINSTALL"

echo "[*] Building package "
cd "$ROOT"
pkg create -r ./stage -m ./meta -p ./pkg-plist -o .

echo "[+] Done: $(ls -1t ${PKGNAME}-${PKGVER}.pkg | head -n1)"
echo "Install:  pkg add $ROOT/${PKGNAME}-${PKGVER}.pkg"
echo "Remove:   pkg delete -y ${PKGNAME}"
