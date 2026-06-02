#!/usr/bin/env bash
# Pakalon CLI installer (Linux / macOS / WSL).
# Installs `pakalon` + `omp` (oh-my-pakalon) into a user-writable prefix
# and installs shell completions for zsh, bash, and fish.
#
# Usage:
#   curl -fsSL https://pakalon.com/install.sh | bash
#   ./install.sh                       # installs from current source tree
#   ./install.sh --prefix ~/.local     # custom install prefix
#   ./install.sh --no-completions      # skip shell completions
#   ./install.sh --from-source         # build from local source (bun build)
#   ./install.sh --version 1.2.3       # install a specific version from npm
#   ./install.sh --dry-run             # print actions without executing
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
PACKAGE_NAME="pakalon"
OMP_NAME="omp"
DEFAULT_PREFIX="${HOME}/.local"
DEFAULT_NPM_REGISTRY="https://registry.npmjs.org"
GITHUB_REPO="pakalon/pakalon"
COMPLETIONS_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-./install.sh}")/.." && pwd)/completions"
DRY_RUN=0
INSTALL_COMPLETIONS=1
FROM_SOURCE=0
VERSION=""
PREFIX="${PAKALON_INSTALL_PREFIX:-$DEFAULT_PREFIX}"
NPM_REGISTRY="${NPM_REGISTRY:-$DEFAULT_NPM_REGISTRY}"
USE_SUDO=""

# ─────────────────────────────────────────────────────────────────────────────
# Pretty output
# ─────────────────────────────────────────────────────────────────────────────
RED=$'\033[31m'
GRN=$'\033[32m'
YEL=$'\033[33m'
BLU=$'\033[34m'
DIM=$'\033[2m'
RST=$'\033[0m'

info()  { printf "%b\n" "  ${BLU}*${RST} $*"; }
ok()    { printf "%b\n" "  ${GRN}✓${RST} $*"; }
warn()  { printf "%b\n" "  ${YEL}!${RST} $*"; }
err()   { printf "%b\n" "  ${RED}✗${RST} $*" >&2; }

# ─────────────────────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────────────────────
usage() {
  cat <<EOF
pakalon installer

USAGE:
  $0 [OPTIONS]

OPTIONS:
  --prefix DIR            Install prefix (default: $DEFAULT_PREFIX)
  --version V             Install a specific version (default: latest)
  --from-source           Build from the local source tree (bun build)
  --no-completions        Skip installing shell completions
  --registry URL          npm registry to use (default: $DEFAULT_NPM_REGISTRY)
  --sudo                  Use sudo when writing into the prefix
  --dry-run               Print actions without making changes
  -h, --help              Show this help

ENVIRONMENT:
  PAKALON_INSTALL_PREFIX   Override default install prefix
  NPM_REGISTRY             Override default npm registry
  PAKALON_NO_COMPLETIONS=1 Skip completions
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)        PREFIX="$2"; shift 2 ;;
    --version)       VERSION="$2"; shift 2 ;;
    --from-source)   FROM_SOURCE=1; shift ;;
    --no-completions) INSTALL_COMPLETIONS=0; shift ;;
    --registry)      NPM_REGISTRY="$2"; shift 2 ;;
    --sudo)          USE_SUDO="sudo"; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *) err "Unknown option: $1"; usage; exit 2 ;;
  esac
done

if [[ "${PAKALON_NO_COMPLETIONS:-0}" = "1" ]]; then
  INSTALL_COMPLETIONS=0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf "%b\n" "    ${DIM}\$ $*${RST}"
  else
    "$@"
  fi
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

# Detect platform/arch for the npm package suffix
detect_target() {
  local os arch
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux)  os="linux" ;;
    Darwin) os="darwin" ;;
    MINGW*|MSYS*|CYGWIN*)
      err "Detected Windows shell. Use install.ps1 instead."
      exit 1
      ;;
    *)
      err "Unsupported OS: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m 2>/dev/null || echo unknown)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      err "Unsupported architecture: $(uname -m)"; exit 1 ;;
  esac
  printf "%s-%s\n" "$os" "$arch"
}

# ─────────────────────────────────────────────────────────────────────────────
# Header
# ─────────────────────────────────────────────────────────────────────────────
printf "%b\n" "${GRN}Pakalon CLI installer${RST}"
printf "%b\n" "${DIM}  prefix:      $PREFIX${RST}"
printf "%b\n" "${DIM}  registry:    $NPM_REGISTRY${RST}"
printf "%b\n" "${DIM}  completions: $([[ $INSTALL_COMPLETIONS -eq 1 ]] && echo yes || echo no)${RST}"
printf "%b\n" "${DIM}  source:      $([[ $FROM_SOURCE -eq 1 ]] && echo 'local build' || echo 'npm')${RST}"
echo

# Ensure prefix is writable
if [[ ! -d "$PREFIX" ]]; then
  info "Creating install prefix: $PREFIX"
  if [[ -n "$USE_SUDO" ]]; then run $USE_SUDO mkdir -p "$PREFIX"
  else run mkdir -p "$PREFIX"; fi
fi
if [[ ! -w "$PREFIX" && -z "$USE_SUDO" ]]; then
  warn "Prefix $PREFIX is not writable by $USER. Re-run with --sudo."
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Install
# ─────────────────────────────────────────────────────────────────────────────
TARGET="$(detect_target)"
info "Detected target: $TARGET"

if [[ $FROM_SOURCE -eq 1 ]]; then
  if ! have_cmd bun; then
    err "bun is required for --from-source. Install: https://bun.sh"
    exit 1
  fi
  info "Building from source…"
  run cd "$(cd "$(dirname "${BASH_SOURCE[0]:-./install.sh}")/.." && pwd)"
  run bun install --frozen-lockfile
  run bun run build
  BIN_DIR="$PREFIX/bin"
  run mkdir -p "$BIN_DIR"
  info "Installing to $BIN_DIR"
  run install -m 0755 dist/pakalon "$BIN_DIR/pakalon"
  [[ -f dist/omp ]] && run install -m 0755 dist/omp "$BIN_DIR/omp" || true
else
  # Prefer pnpm → npm → bun
  if have_cmd pnpm; then
    info "Installing via pnpm…"
    PKG="${VERSION:+@$VERSION}"
    run pnpm add -g "${NPM_REGISTRY%/}/${PACKAGE_NAME}${PKG}"
  elif have_cmd npm; then
    info "Installing via npm…"
    PKG="${VERSION:+@$VERSION}"
    run npm install -g --registry "$NPM_REGISTRY" "${PACKAGE_NAME}${PKG}"
  elif have_cmd bun; then
    info "Installing via bun…"
    PKG="${VERSION:+@$VERSION}"
    run bun add -g "${PACKAGE_NAME}${PKG}"
  else
    err "Need npm, pnpm, or bun on PATH."
    exit 1
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Completions
# ─────────────────────────────────────────────────────────────────────────────
install_completions() {
  if [[ $INSTALL_COMPLETIONS -eq 0 ]]; then return 0; fi
  if [[ ! -d "$COMPLETIONS_SRC_DIR" ]]; then
    warn "Completions source dir not found: $COMPLETIONS_SRC_DIR"
    return 0
  fi

  # zsh
  if [[ -n "${ZSH_VERSION:-}" ]] || have_cmd zsh; then
    ZSH_COMP_DIR="${ZDOTDIR:-$HOME/.zsh}/completions"
    info "Installing zsh completions to $ZSH_COMP_DIR"
    run mkdir -p "$ZSH_COMP_DIR"
    run cp -f "$COMPLETIONS_SRC_DIR/pakalon.zsh" "$ZSH_COMP_DIR/_pakalon"
    ok "zsh completions installed"
  fi

  # bash
  if [[ -n "${BASH_VERSION:-}" ]] || have_cmd bash; then
    BASH_COMP_DIR="$HOME/.local/share/bash-completion/completions"
    info "Installing bash completions to $BASH_COMP_DIR"
    run mkdir -p "$BASH_COMP_DIR"
    run cp -f "$COMPLETIONS_SRC_DIR/pakalon.bash" "$BASH_COMP_DIR/pakalon"
    ok "bash completions installed"
  fi

  # fish
  if have_cmd fish; then
    FISH_COMP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/fish/completions"
    info "Installing fish completions to $FISH_COMP_DIR"
    run mkdir -p "$FISH_COMP_DIR"
    run cp -f "$COMPLETIONS_SRC_DIR/pakalon.fish" "$FISH_COMP_DIR/pakalon.fish"
    ok "fish completions installed"
  fi
}

install_completions

# ─────────────────────────────────────────────────────────────────────────────
# PATH nudge
# ─────────────────────────────────────────────────────────────────────────────
case ":$PATH:" in
  *":$PREFIX/bin:"*) ok "PATH already contains $PREFIX/bin" ;;
  *)
    warn "$PREFIX/bin is not in your PATH. Add to your shell profile:"
    printf "%b\n" "    ${DIM}export PATH=\"$PREFIX/bin:\$PATH\"${RST}"
    ;;
esac

ok "Done. Try: pakalon --version"
