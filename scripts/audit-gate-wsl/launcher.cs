using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

internal static class Launcher {
    private const int SizeLimit = 256 * 1024 * 1024;
    private const int EntryLimit = 20000;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly DateTimeOffset ArchiveTime = new DateTimeOffset(1980, 1, 1, 0, 0, 0, TimeSpan.Zero);

    private static void RequireOrdinaryPath(FileSystemInfo entry) {
        if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("门禁工作副本含 Windows 重解析点：" + entry.Name);
    }

    private static void Pack(ZipArchive zip, DirectoryInfo folder, string prefix, ref int count, ref long size) {
        RequireOrdinaryPath(folder);
        foreach (var entry in folder.EnumerateFileSystemInfos().OrderBy(item => item.Name, StringComparer.Ordinal)) {
            if (entry.Name.Equals(".git", StringComparison.OrdinalIgnoreCase) ||
                entry.Name.Equals(".ai-review", StringComparison.OrdinalIgnoreCase)) continue;
            RequireOrdinaryPath(entry);
            if (++count > EntryLimit) throw new IOException("门禁文件数超出上限");
            var relative = prefix + entry.Name;
            var subfolder = entry as DirectoryInfo;
            if (subfolder != null) {
                zip.CreateEntry(relative + "/").LastWriteTime = ArchiveTime;
                Pack(zip, subfolder, relative + "/", ref count, ref size);
            } else {
                using (var input = new FileStream(entry.FullName, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                    size += input.Length;
                    if (size > SizeLimit) throw new IOException("门禁工作副本超出 256 MiB");
                    var file = zip.CreateEntry(relative, CompressionLevel.Fastest);
                    file.LastWriteTime = ArchiveTime;
                    using (var output = file.Open()) input.CopyTo(output);
                }
            }
        }
    }

    private static void WriteRequest(Stream stdin, bool probe, string work, string command) {
        var bytes = Utf8.GetBytes(command);
        if (bytes.Length > 16384 || command.IndexOf('\0') >= 0) throw new ArgumentException("门禁命令非法");
        using (var archive = new MemoryStream()) {
            if (!probe) {
                var folder = new DirectoryInfo(work);
                if (folder.Name != "work" || folder.Parent == null ||
                    !Regex.IsMatch(folder.Parent.Name, @"^dsh-audit-(?:cli|gates)-[a-zA-Z0-9-]+$"))
                    throw new ArgumentException("需要 Host 创建的审查专用工作副本");
                for (var parent = folder; parent != null; parent = parent.Parent) RequireOrdinaryPath(parent);
                int count = 0;
                long size = 0;
                using (var zip = new ZipArchive(archive, ZipArchiveMode.Create, true, Utf8))
                    Pack(zip, folder, "", ref count, ref size);
                if (archive.Length > SizeLimit) throw new IOException("门禁传输包超出 256 MiB");
            }
            var header = new BinaryWriter(stdin, Utf8, true);
            header.Write(bytes.Length);
            header.Write((int)archive.Length);
            header.Write(bytes);
            header.Flush();
            archive.Position = 0;
            archive.CopyTo(stdin);
            stdin.Flush();
        }
    }

    private static int Main(string[] args) {
        try {
            Console.InputEncoding = Utf8;
            bool probe = args.Length == 1 && args[0] == "--probe";
            if (!probe && (args.Length != 2 || !Regex.IsMatch(args[0], @"^[A-Za-z]:[\\/]") || String.IsNullOrWhiteSpace(args[1])))
                throw new ArgumentException("用法：launcher.exe <Host 工作副本绝对路径> <门禁命令>，或 launcher.exe --probe");
            var install = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            var config = File.ReadAllLines(Path.Combine(install.FullName, "settings.txt"), Utf8);
            if (config.Length != 2 || !Regex.IsMatch(config[0], @"^[A-Za-z0-9._-]+$") ||
                !Regex.IsMatch(config[1], @"^/(?:[A-Za-z0-9._-]+/)*bin/node$"))
                throw new IOException("WSL 门禁安装配置非法");
            var script = File.ReadAllBytes(Path.Combine(install.FullName, "gate.py"));
            if (script.Length == 0 || script.Length > 65536) throw new IOException("WSL 门禁脚本大小非法");
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "wsl.exe"),
                "--distribution " + config[0] + " --exec /usr/bin/python3 -u -c \"import sys; n=int(sys.argv.pop(1)); " +
                "exec(compile(sys.stdin.buffer.read(n), 'dsh-audit-gate', 'exec'))\" " + script.Length + " " + config[1]);
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (var child = Process.Start(start)) {
                var stdout = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
                var stderr = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
                using (var stdin = child.StandardInput.BaseStream) {
                    stdin.Write(script, 0, script.Length);
                    WriteRequest(stdin, probe, probe ? "" : Path.GetFullPath(args[0]), probe ? "" : args[1]);
                    if (!child.WaitForExit(3610000)) {
                        stdin.Close();
                        if (!child.WaitForExit(3000)) child.Kill();
                        return 124;
                    }
                    Task.WaitAll(stdout, stderr);
                    return child.ExitCode;
                }
            }
        } catch (Exception error) {
            Console.Error.WriteLine("WSL 隔离门禁：" + error.Message);
            return 125;
        }
    }
}
