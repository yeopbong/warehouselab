from __future__ import annotations

import gzip
import json
import re
import threading
import uuid
from pathlib import Path

from .config import data_dir


class Store:
    def __init__(self, root: Path | None = None):
        self.root = Path(root or data_dir())
        self.lock = threading.RLock()
        for directory in ("studies", "evaluations", "traces", "models", "native"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)

    @staticmethod
    def new_id(prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:16]}"

    def path(self, kind: str, identifier: str, suffix: str = ".json") -> Path:
        if not isinstance(identifier, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", identifier):
            raise ValueError("Invalid record identifier")
        return self.root / kind / (identifier + suffix)

    def write(self, kind: str, identifier: str, value: dict) -> None:
        path = self.path(kind, identifier)
        with self.lock:
            temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
            try:
                temporary.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False))
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)

    def read(self, kind: str, identifier: str) -> dict:
        with self.lock:
            return json.loads(self.path(kind, identifier).read_text())

    def write_trace(self, identifier: str, trace: dict) -> None:
        path = self.path("traces", identifier, ".json.gz")
        temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
        try:
            with gzip.open(temporary, "wt", compresslevel=3) as target:
                json.dump(trace, target, separators=(",", ":"), allow_nan=False)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    def read_trace(self, identifier: str) -> dict:
        with gzip.open(self.path("traces", identifier, ".json.gz"), "rt") as source:
            return json.load(source)

    def studies(self) -> list[dict]:
        return [json.loads(p.read_text()) for p in sorted((self.root / "studies").glob("*.json"))]

    def catalog(self, scenarios: list[dict]) -> dict:
        records = self.studies()
        summaries = [{"id": s["id"], "name": s["name"], "scenarioId": s["scenario"]["id"],
                      "method": s["method"], "regime": s["regime"], "status": s["status"],
                      "bestThroughput": max((c["throughput"] for c in s["candidates"]
                                             if c["status"] == "completed" and c["throughput"] is not None), default=None)}
                     for s in records]
        return {"schemaVersion": 1, "scenarios": scenarios, "studies": summaries,
                "defaultStudyId": summaries[-1]["id"] if summaries else None}
