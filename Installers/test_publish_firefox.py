import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import publish_firefox


class PublishFirefoxTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'manifest.json').write_text('{\n  "version": "1.0.7",\n  "name": "Demo"\n}\n', encoding='utf-8')
        self.calls = []
        self.uploads = []
        self.branch = 'main'
        self.dirty = False
        self.fail = None
        self.upload_errors = []

    def command(self, args, root, *, capture=False):
        self.assertEqual(root, self.root)
        self.calls.append(tuple(args))
        if self.fail and tuple(args[1:]) == self.fail:
            raise RuntimeError('Simulated failed command')
        if args[1:3] == ['rev-parse', '--show-toplevel']:
            return str(self.root)
        if args[1:3] == ['branch', '--show-current']:
            return self.branch
        if args[1:3] == ['status', '--porcelain']:
            return '?? files.txt' if self.dirty else (' M manifest.json' if json.loads((self.root / 'manifest.json').read_text())['version'] != '1.0.7' else '')
        if args[1:3] == ['remote', 'get-url']:
            return 'https://github.com/example/example'
        return ''

    def upload(self, root, **kwargs):
        self.uploads.append((root, kwargs))
        self.assertEqual(kwargs['credential_reader'](), ('key', 'secret'))
        self.assertFalse(kwargs['require_local_test'])
        return self.upload_errors

    def execute(self):
        with patch.object(publish_firefox.shutil, 'which', return_value='git'):
            return publish_firefox.managed_publish(self.root, command_runner=self.command,
                npm_lookup=lambda: 'npm', credentials_reader=lambda: ('key', 'secret'), upload_runner=self.upload)

    def test_invalid_log_path_exits_cleanly_with_visible_error(self):
        with patch.object(Path, "mkdir", side_effect=OSError(123, "Invalid directory name")):
            with patch("sys.stderr", new_callable=io.StringIO) as stderr:
                exit_code = publish_firefox.main(["--repo-dir", str(self.root)])
        self.assertEqual(exit_code, 1)
        self.assertIn("Could not initialize the release directory", stderr.getvalue())
        self.assertIn("Invalid directory name", stderr.getvalue())

    def test_bump_version_preserves_other_fields(self):
        previous, current = publish_firefox.bump_patch_version(self.root / 'manifest.json')
        self.assertEqual((previous, current), ('1.0.7', '1.0.8'))
        contents = (self.root / 'manifest.json').read_text()
        self.assertIn('"name": "Demo"', contents)

    def test_publish_validation_before_upload_and_commit(self):
        self.assertEqual(self.execute(), '1.0.8')
        sequence = [c[1:] for c in self.calls]
        self.assertLess(sequence.index(('pull', '--ff-only', 'origin', 'main')), sequence.index(('run', 'check')))
        self.assertLess(sequence.index(('run', 'check')), sequence.index(('-m', 'unittest', 'discover', '-s', 'Installers', '-p', 'test_*.py')))
        self.assertLess(sequence.index(('-m', 'unittest', 'discover', '-s', 'Installers', '-p', 'test_*.py')), sequence.index(('add', '--', 'manifest.json')))
        self.assertLess(sequence.index(('add', '--', 'manifest.json')), sequence.index(('push', 'origin', 'main')))
        self.assertEqual(len(self.uploads), 1)
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '1.0.8')

    def test_dirty_checkout_refuses_to_publish(self):
        self.dirty = True
        with self.assertRaisesRegex(RuntimeError, 'uncommitted'):
            self.execute()
        self.assertFalse(self.uploads)
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '1.0.7')

    def test_wrong_branch_refuses_to_publish(self):
        self.branch = 'feature'
        with self.assertRaisesRegex(RuntimeError, 'main branch'):
            self.execute()
        self.assertFalse(self.uploads)

    def test_failed_checks_leave_version_unchanged(self):
        self.fail = ('run', 'check')
        with self.assertRaisesRegex(RuntimeError, 'Simulated'):
            self.execute()
        self.assertFalse(self.uploads)
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '1.0.7')

    def test_submission_failure_does_not_commit(self):
        self.upload_errors = ['AMO submission failed']
        with self.assertRaisesRegex(RuntimeError, 'did not confirm'):
            self.execute()
        self.assertEqual(len(self.uploads), 1)
        self.assertNotIn(('git', 'add', '--', 'manifest.json'), self.calls)
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '1.0.8')

    def test_push_failure_retains_local_release_commit(self):
        self.fail = ('push', 'origin', 'main')
        with self.assertRaisesRegex(RuntimeError, 'Simulated'):
            self.execute()
        self.assertIn(('git', 'commit', '-m', 'chore(release): Firefox extension v1.0.8'), self.calls)
        self.assertEqual(json.loads((self.root / 'manifest.json').read_text())['version'], '1.0.8')


if __name__ == '__main__':
    unittest.main()
