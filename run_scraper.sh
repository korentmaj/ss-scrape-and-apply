#!/usr/bin/env bash
# Linux/macOS launcher for the scraper. Mirrors run_scraper.ps1.
# Usage: ./run_scraper.sh [mode]
#   modes: setup | self-test | chrome | chrome-real | chrome-verbose | chrome-real-verbose
set -euo pipefail

MODE="${1:-chrome-verbose}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step() { printf '\033[36m[step]\033[0m %s\n' "$1"; }
info() { printf '[info] %s\n' "$1"; }
fail() { printf '\033[31m[ERROR]\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js is not installed. Install Node LTS from https://nodejs.org/"
command -v npm  >/dev/null 2>&1 || fail "npm is not available. Reinstall Node.js LTS."

if [ "$MODE" = "setup" ] || [ ! -d node_modules ]; then
  step "Installing npm dependencies"
  npm install --no-audit --no-fund
  step "Installing Playwright Chromium runtime"
  npx playwright install chromium
  # On a fresh Linux box you may also need the system libraries:
  #   npx playwright install-deps chromium
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    fail "Created .env from .env.example. Fill in the values and run again."
  else
    fail ".env is missing and .env.example was not found."
  fi
fi

CHROME_PROFILE_DIR="$ROOT/.chrome-automation-profile"
mkdir -p "$CHROME_PROFILE_DIR"

LOCK="$ROOT/logs/.run.lock"
if [ -f "$LOCK" ]; then
  LOCK_PID="$(grep -o '"pid"[^,}]*' "$LOCK" 2>/dev/null | grep -o '[0-9]\+' | head -n1 || true)"
  if [ -n "${LOCK_PID:-}" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    fail "Another scraper run appears active (logs/.run.lock). Close the old run first."
  fi
  info "Removing stale lock: logs/.run.lock"
  rm -f "$LOCK"
fi

ARGS=()
case "$MODE" in
  setup)               info "Setup completed."; exit 0 ;;
  self-test)           ARGS+=(--self-test --verbose) ;;
  chrome)              ARGS+=(--chrome-profile) ;;
  chrome-real)         ARGS+=(--chrome-profile --real-submit) ;;
  chrome-verbose)      ARGS+=(--chrome-profile --verbose) ;;
  chrome-real-verbose) ARGS+=(--chrome-profile --real-submit --verbose) ;;
  *)                   fail "Unsupported mode: $MODE" ;;
esac

ARGS+=(--chrome-user-data-dir "$CHROME_PROFILE_DIR" --chrome-profile-directory Default)

step "Running: node scraper.js ${ARGS[*]}"
node scraper.js "${ARGS[@]}" || fail "Scraper failed. Check error.log and logs/events.jsonl."

info "Done."
