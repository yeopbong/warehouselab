from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
import os
import subprocess
import time
from pathlib import Path

from .config import ROOT, digest, validate_mapping, validate_scenario
from .store import Store

UPSTREAM = "c2566ac6aa7e1debd94756bb04ce7bd794d1fbed"
WPPL = "4d2db54c760145e83f5d86ec4da7b512e57fc5fb"


class Runtime:
    def __init__(self, store: Store, binary: Path | None = None):
        self.store = store
        self.binary = Path(binary or os.environ.get("WAREHOUSE_TMO_BINARY", ROOT / ".cache/tmo/build/tmo-run"))
        self._identity = None
        self._identity_signature = None

    def identity(self) -> dict:
        files = [ROOT / "native/tmo/runtime.patch", ROOT / "native/tmo/bridge.cpp", ROOT / "native/tmo/CMakeLists.txt"]
        signature = tuple((p.stat().st_mtime_ns, p.stat().st_size) if p.is_file() else None
                          for p in files + [self.binary])
        if signature != self._identity_signature:
            patch = hashlib.sha256(b"".join(p.read_bytes() for p in files)).hexdigest()
            self._identity = {"ready": self.binary.is_file(), "upstreamRevision": UPSTREAM,
                              "plannerRevision": WPPL, "patchRevision": patch,
                              "buildHash": hashlib.sha256(self.binary.read_bytes()).hexdigest() if self.binary.is_file() else None,
                              "version": "rss-1.1-parcel-routing"}
            self._identity_signature = signature
        return dict(self._identity)

    @staticmethod
    def _validate_result(raw: dict, request: dict, version: str) -> None:
        metrics, zones, trace = raw["metrics"], raw["zone_metrics"], raw["trace"]
        if not math.isfinite(raw["wall_seconds"]) or raw["wall_seconds"] < 0:
            raise ValueError("Native elapsed time must be finite and nonnegative")
        if raw["runtime_version"] != version:
            raise ValueError("Native runtime version does not match the evaluation record")
        if type(metrics["valid"]) is not bool or metrics["ticks"] != request["horizon"]:
            raise ValueError("Native result did not validate the requested horizon")
        for key in ("sorted", "recirculated", "rerouted", "traffic_wait_ticks", "service_wait_ticks", "ticks"):
            if type(metrics[key]) is not int or metrics[key] < 0:
                raise ValueError(f"Invalid native metric: {key}")
        for key in ("throughput", "upstream_task_throughput"):
            if not isinstance(metrics[key], (float, int)) or not math.isfinite(metrics[key]) or metrics[key] < 0:
                raise ValueError(f"Invalid native metric: {key}")
        if not math.isclose(metrics["throughput"], metrics["sorted"] / metrics["ticks"], abs_tol=1e-12):
            raise ValueError("Native throughput does not match sorted parcel count")
        if len(zones) != 12 or [z["zone"] for z in zones] != list(range(12)):
            raise ValueError("Native zone supervision must use the 3 by 4 spatial grid")
        for zone in zones:
            for key in ("traffic_wait_fraction", "closed_fraction"):
                if not math.isfinite(zone[key]) or not 0 <= zone[key] <= 1:
                    raise ValueError(f"Invalid native zone metric: {key}")
        if sum(z["traffic_wait_ticks"] for z in zones) != metrics["traffic_wait_ticks"]:
            raise ValueError("Native waiting supervision does not match the aggregate")
        positions = trace["positions"]
        if request["record_trace"]:
            if len(positions) != metrics["ticks"] + 1 or any(len(frame) != request["agents"] for frame in positions):
                raise ValueError("Native position trace is incomplete")
        elif positions:
            raise ValueError("Native position recording did not follow the request")
        if len(trace["curve"]) != metrics["ticks"] + 1 or trace["curve"][-1] != [metrics["ticks"], metrics["sorted"], metrics["recirculated"], metrics["rerouted"]]:
            raise ValueError("Native cumulative curve does not match the final metrics")
        events = Counter(e["type"] for e in trace["events"])
        if any(events[event] != metrics[metric] for event, metric in
               (("dropoff", "sorted"), ("recirculate", "recirculated"), ("reroute", "rerouted"))):
            raise ValueError("Native business events do not match the measured metrics")

    def evaluate(self, scenario: dict, mapping: list[str], seed: int, *, study_id: str,
                 candidate_id: str, purpose: str = "selection", record_trace: bool = True,
                 force: bool = False, timeout: float = 600) -> dict:
        validate_scenario(scenario)
        validate_mapping(scenario, mapping)
        if type(seed) is not int or not 0 <= seed <= 4294967295:
            raise ValueError("Simulation seed must be an unsigned 32-bit integer")
        if not self.binary.is_file():
            raise RuntimeError("Native simulator is not built. Run python scripts/setup-tmo.py first.")
        destinations = [d for d in scenario["destinations"] if not d.get("recirculation")]
        destinations += [d for d in scenario["destinations"] if d.get("recirculation")]
        lookup = {d["id"]: i for i, d in enumerate(destinations)}
        request = {"map": {"name": scenario["map"]["id"], "weight": False,
                           "n_row": scenario["map"]["height"], "n_col": scenario["map"]["width"],
                           "layout": scenario["map"]["layout"]},
                   "mapping": [lookup[d] for d in mapping], "demand": [d["weight"] for d in destinations],
                   "agents": scenario["fleetSize"], "horizon": scenario["horizon"], "seed": seed,
                   "pickup_wait": scenario.get("pickupWait", 0), "dropoff_wait": scenario.get("dropoffWait", 0),
                   "record_trace": record_trace}
        cache_key = digest({"request": request, "runtime": self.identity(), "study": study_id,
                            "scenario": digest(scenario), "mapping": digest(mapping)})
        # Caches are scoped to an optimization run, never free observations from a competing method.
        if not force:
            cache_start = time.perf_counter()
            for cached in (self.store.root / "evaluations").glob("*.json"):
                previous = json.loads(cached.read_text())
                if previous.get("cacheKey") != cache_key or previous["status"] != "completed" or previous.get("cacheOf"):
                    continue
                identifier = self.store.new_id("eval")
                measurement = previous["id"]
                trace = self.store.read_trace(measurement)
                trace.update(evaluationId=identifier, candidateId=candidate_id,
                             measurementEvaluationId=measurement, source="cached-measurement")
                self.store.write_trace(identifier, trace)
                hit = {**previous, "id": identifier, "candidateId": candidate_id, "purpose": purpose,
                       "cacheOf": measurement, "started": False, "wallSeconds": 0, "nativeSeconds": 0,
                       "retrievalSeconds": time.perf_counter() - cache_start,
                       "executedTicks": 0, "measuredTicks": previous["executedTicks"],
                       "traceUrl": f"/api/sorting/evaluations/{identifier}/trace" if record_trace else None}
                self.store.write("evaluations", identifier, hit)
                return hit
        identifier = self.store.new_id("eval")
        work = self.store.root / "native" / identifier
        work.mkdir(parents=True)
        (work / "input.json").write_text(json.dumps(request, allow_nan=False))
        evaluation = {"id": identifier, "studyId": study_id, "candidateId": candidate_id,
                      "processId": os.getpid(),
                      "status": "running", "purpose": purpose, "simulationSeed": seed,
                      "requestedHorizon": scenario["horizon"], "executedTicks": None,
                      "wallSeconds": 0., "metrics": None, "auxiliary": None, "traceUrl": None,
                      "cacheOf": None, "cacheKey": cache_key, "started": True,
                      "scenarioHash": digest(scenario), "mappingHash": digest(mapping), "simulator": self.identity()}
        self.store.write("evaluations", identifier, evaluation)
        start = time.perf_counter()
        try:
            with (work / "runtime.log").open("w") as log:
                result = subprocess.run([str(self.binary), str(work / "input.json"), str(work / "output.json")],
                                        stdout=log, stderr=subprocess.STDOUT, timeout=timeout)
            evaluation["wallSeconds"] = time.perf_counter() - start
            if result.returncode:
                raise RuntimeError(f"Native simulator exited with status {result.returncode}")
            raw = json.loads((work / "output.json").read_text())
            self._validate_result(raw, request, evaluation["simulator"]["version"])
            metrics = raw["metrics"]
            evaluation.update(status="completed" if metrics["valid"] else "failed",
                              executedTicks=metrics["ticks"], nativeSeconds=raw.get("wall_seconds"),
                              metrics={"throughput": metrics["throughput"], "sortedParcels": metrics["sorted"],
                                       "recirculated": metrics["recirculated"], "reroutes": metrics["rerouted"],
                                       "upstreamTaskThroughput": metrics["upstream_task_throughput"],
                                       "trafficWaitTicks": metrics["traffic_wait_ticks"],
                                       "serviceWaitTicks": metrics["service_wait_ticks"], "valid": metrics["valid"]},
                              auxiliary={"zones": [{"trafficWaitFraction": z["traffic_wait_fraction"],
                                                     "closedFraction": z["closed_fraction"],
                                                     "trafficWaitTicks": z["traffic_wait_ticks"],
                                                     "closedChuteTicks": z["closed_chute_ticks"],
                                                     "serviceWaitTicks": z["service_wait_ticks"],
                                                     "zone": z["zone"], "chutes": z["chutes"]} for z in raw["zone_metrics"]]})
            trace = {**raw["trace"], "evaluationId": identifier, "candidateId": candidate_id,
                     "scenarioId": scenario["id"], "horizon": metrics["ticks"], "seed": seed,
                     "mapWidth": scenario["map"]["width"], "mapHeight": scenario["map"]["height"],
                     "destinationIds": [d["id"] for d in destinations], "metrics": evaluation["metrics"],
                     "recordedEveryTicks": 1, "source": "measured"}
            self.store.write_trace(identifier, trace)
            if record_trace:
                evaluation["traceUrl"] = f"/api/sorting/evaluations/{identifier}/trace"
            else:
                evaluation["traceUrl"] = None
            evaluation["eventTraceAvailable"] = True
            (work / "output.json").unlink()
            if not metrics["valid"]:
                evaluation["error"] = "The native motion validator reported an invalid run"
        except (OSError, ValueError, TypeError, KeyError, IndexError, RuntimeError, subprocess.TimeoutExpired) as error:
            evaluation.update(status="failed", error=str(error), wallSeconds=time.perf_counter() - start)
        evaluation["wallSeconds"] = time.perf_counter() - start
        self.store.write("evaluations", identifier, evaluation)
        return evaluation
