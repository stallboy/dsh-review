import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function secret(): string {
    return randomBytes(32).toString('base64url');
}

export function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function passwordHash(password: string, salt = secret()): { salt: string; hash: string } {
    return { salt, hash: scryptSync(password, salt, 64).toString('hex') };
}

export function passwordMatches(password: string, salt: string, hash: string): boolean {
    const expected = Buffer.from(hash, 'hex');
    const actual = scryptSync(password, salt, 64);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
