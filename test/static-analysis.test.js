const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('package.json exposes lint, typecheck, and combined check scripts', () => {
    const pkg = JSON.parse(read('package.json'));

    assert.equal(typeof pkg.scripts.test, 'string');
    assert.match(pkg.scripts.test, /node --test/);
    assert.equal(typeof pkg.scripts.lint, 'string');
    assert.match(pkg.scripts.lint, /eslint/);
    assert.equal(typeof pkg.scripts.typecheck, 'string');
    assert.match(pkg.scripts.typecheck, /tsc/);
    assert.equal(typeof pkg.scripts.check, 'string');
    assert.match(pkg.scripts.check, /npm test/);
    assert.match(pkg.scripts.check, /npm run lint/);
    assert.match(pkg.scripts.check, /npm run typecheck/);
});

test('static analysis config covers extension sources, checked JS, and CI', () => {
    const eslintConfig = read('eslint.config.js');
    for (const name of ['background.js', 'content.js', 'popup.js', 'utils.js', 'provider-adapter.js']) {
        assert.match(eslintConfig, new RegExp(name.replace('.', '\\.')));
    }
    assert.match(eslintConfig, /test\/\*\*\/\*\.js|tests\/\*\*\/\*\.js/);
    assert.match(eslintConfig, /['"]no-undef['"]\s*:\s*['"]error['"]/);
    assert.doesNotMatch(eslintConfig, /['"]no-undef['"]\s*:\s*['"]off['"]/);

    const jsconfig = JSON.parse(read('jsconfig.json'));
    assert.equal(jsconfig.compilerOptions.allowJs, true);
    assert.equal(jsconfig.compilerOptions.checkJs, true);
    assert.equal(jsconfig.compilerOptions.noEmit, true);

    const types = read('types/extension.d.ts');
    assert.match(types, /interface QueueJob/);
    assert.match(types, /QUEUE_DURABLE_STATE_KEY|interface DurableQueueJob/);
    assert.match(types, /interface QueueSettings/);
    assert.match(types, /interface RuntimeMessageRequest/);
    assert.match(types, /interface ProviderAdapterContract/);

    const ci = read('.github/workflows/ci.yml');
    assert.match(ci, /npm ci/);
    assert.match(ci, /npm run check/);
    assert.equal(fs.existsSync(path.join(repoRoot, 'package-lock.json')), true);

    const contributing = read('CONTRIBUTING.md');
    assert.match(contributing, /npm test/);
    assert.match(contributing, /npm run lint/);
    assert.match(contributing, /npm run typecheck/);
    assert.match(contributing, /npm run check/);
});
