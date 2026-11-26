// A native window around the local panel. The panel itself is the same HTML the browser
// showed; this exe gives it a real place on the desktop: its own icon and title, a menu
// for reload/devtools/quit, and it starts Agents-MCP.exe itself, so one double-click is the
// whole story and closing the window stops the service it started.
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace AgentsMcp;

internal static class Program
{
    private const string PanelTitle = "Agents-MCP 控制台";

    [STAThread]
    private static int Main(string[] args)
    {
        string? portArg = Option(args, "--port");
        string? stateDirArg = Option(args, "--state-dir");
        string? serviceArg = Option(args, "--service");
        bool browser = args.Contains("--browser");
        bool check = args.Contains("--check");

        string service = string.IsNullOrEmpty(serviceArg)
            ? Path.Combine(AppContext.BaseDirectory, "Agents-MCP.exe")
            : Path.GetFullPath(serviceArg);
        if (check)
        {
            if (!File.Exists(service)) { Console.Error.WriteLine("Agents-MCP.exe not found: " + service); return 2; }
            try
            {
                if (CoreWebView2Environment.GetAvailableBrowserVersionString() is null) { Console.Error.WriteLine("WebView2 runtime not found."); return 3; }
            }
            catch (Exception error) { Console.Error.WriteLine("WebView2 runtime not found: " + error.Message); return 3; }
            Console.Out.WriteLine("Agents-MCP panel OK");
            return 0;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new PanelForm(service, portArg, stateDirArg, browser));
        return 0;
    }

    private static string? Option(string[] args, string name)
    {
        int index = Array.IndexOf(args, name);
        if (index >= 0 && index + 1 < args.Length) return args[index + 1];
        string prefix = name + "=";
        return args.FirstOrDefault(a => a.StartsWith(prefix, StringComparison.Ordinal))?[prefix.Length..];
    }

    private sealed class PanelForm : Form
    {
        private readonly string service;
        private readonly string? portArg;
        private readonly string? stateDirArg;
        private readonly bool browser;
        private readonly WebView2 web = new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.White };
        private readonly Label status = new()
        {
            Dock = DockStyle.Bottom, Height = 26, TextAlign = ContentAlignment.MiddleLeft,
            Padding = new Padding(10, 0, 10, 0), Text = "正在启动 Agents-MCP…",
        };
        private Process? child;
        private int port;
        private bool quitting;

        public PanelForm(string service, string? portArg, string? stateDirArg, bool browser)
        {
            this.service = service;
            this.portArg = portArg;
            this.stateDirArg = stateDirArg;
            this.browser = browser;

            Text = PanelTitle;
            Width = 1360;
            Height = 900;
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Color.FromArgb(240, 242, 245);

            Controls.Add(web);
            Controls.Add(status);

            var menu = new MenuStrip { RenderMode = ToolStripRenderMode.System, Padding = new Padding(4, 1, 4, 1) };
            var view = new ToolStripMenuItem("面板");
            view.DropDownItems.Add("重新载入", null, (_, _) => web.CoreWebView2?.Reload());
            view.DropDownItems.Add("开发者工具", null, (_, _) => web.CoreWebView2?.OpenDevToolsWindow());
            view.DropDownItems.Add(new ToolStripSeparator());
            view.DropDownItems.Add("在浏览器中打开", null, async (_, _) =>
            {
                if (port > 0) await Launch("cmd.exe", "/c start \"\" http://127.0.0.1:" + port + "/");
            });
            var serviceMenu = new ToolStripMenuItem("服务");
            serviceMenu.DropDownItems.Add("停止服务并退出", null, async (_, _) => await Shutdown());
            var help = new ToolStripMenuItem("帮助");
            help.DropDownItems.Add("关于", null, (_, _) => MessageBox.Show(
                "Agents-MCP 桌面面板" + Environment.NewLine + "窗口只是界面，服务由 Agents-MCP.exe 提供。",
                "关于", MessageBoxButtons.OK, MessageBoxIcon.Information));
            menu.Items.AddRange(new ToolStripItem[] { view, serviceMenu, help });
            MainMenuStrip = menu;
            Controls.Add(menu);

            Load += async (_, _) => await StartAsync();
            FormClosing += (_, e) =>
            {
                // Closing the window stops the service this window started. A service that
                // was already running belongs to whoever started it and is left alone.
                if (quitting || child is null) return;
                e.Cancel = true;
                _ = Shutdown();
            };
        }

        private async Task StartAsync()
        {
            var serviceArgs = new List<string> { "--no-open" };
            if (!string.IsNullOrEmpty(portArg)) serviceArgs.AddRange(new[] { "--port", portArg });
            if (!string.IsNullOrEmpty(stateDirArg)) serviceArgs.AddRange(new[] { "--state-dir", stateDirArg });
            var psi = new ProcessStartInfo(service, string.Join(' ', serviceArgs.Select(Quote)))
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = AppContext.BaseDirectory,
            };
            child = new Process { StartInfo = psi, EnableRaisingEvents = true };
            child.Exited += (_, _) =>
            {
                if (quitting || IsDisposed) return;
                BeginInvoke(() => status.Text = "Agents-MCP.exe 已退出。关闭此窗口后重新打开即可。");
            };
            try { child.Start(); }
            catch (Exception error)
            {
                status.Text = "无法启动 Agents-MCP.exe：" + error.Message;
                return;
            }

            port = await WaitForService(int.TryParse(portArg, out var wanted) ? wanted : 0);
            if (port == 0)
            {
                status.Text = "Agents-MCP 服务没有启动。日志在 <状态目录>/launcher.log。";
                return;
            }
            status.Text = "服务地址 http://127.0.0.1:" + port + "/　·　关闭此窗口会停止服务";
            if (browser)
            {
                await Launch("cmd.exe", "/c start \"\" http://127.0.0.1:" + port + "/");
                await Shutdown();
                return;
            }
            await InitializeWebView();
        }

        // The launcher walks forward from the configured port when that one is taken, so the
        // only reliable way to learn where the panel ended up is to read it back from the
        // running service.
        private async Task<int> WaitForService(int expected)
        {
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            var candidates = expected > 0 ? new[] { expected } : Enumerable.Range(4870, 12).ToArray();
            for (var attempt = 0; attempt < 120; attempt++)
            {
                if (child?.HasExited == true) return 0;
                foreach (var candidate in candidates)
                {
                    try
                    {
                        var body = await http.GetStringAsync("http://127.0.0.1:" + candidate + "/api/config");
                        if (body.Contains("\"gate\"")) return candidate;
                    }
                    catch { /* not up yet, or somebody else's server */ }
                }
                await Task.Delay(500);
            }
            return 0;
        }

        private async Task InitializeWebView()
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Agents-MCP", "webview-profile");
            Directory.CreateDirectory(userData);
            var environment = await CoreWebView2Environment.CreateAsync(null, userData);
            await web.EnsureCoreWebView2Async(environment);
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.NewWindowRequested += (_, e) =>
            {
                // Links to GitHub and the like belong in the browser, not in a second panel.
                e.Handled = true;
                _ = Launch("cmd.exe", "/c start \"\" " + Quote(e.Uri));
            };
            web.CoreWebView2.NavigationCompleted += (_, e) =>
            {
                if (quitting) return;
                status.Text = e.IsSuccess
                    ? "服务地址 http://127.0.0.1:" + port + "/　·　关闭此窗口会停止服务"
                    : "面板加载失败（" + e.WebErrorStatus + "）。用「面板 → 重新载入」再试。";
            };
            web.CoreWebView2.Navigate("http://127.0.0.1:" + port + "/");
        }

        private async Task Shutdown()
        {
            if (quitting) return;
            quitting = true;
            try
            {
                using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
                await http.PostAsync("http://127.0.0.1:" + port + "/api/shutdown", new StringContent("{}", System.Text.Encoding.UTF8, "application/json"));
            }
            catch { }
            try { if (child is { HasExited: false }) child.Kill(entireProcessTree: true); } catch { }
            Close();
        }

        private static string Quote(string value) =>
            value.Contains(' ') ? "\"" + value.Replace("\"", "\\\"") + "\"" : value;

        private static async Task Launch(string command, string arguments)
        {
            try
            {
                using var process = Process.Start(new ProcessStartInfo(command, arguments) { UseShellExecute = false, CreateNoWindow = true });
                if (process is not null) await process.WaitForExitAsync();
            }
            catch { }
        }
    }
}
