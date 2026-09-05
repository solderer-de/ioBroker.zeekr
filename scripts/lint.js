'use strict';
// Cross-platform lint: eslint + node --check + Python compile with
// python3/python fallback (Windows runners only provide `python`).
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function eslintBin() {
    // eslint comes transitively via @iobroker/eslint-config (E0078 forbids
    // a direct devDependency), so resolve it instead of hardcoding a path.
    const pkg = require.resolve('eslint/package.json', { paths: [ROOT] });
    return path.join(path.dirname(pkg), 'bin', 'eslint.js');
}

function findPython() {
    for (const candidate of ['python3', 'python']) {
        const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
        if (!probe.error) {
            return candidate;
        }
    }
    throw new Error('No Python interpreter found (tried python3, python)');
}

execFileSync(process.execPath, [eslintBin(), 'lib/adapter.js', 'main.js', 'test/', 'scripts/', 'eslint.config.mjs'], {
    stdio: 'inherit',
    cwd: ROOT,
});
for (const file of ['main.js', 'lib/adapter.js']) {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'inherit' });
}
execFileSync(
    findPython(),
    ['-m', 'py_compile', path.join(ROOT, 'lib', 'bridge.py'), path.join(ROOT, 'lib', 'extract_secrets.py')],
    { stdio: 'inherit' },
);
