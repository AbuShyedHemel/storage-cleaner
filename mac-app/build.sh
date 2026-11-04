#!/bin/zsh
# Builds "Storage Cleaner.app" (a menu bar app) next to server.mjs.
#   ./mac-app/build.sh            build only
#   ./mac-app/build.sh --install  build and copy to /Applications
set -e
ROOT="${0:A:h:h}"
cd "${0:A:h}"
APP="$ROOT/Storage Cleaner.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/StorageCleaner" main.swift -framework Cocoa -framework WebKit
cp Info.plist "$APP/Contents/Info.plist"
cp "$ROOT/server.mjs" "$ROOT/dev.mjs" "$ROOT/index.html" "$APP/Contents/Resources/"
codesign --force --sign - "$APP" >/dev/null
echo "Built: $APP"
if [[ "$1" == "--install" ]]; then
  osascript -e 'quit app "Storage Cleaner"' 2>/dev/null || true
  rm -rf "/Applications/Storage Cleaner.app"
  cp -R "$APP" /Applications/
  echo "Installed: /Applications/Storage Cleaner.app"
fi
