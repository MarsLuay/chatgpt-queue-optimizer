const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'manifest.json'), 'utf8'));
const sourceFiles = ['background.js', 'content.js', 'popup.js', 'utils.js'];
const source = sourceFiles
    .map((file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'))
    .join('\n');

const EXPECTED_PERMISSIONS = [
    'alarms',
    'clipboardRead',
    'clipboardWrite',
    'scripting',
    'storage'
];

const EXPECTED_HOSTS = [
    'https://chat.openai.com/*',
    'https://chatgpt.com/*'
];

function sorted(values) {
    return [...values].sort();
}

test('manifest permissions stay on the reviewed allowlist', () => {
    assert.deepEqual(sorted(manifest.permissions || []), EXPECTED_PERMISSIONS);
    assert.equal((manifest.permissions || []).includes('tabs'), false);
    assert.equal((manifest.permissions || []).includes('activeTab'), false);
});

test('every remaining manifest permission has a concrete code path', () => {
    const evidence = {
        scripting: /chrome\.scripting\.(?:executeScript|insertCSS)/,
        storage: /chrome\.storage\./,
        alarms: /chrome\.alarms\./,
        clipboardRead: /navigator\.clipboard\.readText/,
        clipboardWrite: /navigator\.clipboard\.writeText/
    };

    for (const permission of manifest.permissions || []) {
        assert.ok(evidence[permission], `No permission evidence rule for ${permission}`);
        assert.match(source, evidence[permission], `No current code path found for ${permission}`);
    }
});

test('host access is limited to supported ChatGPT origins', () => {
    assert.deepEqual(sorted(manifest.host_permissions || []), EXPECTED_HOSTS);

    const contentMatches = new Set(
        (manifest.content_scripts || []).flatMap((entry) => entry.matches || [])
    );
    assert.deepEqual(sorted(contentMatches), EXPECTED_HOSTS);

    const resourceMatches = new Set(
        (manifest.web_accessible_resources || []).flatMap((entry) => entry.matches || [])
    );
    assert.deepEqual(sorted(resourceMatches), EXPECTED_HOSTS);

    const forbiddenBroadPatterns = new Set([
        '<all_urls>',
        '*://*/*',
        'http://*/*',
        'https://*/*'
    ]);

    for (const host of manifest.host_permissions || []) {
        assert.equal(
            forbiddenBroadPatterns.has(host),
            false,
            `Broad host permission is not allowed: ${host}`
        );
    }
});

test('MV3 extension pages keep a strict self-only script policy', () => {
    const csp = manifest.content_security_policy?.extension_pages || '';

    assert.equal(csp, "script-src 'self'; object-src 'self'");
    assert.equal(csp.includes("'unsafe-eval'"), false);
    assert.equal(csp.includes("'unsafe-inline'"), false);
    assert.equal(/https?:\/\//.test(csp), false);

    for (const file of sourceFiles) {
        const contents = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        assert.doesNotMatch(contents, /\beval\s*\(/, `${file} must not use eval()`);
        assert.doesNotMatch(contents, /\bnew\s+Function\s*\(/, `${file} must not use new Function()`);
    }
});
