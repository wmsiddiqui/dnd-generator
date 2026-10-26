#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Copying character-creator.html → index.html..."
cp character-creator.html index.html

echo "Staging..."
git add index.html

if git diff --cached --quiet; then
  echo "No changes to deploy."
  exit 0
fi

MSG="${1:-Update character creator}"
git commit -m "$MSG"

echo "Pushing to GitHub..."
git push

echo ""
echo "✓ Deployed! Live at: https://wmsiddiqui.github.io/dnd-generator/"
