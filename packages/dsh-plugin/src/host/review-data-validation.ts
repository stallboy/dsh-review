import path from 'node:path';
import { auditInvariantErrors, parseAuditMarkdown } from './audit-archive.js';
import { parseReviewMarkdown } from './frontmatter.js';
import { quickReviewInvariants } from './invariants.js';

export function validateReviewData(file: string, bytes: Uint8Array): string[] {
    try {
        const filename = path.basename(file);
        if (filename !== 'review.md' && filename !== 'audit.md') {
            return ['仅支持 review.md 和 audit.md'];
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const parent = path.dirname(file);
        const slug = path.basename(parent);
        if (filename === 'review.md') {
            const month = path.basename(path.dirname(parent));
            const { meta } = parseReviewMarkdown(text);
            return quickReviewInvariants({ id: `${month}/${slug}`, month, slug, meta });
        }
        const { meta } = parseAuditMarkdown(text);
        return auditInvariantErrors(meta, slug);
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    }
}
