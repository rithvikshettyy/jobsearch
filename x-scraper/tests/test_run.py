import json
import random
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from xs.api import ApiError
from xs.fetch import FixtureFetcher
from xs.model import AuthFailure, FetchError
from xs.run import AUTH_ALERT, Deps, run

CONFIG = json.loads((Path(__file__).resolve().parents[1] / "config.json").read_text(encoding="utf-8"))
FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "sample_tweets.json"
NOW = datetime.now(timezone.utc)


class FakeClient:
    def __init__(self, state=None, fail_ingest_on=None, alert_sent=True):
        self.state = state or {"last_run_at": None, "last_alert_at": None, "accounts": {}}
        self.fail_ingest_on = fail_ingest_on
        self.alert_sent = alert_sent
        self.ingested: list[list[dict]] = []
        self.posted: list[dict] = []
        self.alerts: list[str] = []

    def get_state(self):
        return self.state

    def ingest(self, items):
        self.ingested.append(items)
        if self.fail_ingest_on is not None and len(self.ingested) == self.fail_ingest_on:
            raise ApiError("POST /ingest failed with HTTP 500", 500)
        return {"queued": len(items), "duplicate": 0, "filtered": 0, "invalid": 0}

    def post_state(self, accounts=None, run_at=None, ok=False):
        self.posted.append({"accounts": accounts or {}, "run_at": run_at, "ok": ok})
        return {"ok": True}

    def alert(self, message):
        self.alerts.append(message)
        return {"sent": self.alert_sent}


class Raises:
    name = "raises"

    def __init__(self, error):
        self.error = error

    async def fetch_one(self, handle, since_id, limit):
        raise self.error


def deps(client, fetcher=None, sleeps=None):
    fetcher = fetcher or FixtureFetcher(FIXTURE)

    async def sleep(seconds):
        if sleeps is not None:
            sleeps.append(seconds)

    return Deps(fetcher=fetcher, client=client, resolver=getattr(fetcher, "resolver", None), now=lambda: NOW, sleep=sleep, rng=random.Random(1))


def cfg(**over):
    merged = json.loads(json.dumps(CONFIG))
    merged.update(over)
    return merged


class Gate(unittest.IsolatedAsyncioTestCase):
    async def test_skips_when_the_last_run_was_inside_the_interval(self):
        client = FakeClient({"last_run_at": (NOW - timedelta(minutes=10)).isoformat(), "accounts": {}})
        summary = await run(CONFIG, deps(client))
        self.assertEqual(summary["status"], "skipped_interval")
        self.assertEqual((client.ingested, client.posted), ([], []))

    async def test_runs_once_the_interval_has_passed_and_force_overrides(self):
        old = FakeClient({"last_run_at": (NOW - timedelta(minutes=31)).isoformat(), "accounts": {}})
        self.assertEqual((await run(CONFIG, deps(old)))["status"], "ok")

        recent = FakeClient({"last_run_at": (NOW - timedelta(minutes=5)).isoformat(), "accounts": {}})
        self.assertEqual((await run(CONFIG, deps(recent), force=True))["status"], "ok")

    async def test_a_dry_run_ignores_the_gate_but_writes_nothing(self):
        client = FakeClient({"last_run_at": NOW.isoformat(), "accounts": {}})
        summary = await run(CONFIG, deps(client), dry_run=True)
        self.assertEqual(summary["status"], "ok")
        self.assertEqual((client.ingested, client.posted, client.alerts), ([], [], []))


class Pipeline(unittest.IsolatedAsyncioTestCase):
    async def test_pushes_the_keepers_and_moves_both_cursors(self):
        client = FakeClient()
        summary = await run(CONFIG, deps(client))

        self.assertEqual((summary["fetched"], summary["kept"], summary["queued"]), (9, 3, 3))
        pushed = [item for batch in client.ingested for item in batch]
        self.assertEqual({item["company"] for item in pushed}, {"Acme", "Gamma", "Delta Labs"})
        self.assertTrue(all(item["source"] == "x" for item in pushed))

        # The cursor passes everything fetched, kept or not: 018 is the newest RohoolAgi tweet, 015 Ajay's.
        self.assertEqual(client.posted[-1]["accounts"], {"RohoolAgi": "1850000000000000018", "Ajay_2512x": "1850000000000000015"})
        self.assertTrue(client.posted[-1]["ok"])

    async def test_a_second_run_with_those_cursors_pushes_nothing(self):
        client = FakeClient({"last_run_at": None, "accounts": {"RohoolAgi": "1850000000000000018", "Ajay_2512x": "1850000000000000015"}})
        summary = await run(CONFIG, deps(client))
        self.assertEqual((summary["fetched"], summary["kept"], client.ingested), (0, 0, []))

    async def test_first_run_ignores_tweets_older_than_the_lookback(self):
        summary = await run(CONFIG, deps(FakeClient()))
        self.assertEqual(summary["fetched"], 9)  # the 200 hour old tweet is dropped, 9 of 10 remain

    async def test_batches_respect_the_configured_size(self):
        client = FakeClient()
        await run(cfg(ingest={"batch_size": 2}), deps(client))
        self.assertEqual([len(batch) for batch in client.ingested], [2, 1])

    async def test_a_failed_batch_keeps_that_accounts_cursor_so_it_is_retried(self):
        client = FakeClient(fail_ingest_on=1)
        summary = await run(cfg(ingest={"batch_size": 1}), deps(client))

        self.assertEqual(summary["status"], "partial")
        posted = client.posted[-1]
        self.assertFalse(posted["ok"])
        # Batch 1 held the oldest keeper. Its account must not advance.
        failed_account = "RohoolAgi" if client.ingested[0][0]["company"] == "Acme" else "Ajay_2512x"
        self.assertNotIn(failed_account, posted["accounts"])

    async def test_require_link_false_falls_back_to_the_tweet_url(self):
        client = FakeClient()
        await run(cfg(require_link=False), deps(client))
        pushed = [item for batch in client.ingested for item in batch]
        self.assertTrue(any(item["url"].startswith("https://x.com/") for item in pushed))


class Jitter(unittest.IsolatedAsyncioTestCase):
    async def test_sleeps_at_the_start_and_between_accounts_but_not_on_a_dry_run(self):
        sleeps: list[float] = []
        await run(CONFIG, deps(FakeClient(), sleeps=sleeps))
        low, high = CONFIG["jitter"]["start_seconds"]
        gap_low, gap_high = CONFIG["jitter"]["between_accounts_seconds"]
        self.assertEqual(len(sleeps), 2)
        self.assertTrue(low <= sleeps[0] <= high)
        self.assertTrue(gap_low <= sleeps[1] <= gap_high)

        quiet: list[float] = []
        await run(CONFIG, deps(None, sleeps=quiet), dry_run=True)
        self.assertEqual(quiet, [])


class AuthFailureHandling(unittest.IsolatedAsyncioTestCase):
    async def test_alerts_once_records_the_attempt_and_finishes_cleanly(self):
        client = FakeClient()
        summary = await run(CONFIG, deps(client, fetcher=Raises(AuthFailure("every X client failed to log in"))))

        self.assertEqual(summary["status"], "auth_failure")
        self.assertEqual(client.alerts, [AUTH_ALERT])
        self.assertEqual(client.ingested, [])
        # The attempt is recorded so the schedule backs off, but it is not marked a good run.
        self.assertEqual(client.posted, [{"accounts": {}, "run_at": NOW.isoformat(), "ok": False}])

    async def test_the_alert_text_has_no_em_or_en_dash_and_no_secret_shapes(self):
        self.assertNotRegex(AUTH_ALERT, "[–—]")
        self.assertNotIn("auth_token=", AUTH_ALERT)

    async def test_a_dry_run_only_says_it_would_alert(self):
        client = FakeClient()
        summary = await run(CONFIG, deps(client, fetcher=Raises(AuthFailure("x"))), dry_run=True)
        self.assertEqual(summary["status"], "auth_failure")
        self.assertEqual((client.alerts, client.posted), ([], []))

    async def test_a_fetch_error_is_not_an_auth_failure_and_sends_no_alert(self):
        client = FakeClient()
        summary = await run(CONFIG, deps(client, fetcher=Raises(FetchError("rate limited"))))
        self.assertEqual(summary["status"], "fetch_error")
        self.assertEqual((client.alerts, client.posted), ([], []))


if __name__ == "__main__":
    unittest.main()
