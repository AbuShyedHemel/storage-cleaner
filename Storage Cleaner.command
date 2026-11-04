#!/bin/zsh
# Double-click to open Storage Cleaner in your browser. Close this window to stop it.
cd "${0:A:h}"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if command -v node >/dev/null; then exec node server.mjs
elif command -v bun >/dev/null; then exec bun server.mjs
else echo "Node.js is needed: https://nodejs.org"; read; fi
