import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import zipfile


SIZE_LIMIT = 256 * 1024 * 1024
ENTRY_LIMIT = 20000
PROBE = r"""
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const assert = require('node:assert/strict');
const [outside, port] = process.argv.slice(1);
fs.writeFileSync('/work/probe.txt', 'ok');
assert.throws(() => fs.readFileSync(outside));
assert.throws(() => fs.writeFileSync(outside, 'changed'));
assert.equal(fs.existsSync('/mnt/c'), false);
assert.equal(fs.existsSync('/init'), false);
assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s+([0-9a-f]+)/m)[1], '0000000000000000');
assert(Object.values(os.networkInterfaces()).flat().every(address => address.internal));
const client = net.connect(Number(port), '127.0.0.1');
client.on('connect', () => process.exit(1));
client.on('error', () => client.destroy());
client.setTimeout(2000, () => process.exit(2));
"""


def unpack(data, work):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > ENTRY_LIMIT or sum(item.file_size for item in entries) > SIZE_LIMIT:
            raise ValueError("工作副本超过隔离门禁的传输上限")
        for item in entries:
            name = item.filename if item.flag_bits & 0x800 else item.filename.encode("cp437").decode("utf-8")
            relative = PurePosixPath(name)
            if (not relative.parts or relative.is_absolute() or "\\" in name
                    or any(part.lower() in ("..", ".git", ".ai-review") for part in relative.parts)
                    or stat.S_ISLNK(item.external_attr >> 16)):
                raise ValueError("工作副本包含越界路径或链接")
            destination = work.joinpath(*relative.parts)
            if item.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)


def run_sandbox(node, work, command):
    args = [
        "/usr/bin/bwrap", "--unshare-all", "--unshare-user", "--unshare-net",
        "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
        "--setenv", "PATH", "/runtime/bin:/usr/bin", "--setenv", "LANG", "C.UTF-8",
        "--setenv", "TMPDIR", "/tmp",
        "--ro-bind", "/usr/bin", "/usr/bin", "--ro-bind", "/usr/lib", "/usr/lib",
        "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--ro-bind", "/lib64", "/lib64",
        "--ro-bind", str(node), "/runtime/bin/node",
        "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", str(work), "/work", "--chdir", "/work", "--", *command,
    ]
    child = subprocess.Popen(args, stdin=subprocess.DEVNULL, start_new_session=True)

    def stop():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def watch_bridge():
        os.read(0, 1)
        stop()

    threading.Thread(target=watch_bridge, daemon=True).start()
    try:
        return_code = child.wait(timeout=3600)
        return return_code if return_code >= 0 else 125
    except subprocess.TimeoutExpired:
        stop()
        child.wait()
        return 124


def main():
    node = Path(sys.argv[1]).resolve(strict=True)
    if not node.is_file() or node.name != "node" or node.parent.name != "bin" or str(node).startswith("/mnt/"):
        raise ValueError("Node 必须安装在受信的 WSL 文件系统上")
    header = sys.stdin.buffer.read(8)
    command_size, archive_size = struct.unpack("<II", header)
    if command_size > 16384 or archive_size > SIZE_LIMIT or bool(command_size) != bool(archive_size):
        raise ValueError("无效的门禁传输包")
    command = sys.stdin.buffer.read(command_size)
    data = sys.stdin.buffer.read(archive_size)
    if len(command) != command_size or len(data) != archive_size:
        raise ValueError("门禁传输中断")
    with tempfile.TemporaryDirectory(prefix="dsh-wsl-audit-", dir="/tmp") as directory:
        work = Path(directory) / "work"
        work.mkdir()
        if command_size:
            unpack(data, work)
            print("WSL 隔离门禁传输包 sha256=" + hashlib.sha256(data).hexdigest(), flush=True)
            return run_sandbox(node, work, ["/usr/bin/sh", "-c", command.decode("utf-8")])
        marker = Path(directory) / "outside.txt"
        marker.write_text("outside", encoding="utf-8")
        with socket.socket() as peer:
            peer.bind(("127.0.0.1", 0))
            peer.listen()
            result = run_sandbox(node, work, ["/runtime/bin/node", "-e", PROBE, str(marker), str(peer.getsockname()[1])])
        if result == 0 and (work / "probe.txt").read_text() == "ok" and marker.read_text() == "outside":
            print("隔离自检通过：副本可写，副本外读写和宿主 TCP 被拒绝")
            return 0
        return result or 125


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, struct.error, zipfile.BadZipFile) as error:
        print("WSL 隔离门禁：" + str(error), file=sys.stderr)
        sys.exit(125)
