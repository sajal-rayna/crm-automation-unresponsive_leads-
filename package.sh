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

# Wrap everything in a single top-level folder so any unzip method (Windows
# "Extract All" included) yields one clean "rayna-autodialer" folder whose
# root directly contains manifest.json — the folder to pick in Load unpacked.
STAGE="dist/rayna-autodialer"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp manifest.json config.js learning.js background.js \
  content-crm.js content-whatsapp.js content-gmail.js \
  sidepanel.html sidepanel.js options.html options.js \
  README.md TEAM-SETUP.md "$STAGE"/
(cd dist && zip -qr "$(basename "$ZIP")" rayna-autodialer)
rm -rf "$STAGE"

echo "Built $ZIP"
echo "Teammates: extract, then Load unpacked -> select the 'rayna-autodialer' folder"
echo "(the one that directly contains manifest.json)."
