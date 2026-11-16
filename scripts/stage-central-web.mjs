import { cp, mkdir, rm } from 'node:fs/promises';

const source = new URL('../apps/web/dist/', import.meta.url);
const destination = new URL('../apps/server/dist/public/', import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
