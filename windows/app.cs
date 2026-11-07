// Storage Cleaner for Windows: the app window.
//
// A small native window (WinForms + WebView2) that shows the local interface,
// so Storage Cleaner has its own name and icon on the taskbar instead of
// looking like an Edge window. build-window.ps1 compiles it with the in-box
// C# compiler against Microsoft's WebView2 SDK.
//
//   StorageCleaner.exe <url> <user-data-folder>
//   StorageCleaner.exe            (e.g. pinned to the taskbar: reads session.json,
//                                  or starts the tray app if it isn't running)

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

static class App
{
    [DllImport("shell32.dll", SetLastError = true)]
    static extern void SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);

    static readonly string Data = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Storage Cleaner");

    [STAThread]
    static int Main(string[] args)
    {
        SetCurrentProcessExplicitAppUserModelID("StorageCleaner.Windows");

        // One window at a time: a second launch brings the first one forward.
        bool created;
        var mutex = new Mutex(true, @"Local\StorageCleanerWindow", out created);
        if (!created)
        {
            IntPtr h = FindWindow(null, "Storage Cleaner");
            if (h != IntPtr.Zero) { if (IsIconic(h)) ShowWindow(h, 9 /* SW_RESTORE */); SetForegroundWindow(h); }
            return 0;
        }

        string url = args.Length > 0 ? args[0] : null;
        string profile = args.Length > 1 ? args[1] : Path.Combine(Data, "webview");
        string tray = null;
        Session session0 = null;
        if (url == null)
        {
            // Started from a shortcut, search or the taskbar: use the running tray
            // app, or start it and wait for its server.
            var session = session0 = ReadSession();
            if (session != null && session.Alive && Answers(session.Url)) url = session.Url;
            else
            {
                if (session != null && session.Alive)
                {
                    // The tray app is running but its server is not answering: restart it
                    // (only when we are sure the pid is still our tray).
                    try
                    {
                        if (!session.Verified) throw new UnauthorizedAccessException();
                        using (var p = Process.GetProcessById(session.Pid)) { p.Kill(); p.WaitForExit(3000); }
                        Log("restarted unresponsive tray " + session.Pid);
                    }
                    catch
                    {
                        MessageBox.Show("Storage Cleaner is running as administrator but has stopped responding.\n\n" +
                            "Right-click the Storage Cleaner icon by the clock and choose Quit, then open Storage Cleaner again.",
                            "Storage Cleaner", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return 1;
                    }
                }
                tray = FindTray(session);
                if (tray == null)
                {
                    MessageBox.Show("Storage Cleaner could not find its program folder. Run windows\\install.ps1 again.", "Storage Cleaner", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return 1;
                }
            }
        }

        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException)
        {
            // No WebView2 runtime (rare on Windows 10/11): the tray opens an Edge or browser window instead.
            if (url != null) { try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { } }
            else StartTray(tray, true);
            return 2;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += (s, e) =>
        {
            Log("error: " + e.Exception);
            MessageBox.Show("Storage Cleaner hit a problem:\n\n" + e.Exception.Message + "\n\nDetails are in " + Path.Combine(Data, "window.log"),
                "Storage Cleaner", MessageBoxButtons.OK, MessageBoxIcon.Error);
        };
        Log("open " + (url != null ? "with running server" : "and start tray " + tray) + (session0 != null ? " (session pid " + session0.Pid + ", alive " + session0.Alive + ")" : ""));
        Application.Run(new MainForm(url, profile, tray));
        GC.KeepAlive(mutex);
        return 0;
    }

    public class Session { public string Url, Tray; public bool Alive, Verified; public int Pid; }

    // Start-up log (window.log) so problems opening the window can be diagnosed.
    public static void Log(string msg)
    {
        try
        {
            var f = Path.Combine(Data, "window.log");
            if (File.Exists(f) && new FileInfo(f).Length > 200000) File.Delete(f);
            File.AppendAllText(f, DateTime.Now.ToString("s") + " " + msg + Environment.NewLine);
        }
        catch { }
    }

    public static bool Answers(string url)
    {
        if (url == null) return false;
        try
        {
            var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(url);
            req.Timeout = 2500;
            using (var resp = (System.Net.HttpWebResponse)req.GetResponse()) return resp.StatusCode == System.Net.HttpStatusCode.OK;
        }
        catch { return false; }
    }

    // tray.txt is written next to the exe by build-window.ps1.
    static string FindTray(Session s)
    {
        if (s != null && s.Tray != null && File.Exists(s.Tray)) return s.Tray;
        try
        {
            var t = File.ReadAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "tray.txt")).Trim();
            if (File.Exists(t)) return t;
        }
        catch { }
        return null;
    }

    public static Process StartTray(string tray, bool open)
    {
        return Process.Start(new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + tray + "\" " + (open ? "-Open" : "-Background"))
            { UseShellExecute = false, CreateNoWindow = true });
    }

    public static Session ReadSession()
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(Data, "session.json")).TrimStart('﻿');
            var d = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(text);
            var s = new Session { Url = d["url"] as string, Tray = d.ContainsKey("tray") ? d["tray"] as string : null, Pid = Convert.ToInt32(d["pid"]) };
            // Process ids get reused, so a pid alone does not prove the tray is still running:
            // the start time recorded in session.json must match too.
            try
            {
                using (var p = Process.GetProcessById(s.Pid))
                {
                    s.Alive = !p.HasExited && p.ProcessName.Equals("powershell", StringComparison.OrdinalIgnoreCase);
                    object started;
                    if (s.Alive && d.TryGetValue("started", out started) && started != null)
                    {
                        try { s.Verified = Math.Abs((p.StartTime.ToUniversalTime() - DateTime.Parse((string)started, null, System.Globalization.DateTimeStyles.RoundtripKind).ToUniversalTime()).TotalSeconds) < 2; }
                        catch { s.Verified = false; } // elevated tray: start time not readable
                        if (!s.Verified) { try { var _ = p.StartTime; s.Alive = false; } catch { } } // readable but different: someone else's process
                    }
                }
            }
            catch { s.Alive = false; }
            return s;
        }
        catch { return null; }
    }
}

class MainForm : Form
{
    [DllImport("dwmapi.dll")]
    static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    const string StateKey = @"Software\Storage Cleaner\Window";
    readonly WebView2 web = new WebView2();
    readonly string profile, tray;
    string url, origin;

    public MainForm(string url, string profile, string tray)
    {
        this.url = url;
        this.profile = profile;
        this.tray = tray;

        Text = "Storage Cleaner";
        try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        MinimumSize = new Size(720, 520);
        StartPosition = FormStartPosition.Manual;
        LoadBounds();
        bool dark = Dark();
        BackColor = dark ? Color.FromArgb(32, 32, 32) : Color.FromArgb(243, 243, 243);
        web.DefaultBackgroundColor = BackColor;
        web.Dock = DockStyle.Fill;
        Controls.Add(web);
        Load += async (s, e) => await Init();
        // Come to the front even when started through another process.
        Shown += (s, e) => { TopMost = true; Activate(); TopMost = false; };
        FormClosing += (s, e) => SaveBounds();
    }

    // Placeholders are replaced by hand: the CSS braces would break string.Format.
    const string Splash = "<html><body style=\"margin:0;height:100vh;display:grid;place-items:center;font:15px 'Segoe UI';background:%BG%;color:%FG%\">" +
        "<div style=\"text-align:center\"><div style=\"width:22px;height:22px;margin:0 auto 14px;border:3px solid rgba(128,128,128,.3);border-top-color:#0a84ff;border-radius:50%;animation:s .8s linear infinite\"></div>%TEXT%</div>" +
        "<style>@keyframes s{to{transform:rotate(360deg)}}</style></body></html>";

    void ShowMessage(string text)
    {
        bool dark = Dark();
        web.NavigateToString(Splash.Replace("%BG%", dark ? "#202020" : "#f3f3f3").Replace("%FG%", dark ? "#c5c5c5" : "#5d5d5d")
            .Replace("%TEXT%", System.Net.WebUtility.HtmlEncode(text)));
    }

    // Starts the tray app (which starts the server) and waits until it answers.
    async System.Threading.Tasks.Task<string> StartAndWait()
    {
        ShowMessage("Starting Storage Cleaner…");
        int pid = App.StartTray(tray, false).Id;
        var until = DateTime.Now.AddSeconds(120);
        while (DateTime.Now < until)
        {
            await System.Threading.Tasks.Task.Delay(500);
            var s = App.ReadSession();
            if (s == null || !s.Alive || s.Url == null) continue;
            try
            {
                var req = (System.Net.HttpWebRequest)System.Net.WebRequest.Create(s.Url);
                req.Timeout = 2000;
                using (var resp = (System.Net.HttpWebResponse)await req.GetResponseAsync())
                    if (resp.StatusCode == System.Net.HttpStatusCode.OK) return s.Url;
            }
            catch { }
        }
        return null;
    }

    static bool Dark()
    {
        using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
        {
            var v = k == null ? null : k.GetValue("AppsUseLightTheme");
            return v is int && (int)v == 0;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        // Dark title bar to match the page, and Mica on Windows 11.
        int on = Dark() ? 1 : 0;
        DwmSetWindowAttribute(Handle, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, ref on, 4);
        int mica = 2 /* DWMSBT_MAINWINDOW */;
        DwmSetWindowAttribute(Handle, 38 /* DWMWA_SYSTEMBACKDROP_TYPE */, ref mica, 4);
    }

    async System.Threading.Tasks.Task Init()
    {
        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            await web.EnsureCoreWebView2Async(env);
        }
        catch (Exception ex)
        {
            MessageBox.Show("The window could not start WebView2:\n\n" + ex.Message, "Storage Cleaner", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return;
        }
        var core = web.CoreWebView2;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsGeneralAutofillEnabled = false;
        core.Settings.IsPasswordAutosaveEnabled = false;
        // Only our own local page lives in this window; any other link opens in the default browser.
        core.NavigationStarting += (s, e) =>
        {
            if (origin == null || e.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) || e.Uri == origin) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.DocumentTitleChanged += (s, e) => { Text = "Storage Cleaner"; };
        core.ProcessFailed += (s, e) => { if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) Close(); else web.Reload(); };
        if (url == null)
        {
            url = await StartAndWait();
            if (url == null) { ShowMessage("Storage Cleaner did not start. Open the log folder from the tray icon, or reinstall."); return; }
        }
        var u = new Uri(url);
        origin = u.Scheme + "://" + u.Authority;
        web.Source = new Uri(url + (url.Contains("?") ? "&" : "?") + "app=1");
    }

    static void OpenExternal(string uri)
    {
        if (uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
    }

    void LoadBounds()
    {
        var area = Screen.PrimaryScreen.WorkingArea;
        var size = new Size(Math.Min(1180, area.Width - 40), Math.Min(840, area.Height - 40));
        var bounds = new Rectangle(area.Left + (area.Width - size.Width) / 2, area.Top + (area.Height - size.Height) / 2, size.Width, size.Height);
        bool max = false;
        try
        {
            using (var k = Registry.CurrentUser.OpenSubKey(StateKey))
            {
                if (k != null)
                {
                    var r = new Rectangle((int)k.GetValue("X"), (int)k.GetValue("Y"), (int)k.GetValue("W"), (int)k.GetValue("H"));
                    // Only reuse a saved position that is still on a connected screen.
                    foreach (var sc in Screen.AllScreens) if (sc.WorkingArea.IntersectsWith(r) && r.Width >= 720 && r.Height >= 520) { bounds = r; break; }
                    max = Convert.ToInt32(k.GetValue("Max", 0)) == 1;
                }
            }
        }
        catch { }
        Bounds = bounds;
        if (max) WindowState = FormWindowState.Maximized;
    }

    void SaveBounds()
    {
        try
        {
            var r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            using (var k = Registry.CurrentUser.CreateSubKey(StateKey))
            {
                k.SetValue("X", r.X); k.SetValue("Y", r.Y); k.SetValue("W", r.Width); k.SetValue("H", r.Height);
                k.SetValue("Max", WindowState == FormWindowState.Maximized ? 1 : 0);
            }
        }
        catch { }
    }
}
