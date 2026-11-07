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
        string profile = args.Length > 1 ? args[1] : Path.Combine(Data, "window");
        if (url == null)
        {
            // Started on its own (pinned to the taskbar): reuse the running tray app, or start it.
            var session = ReadSession();
            if (session != null && session.Alive) url = session.Url;
            else
            {
                if (session != null && session.Tray != null && File.Exists(session.Tray))
                {
                    mutex.ReleaseMutex();
                    Process.Start(new ProcessStartInfo("powershell.exe",
                        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + session.Tray + "\" -Open")
                        { UseShellExecute = false, CreateNoWindow = true });
                    return 0;
                }
                MessageBox.Show("Start Storage Cleaner from the Start menu first.", "Storage Cleaner", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return 1;
            }
        }

        try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException)
        {
            // No WebView2 runtime (rare on Windows 10/11): use the default browser instead.
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
            return 2;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(url, profile));
        GC.KeepAlive(mutex);
        return 0;
    }

    class Session { public string Url, Tray; public bool Alive; }

    static Session ReadSession()
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(Data, "session.json")).TrimStart('﻿');
            var d = new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string, object>>(text);
            var s = new Session { Url = d["url"] as string, Tray = d.ContainsKey("tray") ? d["tray"] as string : null };
            try { using (var p = Process.GetProcessById(Convert.ToInt32(d["pid"]))) s.Alive = !p.HasExited && p.ProcessName.Equals("powershell", StringComparison.OrdinalIgnoreCase); }
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
    readonly string url, profile, origin;

    public MainForm(string url, string profile)
    {
        this.url = url;
        this.profile = profile;
        var u = new Uri(url);
        origin = u.Scheme + "://" + u.Authority;

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
        FormClosing += (s, e) => SaveBounds();
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
            if (e.Uri.StartsWith(origin + "/", StringComparison.OrdinalIgnoreCase) || e.Uri == origin) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        };
        core.NewWindowRequested += (s, e) => { e.Handled = true; OpenExternal(e.Uri); };
        core.DocumentTitleChanged += (s, e) => { Text = "Storage Cleaner"; };
        core.ProcessFailed += (s, e) => { if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited) Close(); else web.Reload(); };
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
