import unittest
from datetime import datetime, timezone

from xs.filtering import make_title, matches, normalize, to_item
from xs.links import company_from_url, expand_url, extract_urls, pick_job_link, strip_tracking
from xs.model import RawTweet


class StripTracking(unittest.TestCase):
    def test_https_no_www_no_fragment_no_trailing_slash(self):
        self.assertEqual(strip_tracking("http://www.Example.com/jobs/1/#apply"), "https://example.com/jobs/1")

    def test_drops_tracking_keeps_job_params(self):
        url = "https://boards.greenhouse.io/acme/jobs/9?utm_source=x&gh_src=a&gh_jid=77&ref=tw&lever-source[]=li"
        self.assertEqual(strip_tracking(url), "https://boards.greenhouse.io/acme/jobs/9?gh_jid=77")

    def test_matches_the_worker_for_the_same_posting(self):
        self.assertEqual(
            strip_tracking("https://jobs.lever.co/acme/uuid-1?lever-source=Twitter"),
            strip_tracking("http://www.jobs.lever.co/acme/uuid-1/"),
        )

    def test_rejects_non_http(self):
        for bad in ("", "not a url", "javascript:alert(1)", "ftp://a.com/x", "mailto:a@b.com"):
            self.assertIsNone(strip_tracking(bad), bad)


class Expansion(unittest.TestCase):
    def test_follows_a_known_shortener_only(self):
        calls = []

        def resolver(url):
            calls.append(url)
            return "https://jobs.ashbyhq.com/gamma/1"

        self.assertEqual(expand_url("https://bit.ly/abc", resolver), "https://jobs.ashbyhq.com/gamma/1")
        # An ordinary link is never fetched just to read a redirect.
        self.assertEqual(expand_url("https://random.example.com/x", resolver), "https://random.example.com/x")
        self.assertEqual(calls, ["https://bit.ly/abc"])

    def test_a_dead_short_link_keeps_the_original(self):
        def boom(_url):
            raise RuntimeError("timeout")

        self.assertEqual(expand_url("https://t.co/x", boom), "https://t.co/x")
        self.assertEqual(expand_url("https://t.co/x", lambda _u: None), "https://t.co/x")
        self.assertEqual(expand_url("https://t.co/x", None), "https://t.co/x")


class PickLink(unittest.TestCase):
    def test_extract_trims_punctuation(self):
        self.assertEqual(extract_urls("apply (https://a.com/j?x=1), now."), ["https://a.com/j?x=1"])

    def test_prefers_a_job_board_over_a_blog(self):
        urls = ["https://someblog.example.com/post", "https://boards.greenhouse.io/acme/jobs/1"]
        self.assertEqual(pick_job_link(urls), "https://boards.greenhouse.io/acme/jobs/1")

    def test_ignores_x_social_and_unresolved_tco(self):
        for url in ("https://x.com/a/status/1", "https://t.co/abc", "https://github.com/a/b", "https://youtu.be/x", "https://www.linkedin.com/posts/abc"):
            self.assertIsNone(pick_job_link([url]), url)

    def test_keeps_a_linkedin_job_link(self):
        self.assertEqual(pick_job_link(["https://www.linkedin.com/jobs/view/123"]), "https://www.linkedin.com/jobs/view/123")


class Company(unittest.TestCase):
    def test_from_ats_paths(self):
        self.assertEqual(company_from_url("https://boards.greenhouse.io/acme-labs/jobs/1"), "Acme Labs")
        self.assertEqual(company_from_url("https://jobs.lever.co/beta/9"), "Beta")
        self.assertEqual(company_from_url("https://jobs.ashbyhq.com/gamma/1"), "Gamma")
        self.assertEqual(company_from_url("https://wellfound.com/company/delta/jobs/1"), "Delta")
        self.assertEqual(company_from_url("https://acme.wd1.myworkdayjobs.com/en/role"), "Acme")

    def test_from_a_company_domain(self):
        self.assertEqual(company_from_url("https://careers.delta-labs.io/jobs/x"), "Delta Labs")
        self.assertEqual(company_from_url("https://www.example.co.uk/jobs"), "Example")

    def test_unknown_when_there_is_nothing_to_go_on(self):
        self.assertEqual(company_from_url("https://careers.com/x"), "Unknown")


class Keywords(unittest.TestCase):
    include = ["ai engineer", "ml engineer", "llm", "forward deployed"]
    exclude = ["senior", "sr", "lead", "not hiring"]

    def test_whole_word_phrase_match(self):
        self.assertTrue(matches("Hiring an AI Engineer in Pune", self.include, self.exclude)[0])
        self.assertTrue(matches("hiring AI/ML Engineer", ["ai ml engineer"], [])[0])

    def test_hashtags_and_case(self):
        self.assertTrue(matches("#LLM roles open", self.include, self.exclude)[0])

    def test_substrings_do_not_match(self):
        self.assertFalse(matches("We are hiring a chain engineer", ["ai engineer"], [])[0])
        # "lead" must not exclude "Leading": the reason is the include-list default, not an exclusion.
        self.assertEqual(matches("Leading the way", [], ["lead"]), (True, "no include list"))

    def test_exclude_beats_include(self):
        self.assertEqual(matches("Senior AI Engineer wanted", self.include, self.exclude), (False, "excluded:senior"))

    def test_no_include_hit(self):
        self.assertEqual(matches("Frontend developer wanted", self.include, self.exclude), (False, "no include keyword"))

    def test_normalize_collapses_punctuation(self):
        self.assertEqual(normalize("AI/ML  Engineer!"), " ai ml engineer ")


class ItemShape(unittest.TestCase):
    def tweet(self, text):
        return RawTweet(id="5", text=text, created_at=datetime(2026, 10, 28, 9, 0, tzinfo=timezone.utc), url="https://x.com/a/status/5", username="a")

    def test_title_drops_links_and_trailing_colon(self):
        self.assertEqual(make_title("We are hiring an AI Engineer. Apply: https://t.co/abc"), "We are hiring an AI Engineer. Apply")

    def test_long_title_is_cut_on_a_word(self):
        title = make_title("word " * 80, limit=40)
        self.assertLessEqual(len(title), 43)
        self.assertTrue(title.endswith("..."))

    def test_item_matches_the_ingest_contract(self):
        item = to_item(self.tweet("AI Engineer at Acme https://t.co/x"), "https://boards.greenhouse.io/acme/jobs/1", "Acme")
        self.assertEqual(
            set(item),
            {"url", "title", "company", "location", "remote", "source", "posted_at", "description_snippet", "tweet_url"},
        )
        self.assertEqual(item["source"], "x")
        self.assertEqual(item["tweet_url"], "https://x.com/a/status/5")
        self.assertEqual(item["posted_at"], "2026-10-28T09:00:00+00:00")
        self.assertNotIn("t.co", item["description_snippet"])


if __name__ == "__main__":
    unittest.main()
