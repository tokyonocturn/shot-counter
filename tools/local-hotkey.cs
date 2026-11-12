using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Local hotkey agent for Shot Counter.
//
// It asks Windows for one global hotkey with RegisterHotKey and posts a single
// HTTP request to the local counter when that combination is pressed.
//
// There is no keyboard hook, no key state polling, no injected input and no key
// logging: Windows itself owns the shortcut and delivers one WM_HOTKEY message.
// Same mechanism OBS uses for its own hotkeys, which is why the counter works
// with OBS closed.
internal static class Program
{
    private const int WmHotkey = 0x0312;
    private const uint ModNorepeat = 0x4000;
    private const uint DefaultKey = 0x78; // F9

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr Hwnd;
        public uint Message;
        public IntPtr WParam;
        public IntPtr LParam;
        public uint Time;
        public int X;
        public int Y;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint virtualKey);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Msg msg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg msg);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg msg);

    private static string url = "http://127.0.0.1:4321/api/shot";
    private static uint key = DefaultKey;
    private static bool watchServer = true;

    private static void Main(string[] args)
    {
        bool keyGiven = false;
        bool urlGiven = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--key" && i + 1 < args.Length)
            {
                key = ToVirtualKey(args[i + 1]);
                keyGiven = true;
            }
            else if (args[i] == "--url" && i + 1 < args.Length)
            {
                url = args[i + 1];
                urlGiven = true;
            }
            else if (args[i] == "--no-watch") watchServer = false;
            else if (args[i] == "--help" || args[i] == "-h")
            {
                Console.WriteLine("shot-counter-hotkey [--key F9] [--url http://127.0.0.1:4321/api/shot] [--no-watch]");
                Console.WriteLine("Without --key the key is read from config.json (localHotkey.key).");
                Console.WriteLine("The agent exits by itself when the Shot Counter app stops answering.");
                return;
            }
        }

        if (!keyGiven) key = KeyFromConfig();
        if (!urlGiven) url = "http://127.0.0.1:" + PortFromConfig() + "/api/shot";

        bool first;
        using (var single = new Mutex(true, "ShotCounterLocalHotkey", out first))
        {
            if (!first)
            {
                Console.Error.WriteLine("A local hotkey agent is already running.");
                return;
            }

            if (watchServer) StartServerWatch();

            // Another program (often OBS, with the same key) can own the shortcut.
            // Keep asking, so closing that program is enough to make this work.
            int attempts = 0;
            while (!RegisterHotKey(IntPtr.Zero, 1, ModNorepeat, key))
            {
                int code = Marshal.GetLastWin32Error();
                attempts++;
                if (attempts == 1 || attempts % 6 == 0)
                {
                    Console.Error.WriteLine("Windows refused the hotkey (error " + code + "). Another program owns it. Retrying every 10 seconds.");
                }
                Thread.Sleep(10000);
            }

            Console.WriteLine("Shot Counter local hotkey agent");
            Console.WriteLine("  key : " + KeyName(key));
            Console.WriteLine("  post: " + url);
            Console.WriteLine("Press Ctrl+C to stop.");

            Msg msg;
            while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0)
            {
                if (msg.Message == WmHotkey) Press();
                TranslateMessage(ref msg);
                DispatchMessage(ref msg);
            }

            UnregisterHotKey(IntPtr.Zero, 1);
        }
    }

    // The agent is a companion of the app, not a background service. It asks the
    // app's own status endpoint whether it is still there; when the app stops, the
    // agent leaves too, so closing the batch window never leaves anything behind.
    // This checks the app, never the keyboard.
    private static void StartServerWatch()
    {
        string baseUrl = url;
        int cut = baseUrl.IndexOf("/api/");
        if (cut > 0) baseUrl = baseUrl.Substring(0, cut);

        var thread = new Thread(delegate()
        {
            bool everUp = false;
            int misses = 0;

            while (true)
            {
                try
                {
                    var request = (HttpWebRequest)WebRequest.Create(baseUrl + "/api/state");
                    request.Method = "GET";
                    request.Timeout = 900;
                    using (var response = (HttpWebResponse)request.GetResponse())
                    {
                        response.Close();
                    }
                    everUp = true;
                    misses = 0;
                }
                catch
                {
                    if (everUp)
                    {
                        misses++;
                        if (misses >= 2)
                        {
                            Console.Error.WriteLine("Shot Counter stopped, closing the hotkey agent.");
                            Environment.Exit(0);
                        }
                    }
                }
                Thread.Sleep(1000);
            }
        });
        thread.IsBackground = true;
        thread.Start();
    }

    private static int PortFromConfig()
    {
        string text = ConfigText();
        if (text == null) return 4321;
        Match match = Regex.Match(text, "\"port\"\\s*:\\s*(\\d+)");
        if (match.Success)
        {
            int port;
            if (int.TryParse(match.Groups[1].Value, out port) && port > 0 && port < 65536) return port;
        }
        return 4321;
    }

    private static string ConfigText()
    {
        string[] candidates = new string[]
        {
            Path.Combine(Environment.CurrentDirectory, "config.json"),
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "config.json"),
            Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "config.json"),
        };

        foreach (string path in candidates)
        {
            try
            {
                if (File.Exists(path)) return File.ReadAllText(path);
            }
            catch
            {
            }
        }
        return null;
    }

    private static uint KeyFromConfig()
    {
        string text = ConfigText();
        if (text == null) return DefaultKey;

        Match match = Regex.Match(
            text,
            "\"localHotkey\"\\s*:\\s*\\{[^}]*?\"key\"\\s*:\\s*\"([^\"]+)\"",
            RegexOptions.IgnoreCase | RegexOptions.Singleline);
        if (match.Success) return ToVirtualKey(match.Groups[1].Value);
        return DefaultKey;
    }

    private static void Press()
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.Method = "POST";
            request.ContentType = "application/json";
            request.Timeout = 1500;
            byte[] body = Encoding.UTF8.GetBytes("{\"source\":\"local-hotkey\"}");
            request.ContentLength = body.Length;
            using (var stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
            using (var response = (HttpWebResponse)request.GetResponse())
            {
                response.Close();
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("shot not sent: " + error.Message);
        }
    }

    private static uint ToVirtualKey(string name)
    {
        string key = name.Trim().ToUpperInvariant().Replace("OBS_KEY_", "").Replace("VK_", "");
        switch (key)
        {
            case "INSERT": case "INS": return 0x2D;
            case "DELETE": case "DEL": return 0x2E;
            case "HOME": return 0x24;
            case "END": return 0x23;
            case "PAGEUP": case "PGUP": return 0x21;
            case "PAGEDOWN": case "PGDN": return 0x22;
            case "SPACE": return 0x20;
            case "ENTER": case "RETURN": return 0x0D;
            case "TAB": return 0x09;
            case "BACKSPACE": return 0x08;
            case "PAUSE": return 0x13;
            case "SCROLLLOCK": return 0x91;
            case "PRINTSCREEN": case "SNAPSHOT": return 0x2C;
            case "NUMPAD0": return 0x60;
            case "NUMPAD1": return 0x61;
            case "NUMPAD2": return 0x62;
            case "NUMPAD3": return 0x63;
            case "NUMPAD4": return 0x64;
            case "NUMPAD5": return 0x65;
            case "NUMPAD6": return 0x66;
            case "NUMPAD7": return 0x67;
            case "NUMPAD8": return 0x68;
            case "NUMPAD9": return 0x69;
        }

        if (key.Length > 1 && key[0] == 'F')
        {
            int number;
            if (int.TryParse(key.Substring(1), out number) && number >= 1 && number <= 24) return (uint)(0x70 + number - 1);
        }
        if (key.Length == 1)
        {
            char c = key[0];
            if (c >= 'A' && c <= 'Z') return c;
            if (c >= '0' && c <= '9') return c;
        }
        return DefaultKey;
    }

    private static string KeyName(uint vk)
    {
        if (vk >= 0x70 && vk <= 0x87) return "F" + (vk - 0x70 + 1);
        if (vk >= 0x60 && vk <= 0x69) return "Numpad" + (vk - 0x60);
        switch (vk)
        {
            case 0x2D: return "Insert";
            case 0x2E: return "Delete";
            case 0x24: return "Home";
            case 0x23: return "End";
            case 0x21: return "PageUp";
            case 0x22: return "PageDown";
            case 0x20: return "Space";
            case 0x0D: return "Enter";
            case 0x09: return "Tab";
            case 0x08: return "Backspace";
            case 0x13: return "Pause";
            case 0x91: return "ScrollLock";
            case 0x2C: return "PrintScreen";
        }
        if ((vk >= 'A' && vk <= 'Z') || (vk >= '0' && vk <= '9')) return ((char)vk).ToString();
        return "VK 0x" + vk.ToString("X2");
    }
}
