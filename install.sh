#!/bin/sh
# claude-statusline setup for macOS and Linux (WSL too). On Windows, use install.ps1.
#
# Gets a claude-statusline binary for this machine, then runs its own installer:
#   1. bun found                        -> build the binary from this checkout
#   2. no bun, gh signed in, a release  -> download the release binary for this machine
#   3. neither                          -> install bun (Homebrew on macOS, else bun's own
#                                          installer, plus unzip if it is missing), then build
# Then it checks for the claude CLI, which writes the Haiku labels, and offers to install it.
# It asks before it installs anything; --yes answers yes, and with no terminal the answer is no.
#
# Usage: ./install.sh [--yes] [--skip-claude]
set -eu

YES=0
SKIP_CLAUDE=0
for arg in "$@"; do
  case $arg in
    -y|--yes) YES=1 ;;
    --skip-claude) SKIP_CLAUDE=1 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'unknown option: %s (see --help)\n' "$arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

ask() { # <question>: true for yes
  [ "$YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  printf '%s [y/N] ' "$1"
  read -r reply
  case $reply in [yY]*) return 0 ;; *) return 1 ;; esac
}

REPO=$(cd "$(dirname "$0")" && pwd)
case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  MINGW*|MSYS*|CYGWIN*) die "on Windows, run install.ps1 in PowerShell" ;;
  *) die "unsupported system: $(uname -s)" ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported CPU: $(uname -m)" ;;
esac
BIN=$REPO/dist/claude-statusline
SUDO=
[ "$(id -u)" = 0 ] || SUDO=sudo

find_bun() {
  if command -v bun >/dev/null 2>&1; then command -v bun
  elif [ -x "$HOME/.bun/bin/bun" ]; then printf '%s\n' "$HOME/.bun/bin/bun"
  fi
}

build() { # <bun>
  say "Building claude-statusline with $1"
  (cd "$REPO" && "$1" install --frozen-lockfile && "$1" run build)
}

download_release() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 || return 1
  repo=$(cd "$REPO" && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || return 1
  gh release view --repo "$repo" >/dev/null 2>&1 || return 1
  say "Downloading the latest claude-statusline release for $os-$arch from $repo"
  mkdir -p "$REPO/dist"
  gh release download --repo "$repo" --pattern "claude-statusline-$os-$arch" --output "$BIN" --clobber
  chmod +x "$BIN"
}

install_package() { # <package>: with the package manager this machine has
  pm=
  for candidate in apt-get dnf yum pacman zypper apk; do
    if command -v "$candidate" >/dev/null 2>&1; then pm=$candidate; break; fi
  done
  case $pm in
    apt-get) cmd="$SUDO apt-get install -y $1" ;;
    dnf|yum) cmd="$SUDO $pm install -y $1" ;;
    pacman) cmd="$SUDO pacman -S --noconfirm $1" ;;
    zypper) cmd="$SUDO zypper install -y $1" ;;
    apk) cmd="$SUDO apk add $1" ;;
    *) return 1 ;;
  esac
  ask "$1 is needed to install bun. Install it ($cmd)?" || return 1
  $cmd # split on spaces on purpose: no part of it has one
}

install_bun() {
  if [ "$os" = darwin ] && command -v brew >/dev/null 2>&1; then
    ask "Bun is needed to build claude-statusline. Install it with Homebrew (brew install oven-sh/bun/bun)?" || return 1
    brew install oven-sh/bun/bun
    return
  fi
  command -v curl >/dev/null 2>&1 || die "curl is needed to install bun; install it with your package manager"
  if [ "$os" = linux ] && ! command -v unzip >/dev/null 2>&1; then
    install_package unzip || die "unzip is needed to install bun; install it with your package manager"
  fi
  ask "Bun is needed to build claude-statusline. Install it with its installer (curl -fsSL https://bun.sh/install | bash)?" || return 1
  curl -fsSL https://bun.sh/install | bash
}

# --- 1. The binary -------------------------------------------------------------------
bun=$(find_bun)
if [ -n "$bun" ]; then
  build "$bun"
elif download_release; then
  :
elif install_bun; then
  bun=$(find_bun)
  [ -n "$bun" ] || die "bun is installed but not found; open a new terminal and run this again"
  build "$bun"
else
  die "bun is needed to build claude-statusline: install it from https://bun.sh and run this again, or download a release binary and run: <binary> install"
fi

# --- 2. The claude CLI, for the Haiku labels -----------------------------------------
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  if [ "$SKIP_CLAUDE" = 1 ]; then
    warn "the claude CLI is not installed: there are no Haiku task and scope labels without it"
  elif ask "The claude CLI is not installed, and the Haiku labels need it. Install it (curl -fsSL https://claude.ai/install.sh | bash)?"; then
    curl -fsSL https://claude.ai/install.sh | bash
  else
    warn "without the claude CLI there are no Haiku task and scope labels"
  fi
fi

# --- 3. Install into Claude Code -----------------------------------------------------
exec "$BIN" install
