import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const distDir = resolve(root, 'dist');
const prerenderedPagesDir = resolve(root, '.svelte-kit/output/prerendered/pages');
const clientDir = resolve(root, '.svelte-kit/output/client');

if (!existsSync(prerenderedPagesDir)) {
	throw new Error('Missing prerendered pages output. Run the SvelteKit build before preparing webDir.');
}

if (!existsSync(clientDir)) {
	throw new Error('Missing client output. Run the SvelteKit build before preparing webDir.');
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

cpSync(prerenderedPagesDir, distDir, { recursive: true });
cpSync(clientDir, distDir, { recursive: true });

console.log('Prepared Capacitor webDir at dist/ from .svelte-kit output.');