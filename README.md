# Storage Cleaner

**A native macOS menu bar app that reclaims disk space and keeps your local development environment under control.**

Storage Cleaner lives in your menu bar, shows your free disk space at a glance, and opens a compact glass panel with two workspaces:

- **Storage**: find out where your disk space went and safely clear caches, build output, and other regenerable data.
- **Developer**: see which ports are in use, start and stop your projects' dev servers with live logs, and track Git status across every repository.

Everything runs locally on your Mac. There is no account, telemetry, or network service, and nothing is deleted without your confirmation.

![Platform](https://img.shields.io/badge/platform-macOS%2013%2B-lightgrey)
![Swift](https://img.shields.io/badge/Swift-AppKit-orange)
![Node](https://img.shields.io/badge/Node.js-18%2B-green)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

---

## Contents

- [Features](#features)
  - [Menu bar app](#menu-bar-app)
  - [Storage](#storage)
  - [Developer](#developer)
- [Safety](#safety)
- [Requirements](#requirements)
- [Installation](#installation)
- [Usage](#usage)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Project structure](#project-structure)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)

---

## Features

### Menu bar app

- **Free space in the menu bar.** A drive icon shows your available space, refreshed every minute and whenever the panel closes.
- **Glass popover panel.** A compact 440 × 640 panel with native macOS vibrancy, a system font, and automatic light and dark mode.
- **Full window mode.** Open the same interface in a resizable, translucent window when you need more room.
- **Right-click menu.** Open in Window, Open in Browser, Reload, Show Action Log, and Quit.
- **Menu bar only.** No Dock icon and no entry in the ⌘-Tab app switcher.
- **Self-contained.** The app finds Node.js automatically (Homebrew, `/usr/local`, Volta, nvm, or Bun) and starts its own private local server on a random free port.

### Storage

A disk summary at the top shows used and available space. Below it, five tabs:

| Tab | What it does |
| --- | --- |
| **Clean** | Known-safe caches grouped by category, each with its size, a risk level, and a note explaining what happens after clearing. Select several and clear them in one go. |
| **Projects** | Scans your project folders for build output and dependencies (`node_modules`, `.next`, `target`, `Pods`, and more) and shows the size per project and last-modified date. |
| **Library** | Breaks down `~/Library` by app, highlights known heavy items, and flags data that needs its app quit first. |
| **Explore** | Browse any folder in your home directory sorted by size, drill down, reveal in Finder, or move items to the Trash. |
| **Large** | Lists large files across your home folder (500 MB and up by default), skipping Library, Trash, `node_modules`, and `.git`. |

**What the Clean tab covers**

| Category | Items |
| --- | --- |
| System & apps | App caches (`~/Library/Caches`), app logs (`~/Library/Logs`), Trash |
| Package managers | Bun, npm, pnpm store, Yarn Berry, Go module cache, uv / pip (`~/.cache`), Gradle, Flutter / Dart pub |
| Editors | VS Code caches, VS Code workspace storage, Cursor caches |
| Xcode & simulators | DerivedData, iOS DeviceSupport, Simulator devices, Archives |
| Docker | Build cache, unused images, stopped containers, unused volumes (cleared through the Docker CLI) |

**Build folders detected in Projects**

| Folder | Risk | Notes |
| --- | --- | --- |
| `node_modules`, `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.parcel-cache` | Safe | Recreated by your next install or build |
| `.dart_tool`, `Pods` | Safe | Run `flutter pub get` or `pod install` again |
| `.venv`, `venv` | Caution | Python virtual environments, which must be recreated |
| `target`, `dist`, `build` | Caution | Build output; confirm it isn't committed source |

### Developer

Three summary tiles (dev ports open, servers running from the app, repositories needing attention) link straight to their tabs.

**Ports**
- Lists every TCP port in a listening state, with the process name, PID, and working directory.
- Groups ports into **your projects** (processes started from a folder in your home) and **apps & system** services.
- Matches each port to the project it belongs to, and marks ports reachable from your network.
- **Open** a local URL in your browser, or **Stop** the process, with an optional Force Quit if it doesn't exit.
- The app's own server is labelled "This app" and cannot be stopped.

**Servers**
- Finds runnable projects in your project folders, including each package in a monorepo (for example `platform › apps/web`).
- Detects `dev`, `start`, `serve`, `preview`, `storybook`, `watch`, and `develop` scripts, and the right package manager (pnpm, Bun, Yarn, or npm) from each lockfile.
- **Start / Stop** any script with one click. Each server runs in its own process group, so Stop also ends its child processes.
- Shows a **live log** (the last 400 lines) and detects the local URL as soon as the server prints it.
- Opens the project in your editor (Cursor, Visual Studio Code, or Zed, whichever is installed), your terminal (Ghostty, iTerm, Warp, or Terminal), or **Finder**.
- Every server started from the app is stopped automatically when the app quits.
- Search filters long project lists instantly.

**Git**
- Shows every repository in your project folders, with the ones needing attention listed first.
- For each repository: current branch, upstream, commits ahead and behind, staged, changed, untracked and conflicted files, stash count, and the latest commit message and date.
- Badges for "not on remote" branches and detached checkouts.
- **Fetch All** updates remote tracking info for every repository without touching your working files. It never prompts for credentials, so it can't hang.
- Opens any repository in your editor, terminal, or Finder.

---

## Safety

Storage Cleaner is built to be safe to click.

- **Risk levels.** Every item is labelled *safe*, *caution*, or *danger*, with a plain-language note on what clearing it means.
- **Confirmation first.** Every delete, Trash, Stop, and Quit action asks before running.
- **Trash, not delete.** Items in Explore and Large are moved to the Trash (through Finder when needed), so they can be restored.
- **Protected locations.** Your home folder, its standard folders (Documents, Desktop, Downloads, Pictures, Movies, Music, Applications, Public), and sensitive paths (`~/Library/Application Support`, `Containers`, `Preferences`, `Keychains`, `Mobile Documents`, `~/.ssh`, `~/.gnupg`, `~/.config`) can never be moved to the Trash.
- **App-aware clearing.** Data that belongs to a running app (Docker, VS Code, Claude, and others) is flagged until you quit that app.
- **Scoped actions.** Developer actions only touch what the app itself scanned: listening PIDs, discovered projects and repositories, and `localhost` URLs.
- **Local only.** The server binds to `127.0.0.1`, rejects any other `Host` header (blocking DNS rebinding), and requires a random per-launch token on every request.
- **Audit log.** Every cleanup action is written with a timestamp to `actions.log`.

---

## Requirements

- macOS 13 Ventura or later (Apple Silicon or Intel)
- [Node.js](https://nodejs.org) 18 or later, or [Bun](https://bun.sh)
- Xcode Command Line Tools to build the app (`xcode-select --install`)

No npm packages are needed. The server uses only Node's standard library.

---

## Installation

```bash
git clone https://github.com/AbuShyedHemel/storage-cleaner.git
cd storage-cleaner
./mac-app/build.sh --install
open "/Applications/Storage Cleaner.app"
```

`build.sh` compiles the Swift wrapper, bundles the web files into the app, and signs it ad hoc. Without `--install` it builds `Storage Cleaner.app` in the project folder only.

> **First launch:** because the app is signed ad hoc rather than with a Developer ID, macOS may warn that it can't verify the developer. Right-click the app in Finder and choose **Open** once to allow it.

**Launch at login:** System Settings › General › Login Items › add *Storage Cleaner*.

---

## Usage

1. Click the drive icon in the menu bar to open the panel.
2. Use the switch at the top to move between **Storage** and **Developer**. The app remembers your last choice.
3. Click any row to expand it and see its full path, notes, and extra actions.
4. In Clean, tick items and press **Clear** in the floating bar at the bottom.
5. Press the expand button in the header, or right-click the menu bar icon and choose **Open in Window**, for a larger view.

### Running in a browser instead

The interface also runs without the menu bar app:

```bash
node server.mjs
```

The server prints a private link (with its access token) and opens it in your default browser. You can also double-click `Storage Cleaner.command` in Finder.

---

## Configuration

The server reads these environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7788` (the app picks a random free port) | Port the local server listens on |
| `TOKEN` | Random per launch | Access token required by the UI and API |
| `PROJECT_ROOTS` | `~/Documents, ~/Projects, ~/Developer, ~/code, ~/dev, ~/src` | Comma-separated folders scanned for projects, build folders, dev scripts, and Git repositories |
| `LOG_DIR` | Project folder (the app uses `~/Library/Logs/Storage Cleaner`) | Where `actions.log` is written |
| `NO_OPEN` | Unset | Set to `1` to stop the server opening a browser on start |

Example:

```bash
PROJECT_ROOTS="$HOME/work,$HOME/oss" node server.mjs
```

---

## How it works

```
┌──────────────────────────── Storage Cleaner.app ────────────────────────────┐
│                                                                             │
│  Swift / AppKit                          Node.js (bundled in Resources)     │
│  ─────────────                           ─────────────────────────────      │
│  NSStatusItem  ── free space ◀──────┐    server.mjs  storage scans,         │
│  NSPopover / NSWindow                │                 cleanup, Trash       │
│    └─ WKWebView (transparent) ──HTTP─┴──▶ dev.mjs     ports, dev servers,   │
│         index.html                  127.0.0.1         Git status            │
│                                     + token                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **Native shell (`mac-app/main.swift`).** On launch, the app finds Node.js, picks a free port, generates a token, and starts `server.mjs` as a child process. It then loads the UI into a transparent `WKWebView` that sits on top of the popover's native vibrancy, which creates the glass effect. A `WKScriptMessageHandler` lets the page's buttons open the window or browser, refresh, or quit. On quit, the app sends `SIGTERM` to the server, which stops any dev servers it started.
- **Server (`server.mjs`).** A dependency-free Node HTTP server that measures folders with `du`, finds files with `find`, clears or moves items to the Trash, and talks to Docker through its CLI.
- **Developer module (`dev.mjs`).** Reads listening ports from `lsof`, process details from `ps`, and repository state from `git status --porcelain=v2`. It spawns dev servers detached in their own process group and keeps a ring buffer of their output.
- **Interface (`index.html`).** A single HTML file with no build step or framework, styled to match macOS. It polls running servers every 2 seconds and ports every 6 seconds, but only while the Developer view is visible.

---

## Project structure

```
storage-cleaner/
├── server.mjs                 # Local HTTP server: storage scans, cleanup, Trash, security
├── dev.mjs                    # Developer tools: ports, dev servers, Git status
├── index.html                 # Single-page glass UI (Storage + Developer)
├── Storage Cleaner.command    # Double-click launcher for browser mode
└── mac-app/
    ├── main.swift             # Menu bar app: status item, popover, window, server process
    ├── Info.plist             # Bundle settings (menu bar only, local networking)
    └── build.sh               # Compile, bundle, sign and optionally install
```

---

## API reference

All endpoints are served on `127.0.0.1` and require the `X-Token` header.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/disk` | Total, used and free disk space |
| `GET` | `/api/cleanables` | Cleanup catalog with sizes |
| `GET` | `/api/projects` | Build folders found in project roots |
| `GET` | `/api/library` | `~/Library` breakdown |
| `GET` | `/api/explore?path=&fresh=1` | Folder contents sorted by size (`fresh=1` skips the cache) |
| `GET` | `/api/large?min=` | Files larger than `min` MB |
| `POST` | `/api/clear` | Clear catalog items |
| `POST` | `/api/trash` | Move a path to the Trash |
| `POST` | `/api/reveal` | Reveal a path in Finder |
| `GET` | `/api/dev/ports` | Listening TCP ports |
| `POST` | `/api/dev/ports/stop` | Stop the process on a port (`{ pid, force }`) |
| `GET` | `/api/dev/projects` | Runnable projects and their scripts |
| `GET` | `/api/dev/procs` | Dev servers started by the app, with logs |
| `POST` | `/api/dev/start` | Start a script (`{ project, script }`) |
| `POST` | `/api/dev/stop` | Stop a started server (`{ id }`) |
| `POST` | `/api/dev/forget` | Remove finished servers from the list |
| `GET` | `/api/dev/git` | Git status for every repository |
| `POST` | `/api/dev/git/fetch` | Fetch all repositories |
| `POST` | `/api/dev/open` | Open a URL or folder in the browser, editor, terminal or Finder |

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The menu bar icon isn't visible | On MacBooks with a notch, macOS hides icons that don't fit. Quit other menu bar apps, or ⌘-drag icons to rearrange them. |
| The icon shows `!` | The local server stopped. Check `~/Library/Logs/Storage Cleaner/server.log`, then right-click › Reload or relaunch the app. |
| "Node.js was not found" | Install Node.js with `brew install node` or from [nodejs.org](https://nodejs.org), then reopen the app. |
| Some items can't be cleared | macOS protects certain files, and others are in use. Quit the related app and try again. Grant **Full Disk Access** in System Settings › Privacy & Security for deeper scans. |
| A dev server fails to start | Open its log in the Servers tab. Common causes are missing dependencies or a service such as Docker not running. |
| Projects or repositories are missing | Add their parent folder to `PROJECT_ROOTS`. |

---

## Uninstall

```bash
osascript -e 'quit app "Storage Cleaner"'
rm -rf "/Applications/Storage Cleaner.app" "$HOME/Library/Logs/Storage Cleaner"
```
