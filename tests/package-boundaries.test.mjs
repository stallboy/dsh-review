import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function sources(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) ? [file] : [];
    });
}

test('插件作为独立 workspace 解析，根包只管理整个仓库', () => {
    const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(manifest.dsh, undefined);
    assert.equal(manifest.main, undefined);
    assert.equal(require.resolve('dsh-code-review/package.json'), path.join(root, 'packages/dsh-plugin/package.json'));
});

test('中央 Web 和共享协议的相对导入不越过自身包边界', () => {
    for (const workspace of ['apps/web', 'packages/protocol']) {
        const directory = path.join(root, workspace);
        for (const file of sources(path.join(directory, 'src'))) {
            const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
            for (const statement of source.statements) {
                if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
                const target = statement.moduleSpecifier?.text;
                if (!target?.startsWith('.')) continue;
                const relative = path.relative(directory, path.resolve(path.dirname(file), target));
                assert.ok(!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `${file}: ${target}`);
            }
        }
    }
});
