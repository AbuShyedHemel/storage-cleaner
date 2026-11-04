// Menu bar wrapper for Storage Cleaner: runs server.mjs in the background and
// shows its UI in a popover under a status bar icon. Free space is shown next
// to the icon and refreshed every minute.

import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSPopoverDelegate, WKScriptMessageHandler {
    let token = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
    var port: UInt16 = 0
    var server: Process?
    var statusItem: NSStatusItem!
    let popover = NSPopover()
    var webView: WKWebView!
    var window: NSWindow?
    let popoverHost = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 640))
    var refreshTimer: Timer?
    var quitting = false

    var appURL: URL { URL(string: "http://127.0.0.1:\(port)/?t=\(token)&app=1")! }

    func applicationDidFinishLaunching(_ note: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "internaldrive", accessibilityDescription: "Storage Cleaner")
            button.image?.isTemplate = true
            button.imagePosition = .imageLeading
            button.action = #selector(statusClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // Transparent web view over the popover's own vibrancy = native glass look.
        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "app")
        webView = WKWebView(frame: popoverHost.bounds, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        let vc = NSViewController()
        vc.view = popoverHost
        popover.contentViewController = vc
        popover.contentSize = popoverHost.frame.size
        host(webView, in: popoverHost)
        popover.behavior = .transient
        popover.delegate = self

        startServer()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshFreeSpace() }
    }

    func applicationWillTerminate(_ note: Notification) {
        quitting = true
        server?.terminate()
    }

    // MARK: server

    func startServer() {
        guard let node = findNode() else {
            fail("Node.js was not found. Install it from https://nodejs.org (or Homebrew) and reopen Storage Cleaner.")
            return
        }
        guard let script = Bundle.main.url(forResource: "server", withExtension: "mjs") else {
            fail("server.mjs is missing from the app bundle. Rebuild the app.")
            return
        }
        port = freePort()
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Storage Cleaner")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)

        let p = Process()
        p.executableURL = node
        p.arguments = [script.path]
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["TOKEN"] = token
        env["NO_OPEN"] = "1"
        env["LOG_DIR"] = logDir.path
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        p.environment = env
        let log = logDir.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        if let fh = try? FileHandle(forWritingTo: log) {
            p.standardOutput = fh
            p.standardError = fh
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.statusItem.button?.title = " !"
            }
        }
        do { try p.run() } catch {
            fail("Could not start the server: \(error.localizedDescription)")
            return
        }
        server = p
        waitForServer(attempts: 50)
    }

    func waitForServer(attempts: Int) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/disk")!)
        req.setValue(token, forHTTPHeaderField: "X-Token")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if let data, let free = Self.freeBytes(data) {
                    self.showFree(free)
                    self.webView.load(URLRequest(url: self.appURL))
                } else if attempts > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.waitForServer(attempts: attempts - 1) }
                } else {
                    self.fail("The server did not start. See ~/Library/Logs/Storage Cleaner/server.log")
                }
            }
        }.resume()
    }

    func refreshFreeSpace() {
        guard port != 0 else { return }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/disk")!)
        req.setValue(token, forHTTPHeaderField: "X-Token")
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data, let free = Self.freeBytes(data) else { return }
            DispatchQueue.main.async { self?.showFree(free) }
        }.resume()
    }

    static func freeBytes(_ data: Data) -> Double? {
        (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["free"] as? Double
    }

    func showFree(_ bytes: Double) {
        let f = ByteCountFormatter()
        f.countStyle = .file
        f.allowedUnits = [.useGB, .useTB]
        statusItem.button?.title = " " + f.string(fromByteCount: Int64(bytes))
    }

    func findNode() -> URL? {
        let home = NSHomeDirectory()
        var candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "\(home)/.volta/bin/node"]
        // nvm installs: newest version first.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            candidates += versions.sorted { $0.compare($1, options: .numeric) == .orderedDescending }
                .map { "\(nvm)/\($0)/bin/node" }
        }
        candidates.append("\(home)/.bun/bin/bun")
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }.map(URL.init(fileURLWithPath:))
    }

    func freePort() -> UInt16 {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        addr.sin_port = 0
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, len) } }
        _ = withUnsafeMutablePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        let p = UInt16(bigEndian: addr.sin_port)
        return p == 0 ? 7799 : p
    }

    func fail(_ message: String) {
        statusItem.button?.title = " !"
        let alert = NSAlert()
        alert.messageText = "Storage Cleaner"
        alert.informativeText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }

    // MARK: UI

    @objc func statusClicked(_ sender: NSStatusBarButton) {
        if NSApp.currentEvent?.type == .rightMouseUp {
            let menu = NSMenu()
            menu.addItem(withTitle: "Open in Window", action: #selector(openWindow), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
            menu.addItem(withTitle: "Show Action Log", action: #selector(showLog), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Quit Storage Cleaner", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
            statusItem.menu = menu
            sender.performClick(nil)
            statusItem.menu = nil
            return
        }
        if popover.isShown {
            popover.performClose(sender)
        } else {
            window?.close()
            if webView.superview !== popoverHost {
                host(webView, in: popoverHost)
                setMode("popover")
            }
            NSApp.activate(ignoringOtherApps: true)
            popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        }
    }

    @objc func openWindow() {
        popover.performClose(nil)
        if window == nil {
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 720),
                             styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
                             backing: .buffered, defer: false)
            w.title = "Storage Cleaner"
            w.titlebarAppearsTransparent = true
            w.titleVisibility = .hidden
            w.isMovableByWindowBackground = true
            w.minSize = NSSize(width: 420, height: 400)
            w.isReleasedWhenClosed = false
            let glass = NSVisualEffectView()
            glass.material = .underWindowBackground
            glass.blendingMode = .behindWindow
            glass.state = .active
            w.contentView = glass
            w.center()
            window = w
        }
        if let glass = window?.contentView { host(webView, in: glass) }
        setMode("window")
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }

    @objc func openBrowser() { NSWorkspace.shared.open(appURL) }
    @objc func reload() { webView.load(URLRequest(url: appURL)); refreshFreeSpace() }
    @objc func showLog() {
        let log = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Storage Cleaner/actions.log")
        if FileManager.default.fileExists(atPath: log.path) { NSWorkspace.shared.open(log) }
        else { NSWorkspace.shared.open(log.deletingLastPathComponent()) }
    }

    func popoverDidClose(_ notification: Notification) { refreshFreeSpace() }

    func host(_ view: NSView, in container: NSView) {
        view.removeFromSuperview()
        view.frame = container.bounds
        view.autoresizingMask = [.width, .height]
        container.addSubview(view)
    }

    func setMode(_ mode: String) {
        webView.evaluateJavaScript("window.setMode && setMode('\(mode)')")
    }

    // Buttons in the page's header call window.webkit.messageHandlers.app.postMessage(...).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.body as? String {
        case "window": openWindow()
        case "browser": openBrowser()
        case "quit": NSApp.terminate(nil)
        case "refresh": refreshFreeSpace()
        default: break
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
