import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const chunksDir = join(process.cwd(), 'build', 'server', 'chunks');
let files;
try {
	files = readdirSync(chunksDir);
} catch (e) {
	console.error('No build/server/chunks directory found, skipping patch.');
	process.exit(0);
}

for (const file of files) {
	if (!file.endsWith('.js')) continue;
	const filePath = join(chunksDir, file);
	let content = readFileSync(filePath, 'utf8');
	if (content.includes("createRequire") || content.includes("// patched-require-shim")) continue;
	// If the chunk contains top-level require calls, inject a shim
	if (/\n\s*require\(/.test(content) || /\n\s*module\.exports\s*=/.test(content)) {
		const shim = "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\n// patched-require-shim\n";
		content = content.replace(/^(import .*?\n)/s, `$1${shim}`);
		writeFileSync(filePath, content, 'utf8');
		console.log('Patched', filePath);
	}
}
console.log('patch-build-require complete');

// Create small bridge modules for opentelemetry machine-id requires
const dirFiles = readdirSync(chunksDir);
const requires = new Set();
for (const file of dirFiles) {
	if (!file.endsWith('.js')) continue;
	const p = join(chunksDir, file);
	const c = readFileSync(p, 'utf8');
	const re = /require\(\s*['"]\.\/getMachineId-([a-zA-Z0-9_-]+)['"]\s*\)/g;
	let m;
	while ((m = re.exec(c))) {
		requires.add(`getMachineId-${m[1]}.js`);
	}
}

for (const r of requires) {
	const target = join(chunksDir, r);
	if (files.includes(r)) continue;
	const upstream = '../../../node_modules/@opentelemetry/resources/build/src/detectors/platform/node/machine-id/' + r.replace('.js','');
	const content = `import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nexport default require('${upstream}');\n`;
	try {
		writeFileSync(target, content, 'utf8');
		console.log('Wrote bridge module', target);
	} catch (e) {
		console.error('Failed to write bridge module', target, e.message);
	}
}
