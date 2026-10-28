"""Client for the job-bot Worker. The only place the ingest key is used."""
from __future__ import annotations

from typing import Any


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class JobBotClient:
    def __init__(self, base_url: str, key: str, http: Any = None, timeout: float = 20.0) -> None:
        if not base_url or not key:
            raise ApiError("JOB_BOT_URL and INGEST_KEY are both required")
        self.base_url = base_url.rstrip("/")
        self._headers = {"x-ingest-key": key, "content-type": "application/json"}
        if http is None:
            import httpx

            http = httpx.Client(timeout=timeout)
        self._http = http

    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        try:
            response = self._http.request(method, f"{self.base_url}{path}", headers=self._headers, json=body)
        except Exception as exc:  # noqa: BLE001 - network errors carry the URL, never the headers
            raise ApiError(f"{method} {path} could not connect: {type(exc).__name__}") from exc
        if response.status_code >= 400:
            raise ApiError(f"{method} {path} failed with HTTP {response.status_code}: {response.text[:200]}", response.status_code)
        return response.json()

    def get_state(self) -> dict[str, Any]:
        return self._call("GET", "/x/state")

    def post_state(self, accounts: dict[str, str] | None = None, run_at: str | None = None, ok: bool = False) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if accounts:
            body["accounts"] = accounts
        if run_at:
            body["run_at"] = run_at
        if ok:
            body["ok"] = True
        return self._call("POST", "/x/state", body)

    def ingest(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        return self._call("POST", "/ingest", {"jobs": items})

    def alert(self, message: str) -> dict[str, Any]:
        return self._call("POST", "/x/alert", {"message": message})
