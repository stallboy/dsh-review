#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditInvariantErrors, parseAuditMarkdown } from './audit-archive.js';
import { parseReviewMarkdown } from './frontmatter.js';
import { quickReviewInvariants } from './invariants.js';

const help = '用法：dsh-review-validate <review.md 或 audit.md 的路径> [...]';

async function validate(file: string): Promise<{ path: string; errors: string[] }> {
    try {
        const filename = path.basename(file);
        if (filename !== 'review.md' && filename !== 'audit.md') {
            throw new Error('仅支持 review.md 和 audit.md');
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
        const parent = path.dirname(file);
        const slug = path.basename(parent);
        if (filename === 'review.md') {
            const month = path.basename(path.dirname(parent));
            const { meta } = parseReviewMarkdown(text);
            return { path: file, errors: quickReviewInvariants({ id: `${month}/${slug}`, month, slug, meta }) };
        }
        const { meta } = parseAuditMarkdown(text);
        return { path: file, errors: auditInvariantErrors(meta, slug) };
    } catch (error) {
        return { path: file, errors: [error instanceof Error ? error.message : String(error)] };
    }
}

const args = process.argv.slice(2);
if (args.length === 1 && ['-h', '--help'].includes(args[0] ?? '')) {
    console.log(help);
    console.log('只读检查 Frontmatter 和可从单文件验证的不变量。输出 JSON，校验失败退出 1。');
} else if (!args.length) {
    console.error(help);
    process.exitCode = 2;
} else {
    const cwd = process.env['INIT_CWD'] || process.cwd();
    const files = [];
    for (const file of args) files.push(await validate(path.resolve(cwd, file)));
    const ok = files.every(file => file.errors.length === 0);
    console.log(JSON.stringify({ ok, files }, null, 2));
    if (!ok) process.exitCode = 1;
}
