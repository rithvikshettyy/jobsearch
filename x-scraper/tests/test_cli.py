import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

import x_scraper

ROOT = Path(__file__).resolve().parents[1]


class Utf8Output(unittest.TestCase):
    def test_a_dry_run_survives_a_cp1252_console_and_a_rupee_sign(self):
        """A kept tweet with a salary in rupees used to crash the dry run with UnicodeEncodeError on Windows."""
        fixture = {
            "tweets": [
                {
                    "id": "1850000000000000099",
                    "username": "RohoolAgi",
                    "hours_ago": 1,
                    "text": "VANCO AI: AI Engineer Intern in Bengaluru, ₹50,000 / month \U0001F680 https://jobs.lever.co/vanco/abc",
                    "links": ["https://jobs.lever.co/vanco/abc"],
                }
            ]
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "fixture.json"
            path.write_text(json.dumps(fixture), encoding="utf-8")

            real_stdout = sys.stdout
            raw = io.BytesIO()
            sys.stdout = io.TextIOWrapper(raw, encoding="cp1252", write_through=True)
            try:
                code = x_scraper.main(["--dry-run", "--fixture", str(path), "--env", str(Path(tmp) / "missing.env")])
                sys.stdout.flush()
            finally:
                sys.stdout = real_stdout

        self.assertEqual(code, 0)
        printed = raw.getvalue().decode("utf-8")
        self.assertIn("₹50,000", printed)
        self.assertIn("would_push", printed)


if __name__ == "__main__":
    unittest.main()
