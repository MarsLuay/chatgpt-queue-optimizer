const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const checkerPath = path.join(repositoryRoot, 'scripts', 'check_tracked_secrets.py');

function runChecker(root) {
  const args = [checkerPath, '--repo-root', root];
  const commands = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of commands) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (!result.error || result.error.code !== 'ENOENT') {
      return result;
    }
  }
  throw new Error('Python was not available for the focused secret check test.');
}

function privateKeyHeader() {
  return '-'.repeat(5) + 'BEGIN ' + ['RSA', 'PRIVATE', 'KEY'].join(' ') + '-'.repeat(5);
}

test('tracked-file secret check passes for the cleaned repository', () => {
  const result = runChecker(repositoryRoot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /passed/);
});

test('tracked-file secret check reports only the path when a private-key header is tracked', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'queue-optimizer-secret-check-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Secret Check Test'], { cwd: root });

    const trackedName = 'local-signing-key.pem';
    const marker = privateKeyHeader();
    writeFileSync(path.join(root, trackedName), marker + '\n');
    execFileSync('git', ['add', trackedName], { cwd: root });

    const result = runChecker(root);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, new RegExp(trackedName.replace('.', '\\.'), 'u'));
    assert.equal(output.includes(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
