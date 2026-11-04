# Storage Cleaner

A macOS menu bar app for freeing disk space and keeping an eye on local development.

- **Storage**: find and clear caches, build folders (`node_modules`, `.next`, `target`…), large files and Library data. Every delete asks first and is logged.
- **Developer**: listening ports (stop or open them), start/stop project dev servers with live logs, and Git status across your repos.

It's a small Node server (`server.mjs`, `dev.mjs`) with a single-page UI (`index.html`), wrapped in a native Swift menu bar app (`mac-app/`) that shows the UI in a glass popover.

## Requirements

- macOS 13 or later
- Node.js (Homebrew, nvm, Volta) or Bun
- Xcode Command Line Tools (`swiftc`) to build

## Build and install

```bash
./mac-app/build.sh            # builds "Storage Cleaner.app" in this folder
./mac-app/build.sh --install  # also copies it to /Applications
```

Run it and look for the drive icon with your free space in the menu bar. Right-click it for Open in Window, Open in Browser, Reload, Show Action Log and Quit.

## Run in a browser instead

```bash
node server.mjs
```

Or double-click `Storage Cleaner.command`.

Logs are written to `~/Library/Logs/Storage Cleaner/` when run from the app.
