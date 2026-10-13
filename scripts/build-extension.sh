#!/usr/bin/env bash
# Build a clean Chrome extension zip ready for CWS upload.
# Usage: bash scripts/build-extension.sh
#
# Layout: the zip mirrors the repo — manifest.json at root,
# runtime code in src/, images in assets/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_ENV="${LIMOVA_BUILD_ENV:-production}"
case "$BUILD_ENV" in
  production) BUILD_DIR="$ROOT_DIR/build"; ZIP_SUFFIX="" ;;
  staging) BUILD_DIR="$ROOT_DIR/build-staging"; ZIP_SUFFIX="-staging" ;;
  *) echo "ERROR: LIMOVA_BUILD_ENV must be production or staging" >&2; exit 1 ;;
esac
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -p "JSON.parse(require('fs').readFileSync('$ROOT_DIR/manifest.json','utf8')).version")"
ZIP_NAME="limova-ai-extension-${VERSION}${ZIP_SUFFIX}.zip"
ZIP_PATH="$DIST_DIR/$ZIP_NAME"

echo "==> Cleaning previous build..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
mkdir -p "$DIST_DIR"

# Files copied verbatim from the repo root
ROOT_FILES=(
  manifest.json
  LICENSE
)

# Directories shipped inside the zip (preserving structure)
DIRS=(
  src
  assets
)

echo "==> Copying root files..."
for f in "${ROOT_FILES[@]}"; do
  if [ -f "$ROOT_DIR/$f" ]; then
    cp "$ROOT_DIR/$f" "$BUILD_DIR/"
  else
    echo "  WARNING: $f not found, skipping"
  fi
done

echo "==> Copying directories..."
for d in "${DIRS[@]}"; do
  if [ -d "$ROOT_DIR/$d" ]; then
    rsync -a \
      --exclude='node_modules' \
      --exclude='*.entry.js' \
      --exclude='*.code-workspace' \
      --exclude='.DS_Store' \
      "$ROOT_DIR/$d" "$BUILD_DIR/"
  else
    echo "  WARNING: $d/ not found, skipping"
  fi
done

echo "==> Configuring $BUILD_ENV and bundling the app-session bridge..."
node "$ROOT_DIR/scripts/configure-extension.mjs" "$BUILD_DIR" "$BUILD_ENV"
cp "$ROOT_DIR/src/limova/app-session-bridge.entry.js" "$BUILD_DIR/src/limova/app-session-bridge.entry.js"
"$ROOT_DIR/node_modules/.bin/esbuild" \
  "$BUILD_DIR/src/limova/app-session-bridge.entry.js" \
  --bundle --format=iife --platform=browser --target=chrome114 \
  --outfile="$BUILD_DIR/src/limova/app-session-bridge.js" --log-level=warning
rm "$BUILD_DIR/src/limova/app-session-bridge.entry.js"

echo "==> Bundling the private training-video uploader..."
"$ROOT_DIR/node_modules/.bin/esbuild" \
  "$ROOT_DIR/src/sidebar/training-recording-upload.entry.js" \
  --bundle \
  --format=iife \
  --platform=browser \
  --target=chrome114 \
  --outfile="$BUILD_DIR/src/sidebar/training-recording-upload.js" \
  --log-level=warning

echo "==> Validating packaged resources..."
node "$ROOT_DIR/scripts/validate-package.mjs" "$BUILD_DIR"

echo "==> Creating zip..."
cd "$BUILD_DIR"
rm -f "$ZIP_PATH" "$ZIP_PATH.sha256"
zip -r "$ZIP_PATH" . -x '*.DS_Store' '*__MACOSX*'

echo "==> Testing zip integrity and root layout..."
unzip -tq "$ZIP_PATH"
if ! unzip -Z1 "$ZIP_PATH" | grep -x 'manifest.json' >/dev/null; then
  echo "ERROR: manifest.json is not at the root of the zip"
  exit 1
fi
if ! unzip -Z1 "$ZIP_PATH" | grep -x 'src/sidebar/sidebar.html' >/dev/null; then
  echo "ERROR: side panel file is missing from the zip"
  exit 1
fi

cd "$DIST_DIR"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$ZIP_NAME" > "$ZIP_NAME.sha256"
else
  sha256sum "$ZIP_NAME" > "$ZIP_NAME.sha256"
fi

echo "==> Build complete: dist/$ZIP_NAME ($(du -h "$ZIP_PATH" | cut -f1))"
echo "    Checksum: dist/$ZIP_NAME.sha256"
echo "    Load unpacked from: $BUILD_DIR"
echo "    Upload zip to: https://chrome.google.com/webstore/devconsole"
