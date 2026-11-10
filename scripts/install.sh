#!/bin/sh
# Roost CLI installer (portable, requires Node >= 22.18).
#
#   curl -fsSL https://www.roostbots.com/downloads/cli/v0.1.0/install.sh | sh
#
# Override:
#   ROOST_CLI_VERSION, ROOST_CLI_BASE_URL, ROOST_INSTALL_DIR, ROOST_BIN_DIR
set -eu

VERSION="${ROOST_CLI_VERSION:-__VERSION__}"
BASE_URL="${ROOST_CLI_BASE_URL:-https://www.roostbots.com/downloads/cli/v${VERSION}}"
INSTALL_DIR="${ROOST_INSTALL_DIR:-$HOME/.roost/bin}"
BIN_DIR="${ROOST_BIN_DIR:-$HOME/.local/bin}"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/roost-install.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM

fail() { echo "roost installer: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "missing $1"; }

need node
need curl
need shasum

NODE_VERSION="$(node -p 'process.versions.node')"
MAJOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f1)"
MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
if [ "$MAJOR" -lt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -lt 18 ]; }; then
  fail "Node >= 22.18 is required (found $NODE_VERSION)"
fi

echo "roost installer: downloading v${VERSION}"
curl -fsSL "${BASE_URL}/roost.mjs" -o "${TMP_DIR}/roost.mjs"
curl -fsSL "${BASE_URL}/checksums.txt" -o "${TMP_DIR}/checksums.txt"
grep '  roost.mjs$' "${TMP_DIR}/checksums.txt" > "${TMP_DIR}/roost.checksum"
( cd "$TMP_DIR" && shasum -a 256 -c roost.checksum >/dev/null ) || fail "checksum mismatch"
mkdir -p "$INSTALL_DIR" "$BIN_DIR"
cp "${TMP_DIR}/roost.mjs" "${INSTALL_DIR}/roost.mjs"
chmod 0755 "${INSTALL_DIR}/roost.mjs"
cat > "${BIN_DIR}/roost" <<WRAPPER
#!/bin/sh
exec "$(command -v node)" "$INSTALL_DIR/roost.mjs" "\$@"
WRAPPER
chmod 0755 "${BIN_DIR}/roost"
echo "roost installer: installed ${INSTALL_DIR}/roost.mjs"
echo "roost installer: wrapper ${BIN_DIR}/roost"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "roost installer: run 'roost setup'" ;;
  *) echo "roost installer: add $BIN_DIR to PATH, then run 'roost setup'" ;;
esac
