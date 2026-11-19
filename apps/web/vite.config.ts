import { defineConfig } from 'vite';
export default defineConfig({ base: './', build: { license: { fileName: 'third-party-licenses.txt' } }, server: { proxy: { '/api': 'http://127.0.0.1:3081' } } });
