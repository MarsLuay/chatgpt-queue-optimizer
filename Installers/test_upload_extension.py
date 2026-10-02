import contextlib
import io
import plistlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import upload_extension
from upload_extension import (
    build_amo_submit_command,
    build_local_firefox_command,
    read_amo_credentials,
    run_upload_workflow,
    signing_environment,
    submit_to_amo,
)


class UploadWorkflowTests(unittest.TestCase):
    def test_main_writes_a_persistent_workflow_log(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            repo_root = Path(temp_dir)
            (repo_root / "manifest.json").write_text("{}", encoding="utf-8")
            with (
                patch.object(upload_extension, "run_upload_workflow", return_value=[]),
                patch.object(upload_extension, "LOG_PATH", None),
            ):
                self.assertEqual(
                    upload_extension.main(["--repo-dir", str(repo_root), "--local-only"]),
                    0,
                )
            log_path = repo_root / "build" / "logs" / "upload.log"
            self.assertIn("Starting ChatGPT Queue", log_path.read_text(encoding="utf-8"))

    def test_amo_command_submits_listed_update_without_waiting_for_review(self):
        command = build_amo_submit_command("npm", Path("firefox-src"), Path("artifacts"))
        self.assertIn("sign", command)
        self.assertIn("--channel", command)
        self.assertIn("listed", command)
        self.assertIn("--approval-timeout", command)
        self.assertIn("0", command)
        self.assertIn("--no-input", command)
        self.assertIn("--source-dir", command)
        self.assertIn("firefox-src", command)
        self.assertNotIn("api-secret", " ".join(command))

    def test_local_firefox_uses_an_isolated_temporary_profile(self):
        command = build_local_firefox_command("npm", Path("firefox-src"))
        self.assertIn("run", command)
        self.assertIn("--source-dir", command)
        self.assertIn("--start-url", command)
        self.assertNotIn("--firefox-profile", command)
        self.assertNotIn("--keep-profile-changes", command)

    def test_platform_launchers_reference_the_upload_helper(self):
        repo_root = Path(__file__).resolve().parents[1]
        batch_text = (repo_root / "upload.bat").read_text(encoding="utf-8")
        app_script = repo_root / "upload.app" / "Contents" / "MacOS" / "upload"
        app_info = plistlib.loads(
            (repo_root / "upload.app" / "Contents" / "Info.plist").read_bytes()
        )

        self.assertIn("Installers\\upload_extension.py", batch_text)
        self.assertNotIn("\npause\n", batch_text.lower())
        self.assertIn("Installers/upload_extension.py", app_script.read_text(encoding="utf-8"))
        self.assertEqual(app_info["CFBundleExecutable"], "upload")
        self.assertTrue(app_script.is_file())

    def test_amo_credentials_are_passed_only_in_the_child_environment(self):
        credentials = ("issuer-id", "secret-value")
        command = build_amo_submit_command("npm", Path("firefox-src"), Path("artifacts"))
        env = signing_environment(*credentials, base_environment={"PATH": "/bin"})
        self.assertEqual(env["WEB_EXT_API_KEY"], credentials[0])
        self.assertEqual(env["WEB_EXT_API_SECRET"], credentials[1])
        self.assertNotIn(credentials[0], command)
        self.assertNotIn(credentials[1], command)

    def test_api_credentials_can_be_entered_without_persisting_them(self):
        with patch("sys.stdin.isatty", return_value=True):
            self.assertEqual(
                read_amo_credentials(
                    {},
                    input_fn=lambda _prompt: "issuer-id",
                    secret_fn=lambda _prompt: "secret-value",
                ),
                ("issuer-id", "secret-value"),
            )
        self.assertEqual(
            read_amo_credentials(
                {"WEB_EXT_API_KEY": "issuer-id", "WEB_EXT_API_SECRET": "secret-value"},
                input_fn=lambda _prompt: self.fail("did not expect an API key prompt"),
                secret_fn=lambda _prompt: self.fail("did not expect an API secret prompt"),
            ),
            ("issuer-id", "secret-value"),
        )

    def test_submission_output_redacts_credentials(self):
        credentials = ("issuer-id", "secret-value")
        captured = {}

        def fake_runner(command, **kwargs):
            captured["command"] = command
            captured["env"] = kwargs["env"]
            return subprocess.CompletedProcess(command, 0, "uploaded secret-value", "")

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "firefox-src"
            artifacts = root / "artifacts"
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                submitted = submit_to_amo("npm", root, source, artifacts, credentials, runner=fake_runner)

        self.assertTrue(submitted)
        self.assertNotIn("secret-value", output.getvalue())
        self.assertNotIn("issuer-id", captured["command"])
        self.assertNotIn("secret-value", captured["command"])
        self.assertEqual(captured["env"]["WEB_EXT_API_SECRET"], "secret-value")

    def test_local_test_is_started_before_submission_and_does_not_gate_upload(self):
        events = []
        root = Path(tempfile.gettempdir())
        source = root / "firefox-src"
        artifacts = root / "artifacts"

        errors = run_upload_workflow(
            root,
            package_builder=lambda _root: (events.append("package") or ("1.0.7", source, artifacts)),
            npm_lookup=lambda: "npm",
            local_launcher=lambda _npm, _root, _source: (events.append("local") or "failed"),
            credential_reader=lambda: (events.append("credentials") or ("issuer", "secret")),
            amo_submitter=lambda *_args: (events.append("submit") or True),
        )

        self.assertEqual(events, ["package", "local", "credentials", "submit"])
        self.assertTrue(any("temporary Firefox test" in error for error in errors))

    def test_local_test_still_starts_if_credentials_are_unavailable(self):
        events = []
        root = Path(tempfile.gettempdir())

        def no_credentials():
            events.append("credentials")
            raise RuntimeError("credentials missing")

        errors = run_upload_workflow(
            root,
            package_builder=lambda _root: ("1.0.7", root / "firefox-src", root / "artifacts"),
            npm_lookup=lambda: "npm",
            local_launcher=lambda _npm, _root, _source: (events.append("local") or "installed"),
            credential_reader=no_credentials,
            amo_submitter=lambda *_args: self.fail("submission must wait for AMO credentials"),
        )

        self.assertEqual(events, ["local", "credentials"])
        self.assertTrue(any("credentials missing" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
