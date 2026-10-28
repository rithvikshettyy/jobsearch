import unittest
from datetime import datetime, timezone

from xs.filtering import guess_company, make_title, matches, normalize, to_item
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


class FoundInRealTweets(unittest.TestCase):
    """Each case is a pattern from a live dry run against the two accounts."""

    cfg = __import__("json").loads((__import__("pathlib").Path(__file__).resolve().parents[1] / "config.json").read_text(encoding="utf-8"))

    def keep(self, text):
        return matches(text, self.cfg["keywords"]["include"], self.cfg["keywords"]["exclude"])[0]

    def test_a_plural_role_word_matches(self):
        self.assertTrue(matches("Hiring 2 AI interns at FOXO lab, Bengaluru", ["ai intern"], [])[0])
        self.assertTrue(matches("Hiring ML engineers", ["ml engineer"], [])[0])
        self.assertFalse(matches("Hiring chains", ["chain engineer"], [])[0])

    def test_the_word_recruiter_no_longer_hides_an_fde_internship(self):
        text = "Just saw VANCO AI opened Forward Deployed Engineer (FDE) Intern roles in Bengaluru. Ask a recruiter to refer you."
        self.assertTrue(self.keep(text))

    def test_a_course_launch_that_mentions_llms_is_not_a_job(self):
        self.assertFalse(self.keep("Today I am launching a course: the hands-on way to learn AI engineering, LLMs, RAG, agents"))
        self.assertFalse(self.keep("a lot of people want to learn LLMs. 9 papers i would recommend, in order"))

    def test_the_posts_the_accounts_actually_make_still_pass(self):
        self.assertTrue(self.keep("craftAI AI Engineer - FDE https://t.co/x"))
        self.assertTrue(self.keep("Kiwi AI Labs team [AI Engineer] https://t.co/y"))

    def test_senior_and_generic_roles_are_still_dropped(self):
        self.assertFalse(self.keep("Refold AI is Hiring! Open Positions: Head of Engineering, Senior Frontend Engineer"))
        self.assertFalse(self.keep("VideoSDK Software Developer https://t.co/z"))

    def test_html_entities_do_not_leak_into_titles(self):
        self.assertEqual(make_title("Fresh drop: R&amp;D Engineer &gt; Pune"), "Fresh drop: R&D Engineer > Pune")


class CompanyFromAForm(unittest.TestCase):
    def test_a_form_or_link_page_host_names_no_company(self):
        for url in ("https://docs.google.com/forms/d/e/abc/viewform", "https://forms.gle/abc", "https://acme.notion.site/job", "https://linktr.ee/acme", "https://www.linkedin.com/jobs/view/1"):
            self.assertEqual(company_from_url(url), "Unknown", url)

    def test_the_company_is_read_from_the_tweet_instead(self):
        self.assertEqual(guess_company("craftAI AI Engineer - FDE https://t.co/x"), "craftAI")
        self.assertEqual(guess_company("Kiwi AI Labs team [AI Engineer] https://t.co/y"), "Kiwi AI Labs")
        self.assertEqual(guess_company("VideoSDK Software Developer https://t.co/z"), "VideoSDK")
        self.assertEqual(guess_company("JLL Software Engineer I Bengaluru"), "JLL")

    def test_it_gives_up_rather_than_inventing_a_name(self):
        for text in ("Forward Deployed Engineer role open at Gamma", "We're hiring an AI Engineer", "hiring", "", "a b c d e f Engineer"):
            self.assertIsNone(guess_company(text), text)


class CompanyFromASentence(unittest.TestCase):
    def test_the_name_before_the_hiring_verb(self):
        self.assertEqual(guess_company("Just saw VANCO AI opened up Forward Deployed Engineer (FDE) Intern roles in Bengaluru"), "VANCO AI")
        self.assertEqual(guess_company("Fresh engineering drop: Lokal is hiring a Product Intern in Bengaluru"), "Lokal")
        self.assertEqual(guess_company("Quick heads up for anyone job hunting right now: Auto Wisdom is hiring for Software Developer"), "Auto Wisdom")
        self.assertEqual(guess_company("Solid opportunity at RentoMojo is hiring SDE 1"), "RentoMojo")

    def test_an_aggregator_link_page_is_not_the_company(self):
        self.assertEqual(company_from_url("https://joborbit.live/job/4305"), "Unknown")


class LinkedInPostings(unittest.TestCase):
    def test_every_spelling_of_one_posting_becomes_its_number(self):
        canonical = "https://www.linkedin.com/jobs/view/4000000001"
        for raw in (
            "https://in.linkedin.com/jobs/view/ai-engineer-at-acme-4000000001?refId=abc&trackingId=xyz&position=3",
            "https://www.linkedin.com/jobs/view/4000000001/?trackingId=other",
            "http://linkedin.com/jobs/view/4000000001",
        ):
            self.assertEqual(strip_tracking(raw), canonical, raw)

    def test_other_pages_and_other_hosts_are_untouched(self):
        self.assertEqual(strip_tracking("https://www.linkedin.com/company/acme?trk=x"), "https://linkedin.com/company/acme")
        self.assertEqual(strip_tracking("https://notlinkedin.com/jobs/view/4000000001"), "https://notlinkedin.com/jobs/view/4000000001")
