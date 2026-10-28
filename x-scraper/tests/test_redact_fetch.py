import io
import logging
import unittest

from xs.fetch import Fetchers, FixtureFetcher, load_burners, looks_like_auth_failure
from xs.model import AuthFailure, ConfigError, FetchError
from xs.redact import MASK, Redactor, scrub

COOKIE = "auth_token=aaaa1111bbbb2222cccc3333; ct0=dddd4444eeee5555ffff6666"
KEY = "ingest-key-0123456789abcdef"


class Redaction(unittest.TestCase):
    def test_known_values_are_masked(self):
        text = f"cookies were {COOKIE} and key {KEY}"
        out = scrub(text, [COOKIE, KEY, "aaaa1111bbbb2222cccc3333"])
        self.assertNotIn("aaaa1111", out)
        self.assertNotIn(KEY, out)
        self.assertIn(MASK, out)

    def test_secret_shaped_text_is_masked_even_when_unknown(self):
        for text in ("auth_token=zzzzyyyyxxxx", "ct0: 123456abcdef", "x-ingest-key: abc12345", "Authorization: Bearer abcdef123456", "bot123456789:ABCdefGhIJKlmNOPqrstUVwxyz0123"):
            out = scrub(text, [])
            self.assertIn(MASK, out, text)
            self.assertNotIn("zzzzyyyyxxxx", out)
            self.assertNotIn("abcdef123456", out)

    def test_short_values_are_not_treated_as_secrets(self):
        self.assertEqual(scrub("the ai engineer", ["ai"]), "the ai engineer")

    def test_a_logging_filter_scrubs_messages_args_and_tracebacks(self):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(Redactor([COOKIE, KEY]))
        logger = logging.getLogger("redact-test")
        logger.handlers = [handler]
        logger.propagate = False
        logger.setLevel(logging.DEBUG)

        logger.info("login with %s", COOKIE)
        try:
            raise RuntimeError(f"bad key {KEY}")
        except RuntimeError:
            logger.exception("failed")

        written = stream.getvalue()
        self.assertNotIn("aaaa1111", written)
        self.assertNotIn(KEY, written)
        self.assertIn(MASK, written)


class Burners(unittest.TestCase):
    def test_reads_numbered_burners(self):
        env = {"X_BURNER_USERNAME": "@burner1", "X_BURNER_COOKIES": COOKIE, "X_BURNER_2_USERNAME": "burner2", "X_BURNER_2_COOKIES": COOKIE}
        burners = load_burners(env)
        self.assertEqual([b.username for b in burners], ["burner1", "burner2"])
        self.assertEqual(burners[0].as_dict()["ct0"], "dddd4444eeee5555ffff6666")

    def test_errors_name_the_setting_and_never_the_value(self):
        for env in ({}, {"X_BURNER_USERNAME": "b"}, {"X_BURNER_USERNAME": "b", "X_BURNER_COOKIES": "auth_token=onlythis123456"}):
            with self.assertRaises(ConfigError) as caught:
                load_burners(env)
            self.assertNotIn("onlythis123456", str(caught.exception))
        with self.assertRaises(ConfigError) as caught:
            load_burners({"X_BURNER_USERNAME": "b", "X_BURNER_COOKIES": "auth_token=onlythis123456"})
        self.assertIn("ct0", str(caught.exception))


class AuthDetection(unittest.TestCase):
    def test_by_name_and_by_message(self):
        class Unauthorized(Exception):
            pass

        class AccountLocked(Exception):
            pass

        self.assertTrue(looks_like_auth_failure(Unauthorized("x")))
        self.assertTrue(looks_like_auth_failure(AccountLocked("x")))
        self.assertTrue(looks_like_auth_failure(RuntimeError("HTTP 401 from X")))
        self.assertTrue(looks_like_auth_failure(RuntimeError("Could not authenticate you")))
        self.assertFalse(looks_like_auth_failure(RuntimeError("connection reset")))
        self.assertFalse(looks_like_auth_failure(KeyError("x")))


class Stub:
    def __init__(self, name, result=None, error=None):
        self.name, self.result, self.error, self.calls = name, result, error, 0

    async def fetch_one(self, handle, since_id, limit):
        self.calls += 1
        if self.error:
            raise self.error
        return self.result


class Composite(unittest.IsolatedAsyncioTestCase):
    async def test_falls_back_when_the_first_adapter_fails(self):
        first, second = Stub("a", error=FetchError("rate limited")), Stub("b", result=["ok"])
        self.assertEqual(await Fetchers([first, second]).fetch_one("h", None, 5), ["ok"])
        self.assertEqual((first.calls, second.calls), (1, 1))

    async def test_falls_back_when_the_first_adapter_is_not_installed(self):
        second = Stub("b", result=["ok"])
        self.assertEqual(await Fetchers([Stub("a", error=ImportError("no twscrape")), second]).fetch_one("h", None, 5), ["ok"])

    async def test_auth_failure_only_when_every_adapter_fails_to_log_in(self):
        with self.assertRaises(AuthFailure):
            await Fetchers([Stub("a", error=AuthFailure("x")), Stub("b", error=AuthFailure("y"))]).fetch_one("h", None, 5)

    async def test_mixed_failures_are_a_fetch_error_not_an_auth_failure(self):
        with self.assertRaises(FetchError):
            await Fetchers([Stub("a", error=AuthFailure("x")), Stub("b", error=FetchError("outage"))]).fetch_one("h", None, 5)

    async def test_a_working_first_adapter_is_the_only_one_called(self):
        first, second = Stub("a", result=["ok"]), Stub("b", result=["no"])
        await Fetchers([first, second]).fetch_one("h", None, 5)
        self.assertEqual(second.calls, 0)


class Fixture(unittest.IsolatedAsyncioTestCase):
    async def test_filters_by_account_and_since_id_newest_first(self):
        fetcher = FixtureFetcher(__import__("pathlib").Path(__file__).resolve().parents[1] / "fixtures" / "sample_tweets.json")
        everything = await fetcher.fetch_one("rohoolagi", None, 50)
        self.assertEqual([t.id for t in everything], sorted((t.id for t in everything), reverse=True))
        newer = await fetcher.fetch_one("RohoolAgi", everything[1].id, 50)
        self.assertEqual([t.id for t in newer], [everything[0].id])
        self.assertTrue(all(t.created_at.tzinfo is not None for t in everything))


if __name__ == "__main__":
    unittest.main()
