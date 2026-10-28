import io
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import linkedin_scraper
from ll.api import ApiError
from ll.fetch import ERROR, INVALID_SESSION, OK, RATE_LIMITED, FetchResult, FixtureFetcher, classify
from ll.redact import MASK, Redactor, scrub
from ll.run import ConfigError, Deps, run, validate

ROOT = Path(__file__).resolve().parents[1]
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
FIXTURE = ROOT / "fixtures" / "sample_jobs.json"
NOW = datetime(2026, 10, 28, 12, 0, tzinfo=timezone.utc)


class FakeClient:
    def __init__(self, fail_on=None):
        self.batches: list[list[dict]] = []
        self.fail_on = fail_on

    def ingest(self, items):
        self.batches.append(items)
        if self.fail_on == len(self.batches):
            raise ApiError("POST /ingest failed with HTTP 500", 500)
        return {"queued": len(items), "duplicate": 0, "filtered": 0, "invalid": 0}


class Fixed:
    name = "fixed"

    def __init__(self, result):
        self.result = result
        self.calls = 0

    def fetch(self, searches, cfg):
        self.calls += 1
        return self.result


def deps(client=None, fetcher=None):
    return Deps(fetcher=fetcher or FixtureFetcher(FIXTURE), client=client, now=lambda: NOW)


def cfg(**over):
    merged = json.loads(json.dumps(CONFIG))
    for key, value in over.items():
        merged[key] = {**merged[key], **value} if isinstance(value, dict) else value
    return merged


class GuardRails(unittest.TestCase):
    def test_the_shipped_config_is_inside_every_cap(self):
        validate(CONFIG)

    def test_a_config_that_asks_for_too_much_is_refused(self):
        with self.assertRaises(ConfigError):
            validate(cfg(searches=CONFIG["searches"] * 3))
        with self.assertRaises(ConfigError):
            validate(cfg(limits={"jobs_per_search": 99}))
        with self.assertRaises(ConfigError):
            validate(cfg(pacing={"slow_mo_seconds": 0.2}))
        with self.assertRaises(ConfigError):
            validate(cfg(min_interval_hours=0))
        with self.assertRaises(ConfigError):
            validate(cfg(searches=[]))


class Pipeline(unittest.TestCase):
    def test_maps_dedupes_and_pushes_the_keepers(self):
        client = FakeClient()
        summary = run(CONFIG, deps(client), state_path=None)

        self.assertEqual((summary["fetched"], summary["kept"], summary["queued"]), (6, 4, 4))
        pushed = [item for batch in client.batches for item in batch]
        # the repeated job and the job with no company are gone, the rest are canonical LinkedIn urls
        self.assertEqual(
            [item["url"] for item in pushed],
            [f"https://www.linkedin.com/jobs/view/{n}" for n in ("4000000001", "4000000002", "4000000003", "4000000004")],
        )
        self.assertTrue(all(item["source"] == "linkedin" for item in pushed))

    def test_batches_respect_the_configured_size(self):
        client = FakeClient()
        run(cfg(ingest={"batch_size": 3}), deps(client), state_path=None)
        self.assertEqual([len(batch) for batch in client.batches], [3, 1])

    def test_a_dry_run_sends_and_saves_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            client = FakeClient()
            summary = run(CONFIG, deps(client), state_path=state, dry_run=True)
            self.assertEqual(len(summary["items"]), 4)
            self.assertEqual(client.batches, [])
            self.assertFalse(state.exists())

    def test_a_failed_push_does_not_count_as_a_run_so_it_is_retried(self):
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            summary = run(CONFIG, deps(FakeClient(fail_on=1)), state_path=state)
            self.assertEqual(summary["status"], "partial")
            self.assertFalse(state.exists())


class Interval(unittest.TestCase):
    def write_state(self, tmp, **state):
        path = Path(tmp) / "state.json"
        path.write_text(json.dumps(state), encoding="utf-8")
        return path

    def test_skips_inside_the_minimum_gap_and_runs_after_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            recent = self.write_state(tmp, last_run_at=(NOW - timedelta(hours=2)).isoformat())
            fetcher = Fixed(FetchResult())
            self.assertEqual(run(CONFIG, deps(FakeClient(), fetcher), state_path=recent)["status"], "skipped_interval")
            self.assertEqual(fetcher.calls, 0)

            old = self.write_state(tmp, last_run_at=(NOW - timedelta(hours=7)).isoformat())
            self.assertEqual(run(CONFIG, deps(FakeClient()), state_path=old)["status"], "ok")

    def test_a_successful_run_records_its_time(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            run(CONFIG, deps(FakeClient()), state_path=path)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["last_run_at"], NOW.isoformat())


class Throttling(unittest.TestCase):
    def test_a_throttle_pauses_for_a_day_and_force_cannot_override_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            first = run(CONFIG, deps(FakeClient(), Fixed(FetchResult(status=RATE_LIMITED, detail="429 too many requests"))), state_path=path)
            self.assertEqual(first["status"], RATE_LIMITED)
            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(saved["paused_until"], (NOW + timedelta(hours=24)).isoformat())

            fetcher = Fixed(FetchResult())
            again = run(CONFIG, deps(FakeClient(), fetcher), state_path=path, force=True)
            self.assertEqual(again["status"], "paused")
            self.assertEqual(fetcher.calls, 0)  # LinkedIn is not touched at all

    def test_a_dead_session_also_pauses_and_pushes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            client = FakeClient()
            summary = run(CONFIG, deps(client, Fixed(FetchResult(jobs=[{"job_id": "1234567", "title": "t", "company": "c"}], status=INVALID_SESSION))), state_path=path)
            self.assertEqual(summary["status"], INVALID_SESSION)
            self.assertEqual(client.batches, [])
            self.assertIn("paused_until", json.loads(path.read_text(encoding="utf-8")))

    def test_a_dry_run_does_not_write_a_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "state.json"
            run(CONFIG, deps(None, Fixed(FetchResult(status=RATE_LIMITED))), state_path=path, dry_run=True)
            self.assertFalse(path.exists())

    def test_an_ordinary_error_keeps_what_was_read_and_reports_partial(self):
        client = FakeClient()
        summary = run(CONFIG, deps(client, Fixed(FetchResult(jobs=[{"job_id": "1234567", "title": "AI Engineer", "company": "Zed", "description": "x"}], status=ERROR, detail="timeout"))), state_path=None)
        self.assertEqual((summary["status"], summary["queued"]), ("partial", 1))

    def test_classify(self):
        self.assertEqual(classify("HTTP 429 Too many requests"), RATE_LIMITED)
        self.assertEqual(classify("redirected to an authwall"), RATE_LIMITED)
        self.assertEqual(classify("InvalidCookieException: no usable session"), INVALID_SESSION)
        self.assertEqual(classify("element not found"), ERROR)
        self.assertEqual(OK, "ok")


class Redaction(unittest.TestCase):
    def test_linkedin_cookies_and_the_ingest_key_never_reach_a_log(self):
        text = "li_at=AQEDAT1234567890abcdef; JSESSIONID=ajax:123456; LI_AT_COOKIE=zzzz9999yyyy; x-ingest-key: secretkey123456"
        out = scrub(text, ["secretkey123456"])
        for leaked in ("AQEDAT1234567890abcdef", "ajax:123456", "zzzz9999yyyy", "secretkey123456"):
            self.assertNotIn(leaked, out)
        self.assertIn(MASK, out)

    def test_the_log_filter_covers_tracebacks(self):
        import logging

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(Redactor(["supersecretvalue99"]))
        logger = logging.getLogger("ll-redact-test")
        logger.handlers, logger.propagate = [handler], False
        try:
            raise RuntimeError("bad supersecretvalue99")
        except RuntimeError:
            logger.exception("failed")
        self.assertNotIn("supersecretvalue99", stream.getvalue())


class Cli(unittest.TestCase):
    def run_main(self, argv):
        real = sys.stdout
        raw = io.BytesIO()
        sys.stdout = io.TextIOWrapper(raw, encoding="cp1252", write_through=True)
        try:
            code = linkedin_scraper.main(argv)
            sys.stdout.flush()
        finally:
            sys.stdout = real
        return code, raw.getvalue().decode("utf-8")

    def test_a_live_run_refuses_to_start_without_the_explicit_opt_in(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env"
            env.write_text("LINKEDIN_ACCEPT_RISK=no\nJOB_BOT_URL=https://example.invalid\nINGEST_KEY=abcdef123456\n", encoding="utf-8")
            code, printed = self.run_main(["--dry-run", "--env", str(env)])
        self.assertEqual(code, 2)
        self.assertIn("Refusing to run against LinkedIn", printed)

    def test_the_offline_fixture_run_needs_no_opt_in_and_survives_a_cp1252_console(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, printed = self.run_main(["--dry-run", "--fixture", str(FIXTURE), "--env", str(Path(tmp) / "none.env")])
        self.assertEqual(code, 0)
        data = json.loads(printed[printed.index("{") :])
        self.assertEqual(data["summary"]["kept"], 4)
        self.assertEqual(len(data["would_push"]), 4)


if __name__ == "__main__":
    unittest.main()
