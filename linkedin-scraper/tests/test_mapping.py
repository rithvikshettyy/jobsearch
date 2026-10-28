import json
import unittest
from pathlib import Path

from ll.mapping import canonical_url, is_remote, job_id_of, key_sentences, parse_min_yoe, posted_at, to_item

FIXTURE = json.loads((Path(__file__).resolve().parents[1] / "fixtures" / "sample_jobs.json").read_text(encoding="utf-8"))["jobs"]


class JobId(unittest.TestCase):
    def test_from_the_event_id_or_the_link(self):
        self.assertEqual(job_id_of({"job_id": "4000000001"}), "4000000001")
        self.assertEqual(job_id_of({"link": "https://in.linkedin.com/jobs/view/ai-engineer-at-acme-4000000001?refId=x"}), "4000000001")
        self.assertEqual(job_id_of({"link": "https://www.linkedin.com/jobs/view/4000000001/"}), "4000000001")
        self.assertIsNone(job_id_of({"link": "https://www.linkedin.com/company/acme"}))
        self.assertIsNone(job_id_of({}))

    def test_one_canonical_url_per_job(self):
        self.assertEqual(canonical_url("4000000001"), "https://www.linkedin.com/jobs/view/4000000001")


class MinYears(unittest.TestCase):
    def test_a_range_takes_its_low_end_and_separate_mentions_take_the_highest_floor(self):
        self.assertEqual(parse_min_yoe("We want 1-3 years of experience."), 1)
        self.assertEqual(parse_min_yoe("5+ years of experience overall. 1+ years of experience with Python."), 5)
        self.assertEqual(parse_min_yoe("At least 6 months of experience."), 0)

    def test_only_sentences_about_experience_count(self):
        # A company age or a tenure line must not turn a graduate role into a 15 year requirement.
        self.assertEqual(parse_min_yoe("We are a 15 year old company. You need 0-2 years of experience."), 0)
        self.assertIsNone(parse_min_yoe("Founded 15 years ago, we ship fast."))

    def test_none_when_no_number_is_named(self):
        self.assertIsNone(parse_min_yoe("Build things with a great team."))
        self.assertIsNone(parse_min_yoe(""))


class Snippet(unittest.TestCase):
    def test_key_sentences_pull_out_experience_ppo_and_work_authorization(self):
        text = "We love dogs. You must be authorized to work in the United States. Free snacks daily. Interns get a PPO. 3 years of experience needed."
        kept = key_sentences(text)
        self.assertIn("authorized to work in the United States", kept)
        self.assertIn("PPO", kept)
        self.assertIn("3 years of experience", kept)
        self.assertNotIn("dogs", kept)
        self.assertNotIn("snacks", kept)

    def test_the_worker_sees_the_key_sentences_first_even_when_they_sit_deep_in_a_long_description(self):
        filler = "We build great products for great customers. " * 120
        item = to_item({"job_id": "4000000009", "title": "AI Engineer", "company": "Zed", "description": filler + "No visa sponsorship is available."})
        self.assertLessEqual(len(item["description_snippet"]), 1900)
        self.assertTrue(item["description_snippet"].startswith("No visa sponsorship is available."))


    def test_a_company_age_never_reaches_the_snippet_where_the_worker_would_read_it_as_a_requirement(self):
        item = to_item(FIXTURE[0])
        self.assertNotIn("15 year", item["description_snippet"])
        self.assertIn("0-2 years of experience", item["description_snippet"])


class Fields(unittest.TestCase):
    def test_remote_is_read_from_place_title_or_insights(self):
        self.assertTrue(is_remote({"place": "Remote"}))
        self.assertTrue(is_remote({"place": "India", "insights": ["Remote"]}))
        self.assertTrue(is_remote({"place": "India", "title": "AI Engineer (Remote)"}))
        self.assertFalse(is_remote({"place": "Pune, India", "title": "AI Engineer"}))

    def test_date_becomes_an_iso_timestamp_or_nothing(self):
        self.assertEqual(posted_at({"date": "2026-10-27"}), "2026-10-27T00:00:00+00:00")
        self.assertIsNone(posted_at({"date": ""}))
        self.assertIsNone(posted_at({"date": "last week"}))


class ToItem(unittest.TestCase):
    def test_a_full_job_matches_the_ingest_contract(self):
        item = to_item(FIXTURE[0])
        self.assertEqual(item["url"], "https://www.linkedin.com/jobs/view/4000000001")
        self.assertEqual((item["title"], item["company"], item["source"]), ("AI Engineer", "Acme Labs", "linkedin"))
        self.assertEqual(item["location"], "Bengaluru, Karnataka, India")
        self.assertEqual(item["posted_at"], "2026-10-27T00:00:00+00:00")
        self.assertEqual(item["yoe_min"], 0)
        self.assertFalse(item["remote"])
        self.assertNotIn("trackingId", json.dumps(item))
        allowed = {"url", "title", "company", "location", "remote", "source", "description_snippet", "posted_at", "yoe_min"}
        self.assertLessEqual(set(item), allowed)

    def test_the_worker_can_see_why_a_job_is_not_for_you(self):
        senior = to_item(FIXTURE[2])
        self.assertEqual(senior["yoe_min"], 5)
        us_only = to_item(FIXTURE[3])
        self.assertTrue(us_only["remote"])
        self.assertIn("authorized to work in the United States", us_only["description_snippet"])
        self.assertIn("visa sponsorship", us_only["description_snippet"])

    def test_an_internship_with_a_ppo_and_no_number_has_no_yoe_but_keeps_the_ppo_sentence(self):
        intern = to_item(FIXTURE[4])
        self.assertNotIn("yoe_min", intern)
        self.assertIn("PPO", intern["description_snippet"])

    def test_a_job_without_a_company_title_or_id_is_dropped(self):
        self.assertIsNone(to_item(FIXTURE[5]))
        self.assertIsNone(to_item({"job_id": "1234567", "title": "", "company": "X"}))
        self.assertIsNone(to_item({"title": "AI Engineer", "company": "X", "link": "https://www.linkedin.com/company/x"}))


if __name__ == "__main__":
    unittest.main()
