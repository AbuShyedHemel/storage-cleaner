// Storage Cleaner for Windows: native helper.
//
// server.mjs compiles this file once with the C# compiler that ships with
// Windows (.NET Framework 4, csc.exe) and calls it for anything Node cannot do
// quickly or at all: fast folder sizes, memory statistics, trimming RAM,
// startup apps, the Recycle Bin and a handful of reversible Windows settings.
//
//   helper.exe <command> [args]     input JSON on stdin (when needed), JSON on stdout
//
// Written in C# 5 so the in-box compiler can build it with no SDK installed.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class Helper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };

    static int Main(string[] args)
    {
        // Opt in to modern path handling so \\?\ long paths work (off by default
        // for an exe built without an app.config).
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        int code = 0;
        object result;
        try { result = Dispatch(args); }
        catch (Exception e) { result = Obj("error", e.Message); code = 1; }
        stdout.Write(Json.Serialize(result));
        stdout.Flush();
        return code;
    }

    static object Dispatch(string[] a)
    {
        string cmd = a.Length > 0 ? a[0] : "";
        switch (cmd)
        {
            case "admin": return Obj("admin", IsAdmin());
            case "sizes": return Sizes(Input());
            case "find-dirs": return FindDirs(Input());
            case "large": return Large(Input());
            case "explore": return Explore(Input());
            case "drives": return Drives();
            case "mem": return Mem();
            case "procs": return Procs();
            case "trim": return Trim();
            case "purge": return Purge();
            case "recycle": return RecycleInfo();
            case "recycle-empty": return RecycleEmpty();
            case "trash": return Trash(Input());
            case "startup": return StartupList();
            case "startup-set": return StartupSet(Input());
            case "tweaks": return Tweaks();
            case "tweak-set": return TweakSet(Input());
            case "folders": return Folders();
            case "cmdlines": return CmdLines(Input());
            default: throw new Exception("unknown command: " + cmd);
        }
    }

    // ---------------------------------------------------------------- utils

    static Dictionary<string, object> Obj(params object[] kv)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    static Dictionary<string, object> Input()
    {
        var s = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)).ReadToEnd();
        return string.IsNullOrWhiteSpace(s) ? new Dictionary<string, object>() : Json.Deserialize<Dictionary<string, object>>(s);
    }

    static List<string> Strings(Dictionary<string, object> d, string key)
    {
        var list = new List<string>();
        object v;
        if (d.TryGetValue(key, out v) && v is System.Collections.IEnumerable && !(v is string))
            foreach (var x in (System.Collections.IEnumerable)v) if (x != null) list.Add(x.ToString());
        return list;
    }

    static bool IsAdmin()
    {
        return new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    }

    // ---------------------------------------------------------------- fast file walking
    // FindFirstFileEx with the "basic" info level and large fetch is several times
    // faster than DirectoryInfo, and a small worker pool keeps an SSD busy.

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WIN32_FIND_DATA
    {
        public uint dwFileAttributes;
        public uint ftCreationLow, ftCreationHigh, ftAccessLow, ftAccessHigh, ftWriteLow, ftWriteHigh;
        public uint nFileSizeHigh; public uint nFileSizeLow; public uint dwReserved0; public uint dwReserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string name, int infoLevel, out WIN32_FIND_DATA data, int searchOp, IntPtr filter, int flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr h, out WIN32_FIND_DATA data);

    [DllImport("kernel32.dll")]
    static extern bool FindClose(IntPtr h);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributesW(string name);

    const uint A_DIR = 0x10, A_LINK = 0x400, A_HIDDEN = 0x2, A_SYSTEM = 0x4;
    // Files that only exist in the cloud (OneDrive "online-only") take no disk space.
    const uint A_CLOUD = 0x1000 | 0x40000 | 0x400000; // OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS

    class Ent { public string Name, Full; public uint Attr; public long Size, Write, Access; }

    static string Norm(string p)
    {
        p = p.Replace('/', '\\');
        if (p.StartsWith(@"\\?\")) p = p.Substring(4);
        try { p = Path.GetFullPath(p); } catch { }
        return p.Length > 3 ? p.TrimEnd('\\') : p;
    }

    // Long-path prefix so deep node_modules trees can be read.
    static string LP(string p) { return p.StartsWith(@"\\") ? p : @"\\?\" + p; }

    static long FT(uint lo, uint hi) { return ((long)hi << 32) | lo; }

    static List<Ent> List(string dir)
    {
        var outp = new List<Ent>();
        WIN32_FIND_DATA d;
        string pattern = LP(dir.TrimEnd('\\')) + @"\*";
        IntPtr h = FindFirstFileExW(pattern, 1 /* FindExInfoBasic */, out d, 0, IntPtr.Zero, 2 /* LARGE_FETCH */);
        if (h == new IntPtr(-1)) return outp;
        string prefix = dir.EndsWith("\\") ? dir : dir + "\\";
        try
        {
            do
            {
                if (d.cFileName == "." || d.cFileName == "..") continue;
                outp.Add(new Ent
                {
                    Name = d.cFileName, Full = prefix + d.cFileName, Attr = d.dwFileAttributes,
                    Size = ((long)d.nFileSizeHigh << 32) | d.nFileSizeLow,
                    Write = FT(d.ftWriteLow, d.ftWriteHigh), Access = FT(d.ftAccessLow, d.ftAccessHigh),
                });
            } while (FindNextFileW(h, out d));
        }
        finally { FindClose(h); }
        return outp;
    }

    static bool IsDir(Ent e) { return (e.Attr & A_DIR) != 0; }
    static bool IsLink(Ent e) { return (e.Attr & A_LINK) != 0; }
    static long DiskSize(Ent e) { return (e.Attr & A_CLOUD) != 0 ? 0 : e.Size; }

    // Parallel walk. visit(entry) returns true to descend into a directory.
    static void Walk(IEnumerable<string> roots, Func<Ent, bool> visit)
    {
        var queue = new System.Collections.Concurrent.ConcurrentQueue<string>();
        int pending = 0;
        foreach (var r in roots) { queue.Enqueue(r); pending++; }
        if (pending == 0) return;
        int workers = Math.Min(8, Math.Max(2, Environment.ProcessorCount * 2));
        var threads = new Thread[workers];
        for (int t = 0; t < workers; t++)
        {
            threads[t] = new Thread(() =>
            {
                int idle = 0;
                while (true)
                {
                    string dir;
                    if (!queue.TryDequeue(out dir))
                    {
                        if (Volatile.Read(ref pending) == 0) return;
                        Thread.Sleep(idle++ < 50 ? 0 : 1);
                        continue;
                    }
                    idle = 0;
                    try
                    {
                        foreach (var e in List(dir))
                            if (visit(e) && IsDir(e) && !IsLink(e)) { Interlocked.Increment(ref pending); queue.Enqueue(e.Full); }
                    }
                    catch { }
                    Interlocked.Decrement(ref pending);
                }
            });
            threads[t].IsBackground = true;
            threads[t].Start();
        }
        foreach (var th in threads) th.Join();
    }

    // Bytes and file count under a path. Skips links/junctions and cloud-only files.
    static long[] Measure(string path)
    {
        path = Norm(path);
        uint attr = GetFileAttributesW(LP(path));
        if (attr == 0xFFFFFFFF) return new long[] { 0, 0 };
        if ((attr & A_DIR) == 0)
        {
            try { var fi = new FileInfo(LP(path)); return new long[] { (attr & A_CLOUD) != 0 ? 0 : fi.Length, 1 }; }
            catch { return new long[] { 0, 0 }; }
        }
        if ((attr & A_LINK) != 0) return new long[] { 0, 0 };
        long bytes = 0, files = 0;
        Walk(new[] { path }, e =>
        {
            if (IsLink(e)) return false;
            if (IsDir(e)) return true;
            Interlocked.Increment(ref files);
            Interlocked.Add(ref bytes, DiskSize(e));
            return false;
        });
        return new long[] { bytes, files };
    }

    static string Iso(long ft)
    {
        try { return DateTime.FromFileTimeUtc(ft).ToString("o"); } catch { return null; }
    }

    // ---------------------------------------------------------------- disk

    static object Sizes(Dictionary<string, object> input)
    {
        return Strings(input, "paths").Select(p => { var m = Measure(p); return (object)Obj("path", p, "bytes", m[0], "files", m[1]); }).ToList();
    }

    static object FindDirs(Dictionary<string, object> input)
    {
        var names = new HashSet<string>(Strings(input, "names"), StringComparer.OrdinalIgnoreCase);
        var prune = new HashSet<string>(Strings(input, "prune"), StringComparer.OrdinalIgnoreCase);
        var found = new System.Collections.Concurrent.ConcurrentBag<string>();
        Walk(Strings(input, "roots").Select(Norm).Where(Directory.Exists), e =>
        {
            if (!IsDir(e) || IsLink(e)) return false;
            if (names.Contains(e.Name)) { found.Add(e.Full); return false; }
            return !prune.Contains(e.Name);
        });
        return found.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
    }

    static object Large(Dictionary<string, object> input)
    {
        long min = Convert.ToInt64(input.ContainsKey("min") ? input["min"] : 500L * 1024 * 1024);
        var skip = new HashSet<string>(Strings(input, "skip"), StringComparer.OrdinalIgnoreCase);
        var skipPaths = new HashSet<string>(Strings(input, "skipPaths").Select(Norm), StringComparer.OrdinalIgnoreCase);
        var outp = new System.Collections.Concurrent.ConcurrentBag<object>();
        Walk(Strings(input, "roots").Select(Norm), e =>
        {
            if (IsLink(e)) return false;
            if (IsDir(e)) return !skip.Contains(e.Name) && !skipPaths.Contains(e.Full);
            if (e.Size >= min && (e.Attr & A_CLOUD) == 0)
                outp.Add(Obj("path", e.Full, "size", e.Size, "modified", Iso(e.Write), "accessed", Iso(e.Access)));
            return false;
        });
        return outp.ToList();
    }

    static object Explore(Dictionary<string, object> input)
    {
        string dir = Norm((string)input["path"]);
        uint attr = GetFileAttributesW(LP(dir));
        if (attr == 0xFFFFFFFF || (attr & A_DIR) == 0) throw new Exception("Cannot open " + dir);
        var outp = new List<object>();
        foreach (var e in List(dir))
        {
            bool system = (e.Attr & (A_HIDDEN | A_SYSTEM)) == (A_HIDDEN | A_SYSTEM);
            if (IsLink(e)) { outp.Add(Obj("name", e.Name, "path", e.Full, "size", 0L, "type", "link", "system", system)); continue; }
            if (IsDir(e))
            {
                var m = Measure(e.Full);
                outp.Add(Obj("name", e.Name, "path", e.Full, "size", m[0], "files", m[1], "type", "dir", "system", system));
                continue;
            }
            bool cloud = (e.Attr & A_CLOUD) != 0;
            outp.Add(Obj("name", e.Name, "path", e.Full, "size", DiskSize(e), "type", "file", "cloud", cloud, "system", system,
                "modified", Iso(e.Write)));
        }
        return outp;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);

    static string Known(string guid)
    {
        IntPtr p;
        if (SHGetKnownFolderPath(new Guid(guid), 0, IntPtr.Zero, out p) != 0) return null;
        try { return Marshal.PtrToStringUni(p); } finally { Marshal.FreeCoTaskMem(p); }
    }

    // Real locations of the user's folders (they move when OneDrive backs them up).
    static object Folders()
    {
        return Obj(
            "Desktop", Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            "Documents", Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
            "Downloads", Known("374DE290-123F-4565-9164-39C4925E467B"),
            "Pictures", Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
            "Videos", Environment.GetFolderPath(Environment.SpecialFolder.MyVideos),
            "Music", Environment.GetFolderPath(Environment.SpecialFolder.MyMusic),
            "OneDrive", Environment.GetEnvironmentVariable("OneDrive"));
    }

    // Command lines for the named processes (to tell our own Edge window apart from the user's Edge).
    static object CmdLines(Dictionary<string, object> input)
    {
        var names = new HashSet<string>(Strings(input, "names").Select(n => n.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? n : n + ".exe"),
            StringComparer.OrdinalIgnoreCase);
        var outp = new List<object>();
        using (var s = new System.Management.ManagementObjectSearcher("SELECT ProcessId, Name, CommandLine FROM Win32_Process"))
        {
            foreach (System.Management.ManagementObject o in s.Get())
            {
                using (o)
                {
                    var name = Convert.ToString(o["Name"]);
                    if (!names.Contains(name)) continue;
                    outp.Add(Obj("pid", Convert.ToInt32(o["ProcessId"]), "name", name.Substring(0, name.Length - 4), "cmd", Convert.ToString(o["CommandLine"])));
                }
            }
        }
        return outp;
    }

    static object Drives()
    {
        var outp = new List<object>();
        foreach (var d in DriveInfo.GetDrives())
        {
            try
            {
                if (d.DriveType != DriveType.Fixed || !d.IsReady) continue;
                outp.Add(Obj("name", d.Name.TrimEnd('\\'), "label", d.VolumeLabel, "format", d.DriveFormat,
                    "total", d.TotalSize, "free", d.AvailableFreeSpace));
            }
            catch { }
        }
        return outp;
    }

    // ---------------------------------------------------------------- recycle bin / trash

    [StructLayout(LayoutKind.Sequential)]
    struct SHQUERYRBINFO { public int cbSize; public long i64Size; public long i64NumItems; }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHQueryRecycleBin(string pszRootPath, ref SHQUERYRBINFO info);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHEmptyRecycleBin(IntPtr hwnd, string pszRootPath, uint flags);

    static object RecycleInfo()
    {
        var info = new SHQUERYRBINFO { cbSize = Marshal.SizeOf(typeof(SHQUERYRBINFO)) };
        int hr = SHQueryRecycleBin(null, ref info);
        if (hr != 0) throw new Exception("Could not read the Recycle Bin (0x" + hr.ToString("X") + ")");
        return Obj("size", info.i64Size, "items", info.i64NumItems);
    }

    static object RecycleEmpty()
    {
        // SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND
        int hr = SHEmptyRecycleBin(IntPtr.Zero, null, 7);
        // S_OK, or E_UNEXPECTED when the bin was already empty.
        if (hr != 0 && hr != unchecked((int)0x8000FFFF)) throw new Exception("Could not empty the Recycle Bin (0x" + hr.ToString("X") + ")");
        return Obj("ok", true);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags;
        public bool fAnyOperationsAborted; public IntPtr hNameMappings; public string lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SHFileOperation(ref SHFILEOPSTRUCT op);

    static object Trash(Dictionary<string, object> input)
    {
        string p = (string)input["path"];
        if (!File.Exists(p) && !Directory.Exists(p)) throw new Exception("Not found");
        var op = new SHFILEOPSTRUCT
        {
            wFunc = 3, // FO_DELETE
            pFrom = p + "\0\0",
            // FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI | FOF_WANTNUKEWARNING
            fFlags = 0x40 | 0x10 | 0x4 | 0x400 | 0x4000,
        };
        int r = SHFileOperation(ref op);
        if (r != 0 || op.fAnyOperationsAborted) throw new Exception("Windows could not move it to the Recycle Bin (code " + r + "). It may be in use.");
        if (File.Exists(p) || Directory.Exists(p)) throw new Exception("Some files are in use and were not moved.");
        return Obj("ok", true);
    }

    // ---------------------------------------------------------------- memory

    [StructLayout(LayoutKind.Sequential)]
    class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad; public ulong ullTotalPhys; public ulong ullAvailPhys; public ulong ullTotalPageFile;
        public ulong ullAvailPageFile; public ulong ullTotalVirtual; public ulong ullAvailVirtual; public ulong ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX m);

    [StructLayout(LayoutKind.Sequential)]
    struct PERFORMANCE_INFORMATION
    {
        public int cb; public IntPtr CommitTotal; public IntPtr CommitLimit; public IntPtr CommitPeak; public IntPtr PhysicalTotal;
        public IntPtr PhysicalAvailable; public IntPtr SystemCache; public IntPtr KernelTotal; public IntPtr KernelPaged;
        public IntPtr KernelNonpaged; public IntPtr PageSize; public int HandleCount; public int ProcessCount; public int ThreadCount;
    }

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool GetPerformanceInfo(out PERFORMANCE_INFORMATION pi, int cb);

    static ulong Avail()
    {
        var m = new MEMORYSTATUSEX();
        GlobalMemoryStatusEx(m);
        return m.ullAvailPhys;
    }

    // PDH reads the same counters as Performance Monitor, by English name, in
    // milliseconds (System.Diagnostics.PerformanceCounter takes seconds to load).
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhOpenQuery(string source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
    static extern int PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")]
    static extern int PdhCollectQueryData(IntPtr query);
    [StructLayout(LayoutKind.Sequential)]
    struct PDH_FMT_COUNTERVALUE_LARGE { public uint CStatus; public long largeValue; }
    [DllImport("pdh.dll")]
    static extern int PdhGetFormattedCounterValue(IntPtr counter, uint format, IntPtr type, out PDH_FMT_COUNTERVALUE_LARGE value);
    [DllImport("pdh.dll")]
    static extern int PdhCloseQuery(IntPtr query);

    static Dictionary<string, long> Counters(params string[] names)
    {
        var outp = new Dictionary<string, long>();
        IntPtr q;
        if (PdhOpenQuery(null, IntPtr.Zero, out q) != 0) return outp;
        try
        {
            var handles = new Dictionary<string, IntPtr>();
            foreach (var n in names) { IntPtr c; if (PdhAddEnglishCounter(q, @"\Memory\" + n, IntPtr.Zero, out c) == 0) handles[n] = c; }
            if (PdhCollectQueryData(q) != 0) return outp;
            foreach (var kv in handles)
            {
                PDH_FMT_COUNTERVALUE_LARGE v;
                if (PdhGetFormattedCounterValue(kv.Value, 0x400 /* PDH_FMT_LARGE */, IntPtr.Zero, out v) == 0) outp[kv.Key] = v.largeValue;
            }
        }
        finally { PdhCloseQuery(q); }
        return outp;
    }

    static long Get(Dictionary<string, long> d, string k) { long v; return d.TryGetValue(k, out v) ? v : -1; }

    static object Mem()
    {
        var m = new MEMORYSTATUSEX();
        GlobalMemoryStatusEx(m);
        PERFORMANCE_INFORMATION pi;
        GetPerformanceInfo(out pi, Marshal.SizeOf(typeof(PERFORMANCE_INFORMATION)));
        long page = pi.PageSize.ToInt64();
        long compressed = 0;
        try { foreach (var p in Process.GetProcessesByName("Memory Compression")) using (p) compressed += p.WorkingSet64; } catch { }
        var pc = Counters("Standby Cache Core Bytes", "Standby Cache Normal Priority Bytes", "Standby Cache Reserve Bytes",
            "Modified Page List Bytes", "Free & Zero Page List Bytes");
        long standby = -1;
        long a = Get(pc, "Standby Cache Core Bytes"), b = Get(pc, "Standby Cache Normal Priority Bytes"), c = Get(pc, "Standby Cache Reserve Bytes");
        if (a >= 0 && b >= 0 && c >= 0) standby = a + b + c;
        return Obj(
            "total", (long)m.ullTotalPhys,
            "available", (long)m.ullAvailPhys,
            "load", (int)m.dwMemoryLoad,
            "commit", pi.CommitTotal.ToInt64() * page,
            "commitLimit", pi.CommitLimit.ToInt64() * page,
            "commitPeak", pi.CommitPeak.ToInt64() * page,
            "kernel", pi.KernelTotal.ToInt64() * page,
            "compressed", compressed,
            "standby", standby,
            "modified", Get(pc, "Modified Page List Bytes"),
            "free", Get(pc, "Free & Zero Page List Bytes"),
            "processes", pi.ProcessCount,
            "threads", pi.ThreadCount,
            "handles", pi.HandleCount);
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder name, ref int size);

    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EmptyWorkingSet(IntPtr h);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    const uint PROCESS_SET_QUOTA = 0x0100;

    static string ImagePath(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return null;
        try
        {
            var sb = new StringBuilder(1024);
            int size = sb.Capacity;
            return QueryFullProcessImageName(h, 0, sb, ref size) ? sb.ToString() : null;
        }
        finally { CloseHandle(h); }
    }

    static object Procs()
    {
        var first = new Dictionary<int, double>();
        foreach (var p in Process.GetProcesses())
        {
            try { first[p.Id] = p.TotalProcessorTime.TotalMilliseconds; } catch { }
            p.Dispose();
        }
        var sw = Stopwatch.StartNew();
        Thread.Sleep(700);
        double elapsed = sw.Elapsed.TotalMilliseconds * Environment.ProcessorCount;
        var info = new Dictionary<string, FileVersionInfo>(StringComparer.OrdinalIgnoreCase);
        var outp = new List<object>();
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                try
                {
                    if (p.Id == 0) continue;
                    double cpu = 0, t0;
                    try { if (first.TryGetValue(p.Id, out t0)) cpu = Math.Max(0, (p.TotalProcessorTime.TotalMilliseconds - t0) / elapsed * 100); } catch { }
                    string path = ImagePath(p.Id);
                    string desc = null, company = null;
                    if (path != null)
                    {
                        FileVersionInfo fv;
                        if (!info.TryGetValue(path, out fv)) { try { fv = FileVersionInfo.GetVersionInfo(path); } catch { fv = null; } info[path] = fv; }
                        if (fv != null) { desc = fv.FileDescription; company = fv.CompanyName; }
                    }
                    outp.Add(Obj("pid", p.Id, "name", p.ProcessName, "ws", p.WorkingSet64, "priv", p.PrivateMemorySize64,
                        "session", p.SessionId, "cpu", Math.Round(cpu, 1), "path", path, "desc", desc, "company", company));
                }
                catch { }
            }
        }
        return outp;
    }

    // Asks every process we may open to hand back pages it is not using right now.
    // Windows pages them back in on demand, so nothing is lost.
    static object Trim()
    {
        ulong before = Avail();
        int ok = 0, skipped = 0;
        int self = Process.GetCurrentProcess().Id;
        foreach (var p in Process.GetProcesses())
        {
            using (p)
            {
                if (p.Id == 0 || p.Id == 4 || p.Id == self) continue;
                IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA, false, p.Id);
                if (h == IntPtr.Zero) { skipped++; continue; }
                if (EmptyWorkingSet(h)) ok++; else skipped++;
                CloseHandle(h);
            }
        }
        Thread.Sleep(600);
        ulong after = Avail();
        return Obj("trimmed", ok, "skipped", skipped, "before", (long)before, "after", (long)after,
            "freed", Math.Max(0L, (long)after - (long)before));
    }

    [DllImport("ntdll.dll")]
    static extern int RtlAdjustPrivilege(int privilege, bool enable, bool currentThread, out bool wasEnabled);

    [DllImport("ntdll.dll")]
    static extern int NtSetSystemInformation(int infoClass, ref int info, int length);

    // Flushes the modified page list and purges the standby list (file cache).
    // Same operation as Sysinternals RAMMap "Empty Standby List". Needs admin.
    static object Purge()
    {
        if (!IsAdmin()) throw new Exception("Run as administrator to clear the standby cache.");
        bool was;
        RtlAdjustPrivilege(13 /* SeProfileSingleProcessPrivilege */, true, false, out was);
        ulong before = Avail();
        int flush = 3, purge = 4; // MemoryFlushModifiedList, MemoryPurgeStandbyList
        int s1 = NtSetSystemInformation(80 /* SystemMemoryListInformation */, ref flush, 4);
        int s2 = NtSetSystemInformation(80, ref purge, 4);
        if (s2 != 0) throw new Exception("Windows refused to clear the standby cache (0x" + s2.ToString("X") + ")");
        Thread.Sleep(400);
        ulong after = Avail();
        return Obj("ok", true, "flushed", s1 == 0, "before", (long)before, "after", (long)after,
            "freed", Math.Max(0L, (long)after - (long)before));
    }

    // ---------------------------------------------------------------- startup apps
    // Enabling/disabling uses the same StartupApproved flags as Task Manager, so
    // nothing is deleted and every change can be flipped back there too.

    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\";
    const string AppModelKey = @"Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData";

    class Source { public string Id, Scope; public RegistryHive Hive; public string Key, Approved, Folder; }

    static List<Source> Sources()
    {
        return new List<Source> {
            new Source { Id = "hkcu-run", Scope = "user", Hive = RegistryHive.CurrentUser, Key = RunKey, Approved = "Run" },
            new Source { Id = "hklm-run", Scope = "machine", Hive = RegistryHive.LocalMachine, Key = RunKey, Approved = "Run" },
            new Source { Id = "hklm-run32", Scope = "machine", Hive = RegistryHive.LocalMachine, Key = @"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", Approved = "Run32" },
            new Source { Id = "user-folder", Scope = "user", Hive = RegistryHive.CurrentUser, Folder = Environment.GetFolderPath(Environment.SpecialFolder.Startup), Approved = "StartupFolder" },
            new Source { Id = "common-folder", Scope = "machine", Hive = RegistryHive.LocalMachine, Folder = Environment.GetFolderPath(Environment.SpecialFolder.CommonStartup), Approved = "StartupFolder" },
        };
    }

    static RegistryKey Base(RegistryHive hive) { return RegistryKey.OpenBaseKey(hive, RegistryView.Registry64); }

    static bool Approved(Source s, string name)
    {
        using (var k = Base(s.Hive).OpenSubKey(ApprovedKey + s.Approved))
        {
            var v = k == null ? null : k.GetValue(name) as byte[];
            return v == null || v.Length == 0 || (v[0] & 1) == 0;
        }
    }

    static string ExeFromCommand(string cmd)
    {
        if (string.IsNullOrEmpty(cmd)) return null;
        cmd = Environment.ExpandEnvironmentVariables(cmd.Trim());
        if (cmd.StartsWith("\"")) { int e = cmd.IndexOf('"', 1); return e > 1 ? cmd.Substring(1, e - 1) : null; }
        int i = cmd.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
        return i > 0 ? cmd.Substring(0, i + 4) : cmd.Split(' ')[0];
    }

    static string ShortcutTarget(string lnk)
    {
        try
        {
            var t = Type.GetTypeFromProgID("WScript.Shell");
            var shell = Activator.CreateInstance(t);
            var sc = t.InvokeMember("CreateShortcut", System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            var target = (string)sc.GetType().InvokeMember("TargetPath", System.Reflection.BindingFlags.GetProperty, null, sc, null);
            Marshal.FinalReleaseComObject(sc); Marshal.FinalReleaseComObject(shell);
            return string.IsNullOrEmpty(target) ? null : target;
        }
        catch { return null; }
    }

    static Dictionary<string, object> Describe(string exe)
    {
        string desc = null, company = null;
        bool exists = false;
        try
        {
            if (exe != null && File.Exists(exe))
            {
                exists = true;
                var fv = FileVersionInfo.GetVersionInfo(exe);
                desc = fv.FileDescription; company = fv.CompanyName;
            }
        }
        catch { }
        return Obj("exe", exe, "desc", desc, "company", company, "exists", exists);
    }

    static object StartupList()
    {
        var outp = new List<object>();
        foreach (var s in Sources())
        {
            if (s.Folder != null)
            {
                if (!Directory.Exists(s.Folder)) continue;
                foreach (var f in Directory.GetFiles(s.Folder))
                {
                    var name = Path.GetFileName(f);
                    if (name.Equals("desktop.ini", StringComparison.OrdinalIgnoreCase)) continue;
                    var exe = name.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ? ShortcutTarget(f) : f;
                    var d = Describe(exe);
                    d["id"] = s.Id + "|" + name; d["name"] = Path.GetFileNameWithoutExtension(name); d["command"] = f;
                    d["source"] = s.Id; d["scope"] = s.Scope; d["enabled"] = Approved(s, name);
                    outp.Add(d);
                }
                continue;
            }
            using (var k = Base(s.Hive).OpenSubKey(s.Key))
            {
                if (k == null) continue;
                foreach (var name in k.GetValueNames())
                {
                    if (name == "") continue;
                    var cmd = Convert.ToString(k.GetValue(name));
                    var d = Describe(ExeFromCommand(cmd));
                    d["id"] = s.Id + "|" + name; d["name"] = name; d["command"] = cmd;
                    d["source"] = s.Id; d["scope"] = s.Scope; d["enabled"] = Approved(s, name);
                    outp.Add(d);
                }
            }
        }
        // Microsoft Store apps register startup tasks separately.
        using (var root = Registry.CurrentUser.OpenSubKey(AppModelKey))
        {
            if (root != null)
            {
                foreach (var pkg in root.GetSubKeyNames())
                {
                    using (var pk = root.OpenSubKey(pkg))
                    {
                        if (pk == null) continue;
                        foreach (var task in pk.GetSubKeyNames())
                        {
                            using (var tk = pk.OpenSubKey(task))
                            {
                                var st = tk == null ? null : tk.GetValue("State");
                                if (!(st is int)) continue;
                                int state = (int)st;
                                var pretty = pkg.Split('_')[0];
                                pretty = pretty.Substring(pretty.LastIndexOf('.') + 1);
                                outp.Add(Obj("id", "store|" + pkg + "|" + task, "name", pretty, "command", pkg, "source", "store",
                                    "scope", "user", "enabled", state == 2 || state == 4, "locked", state == 3 || state == 4,
                                    "exe", null, "desc", null, "company", pkg.Split('_')[0].Split('.')[0], "exists", true, "pkg", pkg));
                            }
                        }
                    }
                }
            }
        }
        return outp;
    }

    static object StartupSet(Dictionary<string, object> input)
    {
        string id = (string)input["id"];
        bool enable = Convert.ToBoolean(input["enabled"]);
        var parts = id.Split('|');
        try
        {
            if (parts[0] == "store")
            {
                using (var k = Registry.CurrentUser.OpenSubKey(AppModelKey + "\\" + parts[1] + "\\" + parts[2], true))
                {
                    if (k == null) throw new Exception("Startup task not found. Refresh and try again.");
                    var cur = k.GetValue("State");
                    if (cur is int && ((int)cur == 3 || (int)cur == 4)) throw new Exception("This item is controlled by your organisation's policy.");
                    k.SetValue("State", enable ? 2 : 1, RegistryValueKind.DWord);
                }
                return Obj("ok", true);
            }
            var s = Sources().FirstOrDefault(x => x.Id == parts[0]);
            if (s == null || parts.Length < 2) throw new Exception("Unknown startup item.");
            string name = id.Substring(parts[0].Length + 1);
            using (var k = Base(s.Hive).CreateSubKey(ApprovedKey + s.Approved))
            {
                var bytes = new byte[12];
                bytes[0] = (byte)(enable ? 2 : 3);
                if (!enable) Array.Copy(BitConverter.GetBytes(DateTime.UtcNow.ToFileTimeUtc()), 0, bytes, 4, 8);
                k.SetValue(name, bytes, RegistryValueKind.Binary);
            }
            return Obj("ok", true);
        }
        catch (UnauthorizedAccessException)
        {
            throw new Exception("This item is installed for all users. Restart Storage Cleaner as administrator to change it.");
        }
        catch (System.Security.SecurityException)
        {
            throw new Exception("This item is installed for all users. Restart Storage Cleaner as administrator to change it.");
        }
    }

    // ---------------------------------------------------------------- performance settings
    // Every tweak is reversible and only uses documented user-level switches
    // (the same ones the Settings app writes), except hibernation, which needs admin.

    [DllImport("powrprof.dll")]
    static extern uint PowerGetEffectiveOverlayScheme(out Guid g);

    [DllImport("powrprof.dll")]
    static extern uint PowerSetActiveOverlayScheme(Guid g);

    static readonly Guid BestPerformance = new Guid("ded574b5-45a0-4f42-8737-46345c09c238");

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SystemParametersInfo(uint action, uint uParam, ref int pv, uint winIni);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SystemParametersInfo(uint action, uint uParam, IntPtr pv, uint winIni);

    [StructLayout(LayoutKind.Sequential)]
    struct ANIMATIONINFO { public uint cbSize; public int iMinAnimate; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SystemParametersInfo(uint action, uint uParam, ref ANIMATIONINFO pv, uint winIni);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);

    static void Broadcast(string area)
    {
        UIntPtr r;
        SendMessageTimeout((IntPtr)0xffff, 0x1A /* WM_SETTINGCHANGE */, UIntPtr.Zero, area, 2 /* ABORTIFHUNG */, 1000, out r);
    }

    static object RegGet(string key, string name)
    {
        using (var k = Registry.CurrentUser.OpenSubKey(key)) return k == null ? null : k.GetValue(name);
    }

    static void RegSet(string key, string name, int value)
    {
        using (var k = Registry.CurrentUser.CreateSubKey(key)) k.SetValue(name, value, RegistryValueKind.DWord);
    }

    static int RegInt(string key, string name, int fallback)
    {
        var v = RegGet(key, name);
        return v is int ? (int)v : fallback;
    }

    const string PersonalizeKey = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const string BgKey = @"Software\Microsoft\Windows\CurrentVersion\BackgroundAccessApplications";
    const string SearchKey = @"Software\Microsoft\Windows\CurrentVersion\Search";
    const string CdmKey = @"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";
    const string SenseKey = @"Software\Microsoft\Windows\CurrentVersion\StorageSense\Parameters\StoragePolicy";
    static readonly string[] TipValues = { "SubscribedContent-338389Enabled", "SubscribedContent-338388Enabled", "SubscribedContent-310093Enabled",
        "SubscribedContent-353698Enabled", "SystemPaneSuggestionsEnabled", "SoftLandingEnabled" };

    static string Hiberfil() { return Path.Combine(Path.GetPathRoot(Environment.SystemDirectory), "hiberfil.sys"); }

    static object Tweaks()
    {
        var outp = new List<object>();

        Guid overlay;
        bool powerOk = true, powerOn = false;
        try { powerOk = PowerGetEffectiveOverlayScheme(out overlay) == 0; powerOn = powerOk && overlay == BestPerformance; }
        catch { powerOk = false; }
        outp.Add(Obj("id", "power", "on", powerOn, "available", powerOk));

        outp.Add(Obj("id", "transparency", "on", RegInt(PersonalizeKey, "EnableTransparency", 1) == 0, "available", true));

        int anim = 1;
        SystemParametersInfo(0x1042 /* SPI_GETCLIENTAREAANIMATION */, 0, ref anim, 0);
        outp.Add(Obj("id", "animations", "on", anim == 0, "available", true));

        outp.Add(Obj("id", "bgapps", "on", RegInt(BgKey, "GlobalUserDisabled", 0) == 1, "available", true));

        outp.Add(Obj("id", "tips", "on", TipValues.All(v => RegInt(CdmKey, v, 1) == 0), "available", true));

        outp.Add(Obj("id", "storagesense", "on", RegInt(SenseKey, "01", 0) == 1, "available", true));

        long hib = 0;
        try { var fi = new FileInfo(Hiberfil()); if (fi.Exists) hib = fi.Length; } catch { }
        bool hibExists = File.Exists(Hiberfil());
        outp.Add(Obj("id", "hibernate", "on", !hibExists, "available", true, "size", hib));

        return outp;
    }

    static object TweakSet(Dictionary<string, object> input)
    {
        string id = (string)input["id"];
        bool on = Convert.ToBoolean(input["on"]);
        switch (id)
        {
            case "power":
                uint r = PowerSetActiveOverlayScheme(on ? BestPerformance : Guid.Empty);
                if (r != 0) throw new Exception("Windows did not accept the power mode change (" + r + ").");
                break;
            case "transparency":
                RegSet(PersonalizeKey, "EnableTransparency", on ? 0 : 1);
                Broadcast("ImmersiveColorSet");
                break;
            case "animations":
                // SPI_SETCLIENTAREAANIMATION, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
                SystemParametersInfo(0x1043, 0, on ? IntPtr.Zero : (IntPtr)1, 3);
                var ai = new ANIMATIONINFO { cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO)), iMinAnimate = on ? 0 : 1 };
                SystemParametersInfo(0x0049 /* SPI_SETANIMATION */, ai.cbSize, ref ai, 3);
                break;
            case "bgapps":
                RegSet(BgKey, "GlobalUserDisabled", on ? 1 : 0);
                RegSet(SearchKey, "BackgroundAppGlobalToggle", on ? 0 : 1);
                break;
            case "tips":
                foreach (var v in TipValues) RegSet(CdmKey, v, on ? 0 : 1);
                break;
            case "storagesense":
                RegSet(SenseKey, "01", on ? 1 : 0);
                break;
            case "hibernate":
                if (!IsAdmin()) throw new Exception("Restart Storage Cleaner as administrator to change hibernation.");
                var psi = new ProcessStartInfo("powercfg.exe", on ? "/hibernate off" : "/hibernate on")
                    { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
                using (var p = Process.Start(psi))
                {
                    string err = p.StandardError.ReadToEnd() + p.StandardOutput.ReadToEnd();
                    p.WaitForExit();
                    if (p.ExitCode != 0) throw new Exception(err.Trim().Length > 0 ? err.Trim() : "powercfg failed");
                }
                break;
            default:
                throw new Exception("Unknown setting.");
        }
        return Obj("ok", true);
    }
}
