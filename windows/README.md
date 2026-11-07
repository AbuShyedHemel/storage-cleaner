# Storage Cleaner for Windows

**Free up memory, clean storage and make Windows 10/11 run smoother, from a tray app that shows your RAM use at a glance.**

The Windows edition lives in the system tray. Its icon shows how full your memory is (blue, amber at 70%, red at 85%) and opens a Windows 11–style window with five pages:

| Page | What it does |
| --- | --- |
| **Overview** | A health score with plain-language recommendations, live CPU and RAM, drive space, and a one-click **Boost**. |
| **Memory** | What is using your RAM, grouped by app (all 21 Chrome processes count as one). **Free up memory** trims every app's working set, and as administrator also clears the standby cache. End any app that is not part of Windows. |
| **Storage** | Clean up temp files, update caches, browser and app caches, and developer caches; find `node_modules` and build output in your projects; list large files; explore folders by size. |
| **Startup apps** | Every app that starts at sign-in (registry, Startup folder and Store apps), with how much memory each is using right now. Turn them off with one switch. |
| **Performance** | Reversible Windows settings (power mode, animations, transparency, background apps, tips, Storage Sense, hibernation), quick fixes, and shortcuts to the Windows settings that matter. |

Everything runs locally. There is no account, telemetry or network service, and nothing is deleted or changed without your confirmation.

![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-blue)
![Node](https://img.shields.io/badge/Node.js-18%2B-green)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

---

## Install

You need [Node.js](https://nodejs.org) 18 or later (`winget install OpenJS.NodeJS.LTS`). Nothing else: the native helper is compiled on first run with the C# compiler that ships with Windows.

```powershell
git clone https://github.com/AbuShyedHemel/storage-cleaner.git
cd storage-cleaner\windows
powershell -ExecutionPolicy Bypass -File install.ps1 -Desktop
```

`install.ps1` adds **Storage Cleaner** to the Start menu with the keyboard shortcut **Ctrl+Alt+S** (and the desktop with `-Desktop`, and sign-in with `-StartWithWindows`). It doesn't copy anything, so keep the folder where it is.

Or skip installing and double-click **`Storage Cleaner.cmd`**.

**Run in a browser instead** (no tray icon):

```powershell
node windows\server.mjs
```

---

## Using it

1. Click the tray icon (it may be in the **^** overflow; drag it onto the taskbar to keep it visible).
2. Start on **Overview** and work through the recommendations, or press **Boost now**.
3. Right-click the tray icon for **Free up memory**, **Restart as administrator**, **Start with Windows**, the log folder and **Quit**.

### Administrator mode

Most features work as a normal user. Run as administrator (button in the window, or right-click the tray icon) to also:

- clear the **standby cache** (the deepest memory clean Windows allows)
- clear **Windows temp**, **Windows Update downloads**, **Delivery Optimization**, system crash dumps and error reports
- turn off **hibernation** (frees `hiberfil.sys`, usually 40% of your RAM size)
- change startup apps installed **for all users**
- **optimize the system drive** (TRIM on an SSD, defrag on a hard disk)

---

## What each feature really does

### Memory

- **Free up memory** calls `EmptyWorkingSet` on every process it can open. Apps hand back pages they aren't using right now; Windows pages them back in if they are needed again. That gives instant headroom when you are about to open something heavy. It is not a permanent fix: if an app genuinely needs the memory it will take it back.
- **Clear standby cache** (administrator) flushes the modified list and purges the standby list, the same as Sysinternals RAMMap's *Empty Standby List*.
- **Cached memory isn't wasted.** Windows gives it to apps instantly. Real slowdowns come from memory *in use* and from *committed* memory nearing the limit, which the Memory page shows. Closing heavy apps, tabs and startup apps helps far more than any cleaner.
- **End** is offered only for apps in your session. Windows components, services, and Storage Cleaner itself can't be ended from here.

### Storage

| Group | Items |
| --- | --- |
| Windows | Temp files, Windows temp*, thumbnail & icon cache, crash dumps, error reports, Windows Update downloads*, Delivery Optimization cache*, graphics shader caches, Recycle Bin |
| Browsers | Chrome, Edge, Brave, Vivaldi, Opera and Firefox **cache only**. Logins, history, bookmarks and passwords are never touched. |
| App caches | Chromium/Electron caches of apps in `%APPDATA%` (VS Code, Discord, Slack, Teams, Obsidian, …), found automatically; Spotify's offline cache |
| Developer caches | npm, pnpm, Yarn, Bun, pip/uv, Gradle, NuGet, Go, Cargo, Electron, Playwright, pub, VS Code workspace storage |
| Docker | Build cache, unused images, stopped containers, unused volumes (through the Docker CLI) |

\* administrator

**Projects** finds `node_modules`, `.next`, `.turbo`, `.nuxt`, `.svelte-kit`, `.angular`, `.parcel-cache`, `.open-next`, `.vercel`, `.dart_tool`, `.gradle`, `.venv`/`venv`, `target`, `obj`, `dist` and `build` over 20 MB, grouped by project with the last commit date, and flags folders that OneDrive is also syncing.

**Large files** and **Explore folders** skip online-only OneDrive files, because they take no space on disk.

### Performance settings

| Setting | How it is applied | Undo |
| --- | --- | --- |
| Best performance power mode | Windows power mode overlay (Settings › Power mode) | Switch off → Balanced |
| Turn off animations | `SPI_SETCLIENTAREAANIMATION` + minimize/maximize animation (Settings › Visual effects) | Switch off |
| Turn off transparency | `EnableTransparency = 0` (Settings › Personalization › Colors) | Switch off |
| Stop Store apps in the background | `GlobalUserDisabled` / `BackgroundAppGlobalToggle` | Switch off |
| Turn off tips & suggestions | ContentDeliveryManager suggestion flags | Switch off |
| Storage Sense | `StoragePolicy\01 = 1` | Switch off |
| Turn off hibernation* | `powercfg /hibernate off` | `powercfg /hibernate on` (switch off) |

Startup apps are switched with the same `StartupApproved` flags Task Manager uses, so nothing is deleted and Task Manager shows the same state.

---

## Safety

- **Nothing without confirmation.** Every clean, delete, end, startup or settings change asks first, or is a switch you can flip back.
- **The UI sends ids, not paths or commands.** The server only clears items it measured itself in the last scan.
- **Recycle Bin, not delete,** for files removed from Large files and Explore. Your home folder, its standard folders (Desktop, Documents, Downloads, Pictures, Videos, Music, OneDrive), all of `AppData` (where Docker and WSL disks live) and credential folders (`.ssh`, `.aws`, `.kube`, …) can't be removed from here.
- **App-aware.** Browser and app caches are refused while the app is running.
- **Local only.** The server binds to `127.0.0.1`, rejects any other `Host` header and requires a random per-launch token.
- **Audit log.** Every action is written with a timestamp to `%LOCALAPPDATA%\Storage Cleaner\actions.log`.

---

## How it works

```
 tray.ps1 (system tray, live RAM icon)
   ├─ starts  node server.mjs  on 127.0.0.1:<random port> with a random token
   └─ opens   Edge --app=http://127.0.0.1:<port>/?t=<token>  (its own window and profile)

 server.mjs  routes, catalog of cleanable items, health checks
   └─ helper.exe  (helper.cs, compiled once with the in-box .NET Framework csc.exe)
        fast parallel folder sizes (FindFirstFileEx), memory counters (PDH),
        EmptyWorkingSet / standby purge, Recycle Bin, startup apps, Windows settings
```

| File | Purpose |
| --- | --- |
| `server.mjs` | Local HTTP server: scans, cleanup, memory, startup apps, settings, security |
| `helper.cs` | Native helper for everything Node can't do quickly on Windows |
| `index.html` | Single-page Windows 11–style interface, no build step |
| `tray.ps1` | Tray icon, server lifecycle, app window, Run as administrator |
| `install.ps1` | Start menu / desktop / sign-in shortcuts and app icon; `-Uninstall` |
| `Storage Cleaner.cmd` | Double-click launcher |

Data lives in `%LOCALAPPDATA%\Storage Cleaner` (`actions.log`, `server.log`, the compiled helper, the app window profile).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `7799` (the tray picks a random free port) | Server port |
| `TOKEN` | Random per launch | Access token |
| `PROJECT_ROOTS` | Documents, Desktop, `~\source\repos`, `~\Projects`, `~\code`, `~\dev`, `~\src` | Comma-separated folders scanned for projects |
| `LOG_DIR` | `%LOCALAPPDATA%\Storage Cleaner` | Log, helper and window profile folder |
| `NO_OPEN` | Unset | Set to `1` to stop the server opening a browser |

---

## Troubleshooting

| Problem | Fix |
| --- | --- |
| No tray icon | It may be hidden under **^**. Drag it to the taskbar, or turn it on in Settings › Personalization › Taskbar › Other system tray icons. |
| The icon shows `!` | The server stopped. Right-click › **Restart server**, or check `server.log` (right-click › Open log folder). |
| "Node.js was not found" | `winget install OpenJS.NodeJS.LTS`, then open Storage Cleaner again. |
| "Could not build the helper" | The .NET Framework 4 compiler is missing. Turn on **.NET Framework 4.8 Advanced Services** in *Turn Windows features on or off*. |
| An item is refused with "Quit … first" | Close that app (check the tray) and clean again. |
| Some files were skipped | Windows or an open app is using them. They are cleared next time. |
| Script execution is disabled | The shortcuts and `.cmd` use `-ExecutionPolicy Bypass` for this process only; your system policy isn't changed. |

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Uninstall
```

Then delete the folder. Settings you changed on the Performance page stay as they are; switch them off first if you want Windows defaults back.
