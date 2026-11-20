import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const python = process.platform === 'win32' ? 'python.exe' : 'python3';
const available = spawnSync(python, ['--version'], { encoding: 'utf8' }).status === 0;

test('WSL 门禁保留未标记的 UTF-8 ZIP 文件名并拒绝越界路径', { skip: !available }, () => {
    const source = [
        'import importlib.util, io, pathlib, struct, tempfile, zipfile',
        'spec = importlib.util.spec_from_file_location("gate", "scripts/audit-gate-wsl/gate.py")',
        'gate = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(gate)',
        'data = io.BytesIO()',
        'with zipfile.ZipFile(data, "w") as archive:',
        '    archive.writestr("nested/重试.txt", "ok")',
        'raw = bytearray(data.getvalue())',
        'for signature, offset in [(b"PK\\x03\\x04", 6), (b"PK\\x01\\x02", 8)]:',
        '    at = raw.index(signature) + offset',
        '    flags = struct.unpack_from("<H", raw, at)[0]',
        '    struct.pack_into("<H", raw, at, flags & ~0x800)',
        'with tempfile.TemporaryDirectory() as folder:',
        '    gate.unpack(bytes(raw), pathlib.Path(folder))',
        '    assert (pathlib.Path(folder)/"nested"/"重试.txt").read_text() == "ok"',
        'for name in ["../escape", "/absolute", ".git/config", ".ai-review/draft"]:',
        '    data = io.BytesIO()',
        '    with zipfile.ZipFile(data, "w") as archive:',
        '        archive.writestr(name, "bad")',
        '    with tempfile.TemporaryDirectory() as folder:',
        '        try:',
        '            gate.unpack(data.getvalue(), pathlib.Path(folder))',
        '        except ValueError:',
        '            continue',
        '        raise AssertionError("accepted " + name)',
        'print("archive validation passed")',
    ].join('\n');
    const result = spawnSync(python, ['-B', '-c', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /archive validation passed/);
});

test('WSL 门禁仅绑定 Node 文件，强制隔离网络并清空环境', { skip: !available }, () => {
    const source = [
        'import importlib.util, pathlib',
        'spec = importlib.util.spec_from_file_location("gate", "scripts/audit-gate-wsl/gate.py")',
        'gate = importlib.util.module_from_spec(spec)',
        'spec.loader.exec_module(gate)',
        'calls = []',
        'class Process:',
        '    pid = 42',
        '    def wait(self, timeout): return 0',
        'class Thread:',
        '    def __init__(self, **kwargs): pass',
        '    def start(self): pass',
        'gate.subprocess.Popen = lambda args, **kwargs: (calls.append((args, kwargs)) or Process())',
        'gate.threading.Thread = Thread',
        'assert gate.run_sandbox(pathlib.PurePosixPath("/home/user/bin/node"), pathlib.PurePosixPath("/tmp/work"), ["node"]) == 0',
        'args, options = calls[0]',
        'assert ["--ro-bind", "/home/user/bin/node", "/runtime/bin/node"] == args[args.index("/home/user/bin/node")-1:args.index("/home/user/bin/node")+2]',
        'assert "/home/user" not in args',
        'assert "--unshare-user" in args and "--unshare-net" in args and "--clearenv" in args',
        'assert "--die-with-parent" in args and options["start_new_session"]',
        'print("sandbox boundaries passed")',
    ].join('\n');
    const result = spawnSync(python, ['-B', '-c', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /sandbox boundaries passed/);
});
