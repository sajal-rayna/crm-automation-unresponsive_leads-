#!/usr/bin/env bash
# Build a shareable ZIP of the extension for team distribution.
# Usage: ./package.sh   ->  dist/rayna-autodialer-v<version>.zip
set -euo pipefail
cd "$(dirname "$0")"

VERSION=$(node -e "console.log(require('./manifest.json').version)" 2>/dev/null ||
  grep -o '"version"[^,]*' manifest.json | grep -o '[0-9][0-9.]*')

mkdir -p dist
ZIP="dist/rayna-autodialer-v${VERSION}.zip"
rm -f "$ZIP"

zip -q "$ZIP" \
  manifest.json \
  config.js \
  learning.js \
  background.js \
  content-crm.js \
  content-whatsapp.js \
  content-gmail.js \
  sidepanel.html \
  sidepanel.js \
  options.html \
  options.js \
  README.md \
  TEAM-SETUP.md

echo "Built $ZIP"
echo "Share it with the team along with TEAM-SETUP.md (also inside the zip)."
