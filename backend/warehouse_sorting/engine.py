from __future__ import annotations

import copy
import hashlib
import os
import time
from datetime import datetime, timezone
from statistics import mean, stdev

from .config import ROOT, validate_mapping, validate_scenario
from .runtime import Runtime
from .search import METHODS, SearchSession
from .store import Store


def aggregate(evaluations: list[dict]) -> dict:
    completed = [e for e in evaluations if e["status"] == "completed"]
    if not completed or len(completed) != len(evaluations):
        return {"status": "failed", "throughput": None}
    values = [e["metrics"]["throughput"] for e in completed]
    zones = [{key: mean(e["auxiliary"]["zones"][i][key] for e in completed)
              for key in ("trafficWaitFraction", "closedFraction")} for i in range(12)]
    return {"status": "completed", "throughput": mean(values), "auxiliary": {"zones": zones},
            "replicateStd": stdev(values) if len(values) > 1 else None,
            "replicateCount": len(values), "evaluationIds": [e["id"] for e in completed]}


class Engine:
    def __init__(self, store: Store, runtime: Runtime | None = None):
        self.store, self.runtime = store, runtime or Runtime(store)

    def _create(self, scenario, method, budget, batch_size, optimizer_seed, simulation_seeds,
                history_studies, name, study_id, record_trace, regime=None):
        validate_scenario(scenario)
        if not simulation_seeds or len(set(simulation_seeds)) != len(simulation_seeds):
            raise ValueError("Use distinct simulation seeds for independent repetitions")
        if any(type(s) is not int or not 0 <= s <= 4294967295 for s in simulation_seeds):
            raise ValueError("Simulation seeds must be unsigned 32-bit integers")
        if type(budget) is not int or budget < len(simulation_seeds) or budget % len(simulation_seeds):
            raise ValueError("The call budget must be a positive multiple of the replicate count")
        if type(batch_size) is not int or batch_size < 1:
            raise ValueError("Batch size must be a positive integer")
        if method != "manual" and (method not in METHODS or type(optimizer_seed) is not int or not 0 <= optimizer_seed <= 4294967295):
            raise ValueError("Use a known search method and an unsigned 32-bit optimizer seed")
        if not self.runtime.identity()["ready"]:
            raise RuntimeError("Build the native simulator before starting an evaluation")
        identifier = study_id or self.store.new_id("study")
        if self.store.path("studies", identifier).exists():
            raise ValueError("Study identifier already exists")
        source_files = [ROOT / "backend/warehouse_sorting" / name for name in sorted(
            ("config.py", "runtime.py", "engine.py", "features.py", "mapping.py", "model.py", "search.py", "store.py"))]
        source_hash = hashlib.sha256(b"".join(p.name.encode() + p.read_bytes() for p in source_files)).hexdigest()
        history_ledger = {}
        identity = self.runtime.identity()
        if len({s["id"] for s in history_studies}) != len(history_studies):
            raise ValueError("Historical studies must not be repeated")
        for source in history_studies:
            if source["status"] not in ("completed", "cancelled") or not self.observations([source]):
                raise ValueError("Historical studies must contain completed measurements and be inactive")
            if any(source.get("simulator", {}).get(key) != identity[key]
                   for key in ("version", "upstreamRevision", "plannerRevision", "patchRevision")):
                raise ValueError("Historical measurements use a different simulator version")
            if source["costs"].get("historyCalls", 0) and not source.get("historyLedger"):
                raise ValueError("Historical learning costs lack source provenance")
            for entry in source.get("historyLedger", []):
                history_ledger[entry["studyId"]] = copy.deepcopy(entry)
            history_ledger[source["id"]] = {
                "studyId": source["id"], "calls": source["costs"]["started"],
                "seconds": sum(source["costs"].get(key, 0.) for key in
                               ("simulationSeconds", "trainingSeconds", "selectionSeconds"))}
        study = {"schemaVersion": 1, "id": identifier, "name": name or f"{scenario['name']} · {method}",
                 "createdAt": datetime.now(timezone.utc).isoformat(), "scenario": copy.deepcopy(scenario),
                 "method": method, "regime": regime or ("history" if history_studies else "cold-start"),
                 "optimizerSeed": optimizer_seed, "simulationSeeds": list(simulation_seeds),
                 "budget": budget, "budgetUnit": "started simulation calls", "batchSize": batch_size,
                 "recordTrace": record_trace, "status": "running", "candidates": [],
                 "historyIds": [s["id"] for s in history_studies], "simulator": self.runtime.identity(),
                 "implementationHash": source_hash, "processId": os.getpid(),
                 "historyLedger": list(history_ledger.values()),
                 "costs": {"started": 0, "completed": 0, "failed": 0, "cancelled": 0, "cacheHits": 0,
                           "replicates": 0, "executedTicks": 0, "unknownExecutedTickRuns": 0,
                           "simulationSeconds": 0., "trainingSeconds": 0., "selectionSeconds": 0.,
                           "historyCalls": sum(entry["calls"] for entry in history_ledger.values()),
                           "historySeconds": sum(entry["seconds"] for entry in history_ledger.values())}}
        self.store.write("studies", identifier, study)
        return study

    def _record(self, study, candidate, evaluation):
        candidate["evaluations"].append(evaluation)
        costs = study["costs"]
        if evaluation.get("cacheOf"):
            costs["cacheHits"] += 1
        else:
            costs["started"] += int(evaluation.get("started", False))
            costs[evaluation["status"]] += 1
            costs["replicates"] += int(len(candidate["evaluations"]) > 1)
            ticks = evaluation.get("executedTicks")
            costs["executedTicks"] += ticks or 0
            costs["unknownExecutedTickRuns"] += int(ticks is None)
            costs["simulationSeconds"] += evaluation["wallSeconds"]
        candidate["calls"] = costs["started"]
        self.store.write("studies", study["id"], study)

    @staticmethod
    def observations(studies):
        result = []
        for study in studies:
            for candidate in study["candidates"]:
                if candidate["status"] != "completed" or candidate["throughput"] is None:
                    continue
                summary = aggregate(candidate["evaluations"])
                if summary["status"] == "completed" and len(candidate["evaluations"]) == len(study["simulationSeeds"]):
                    result.append({"id": f"{study['id']}/{candidate['id']}", "mapping": candidate["mapping"],
                                   "scenario": study["scenario"], **summary})
        return result

    def _evaluate_candidate(self, study, candidate, simulation_seeds, cancelled, on_update, purpose):
        for seed in simulation_seeds:
            if cancelled and cancelled():
                break
            candidate["activeSeed"] = seed
            self.store.write("studies", study["id"], study)
            if on_update:
                on_update(study)
            if cancelled and cancelled():
                break
            result = self.runtime.evaluate(study["scenario"], candidate["mapping"], seed,
                                           study_id=study["id"], candidate_id=candidate["id"],
                                           purpose=purpose, record_trace=study["recordTrace"])
            self._record(study, candidate, result)
            if on_update:
                on_update(study)
        candidate.pop("activeSeed", None)
        summary = aggregate(candidate["evaluations"])
        if len(candidate["evaluations"]) != len(simulation_seeds):
            summary = {"status": "cancelled", "throughput": None}
        candidate.update(summary)
        self.store.write("studies", study["id"], study)
        if on_update:
            on_update(study)
        return {**summary, "id": f"{study['id']}/{candidate['id']}"}

    def run_search(self, scenario, method="spatial_aux", *, budget=24, batch_size=3,
                   optimizer_seed=0, simulation_seeds=None, history_studies=None,
                   record_trace=False, name=None, study_id=None, cancelled=None,
                   on_update=None, pool_size=128, epochs=70):
        seeds = [11, 29] if simulation_seeds is None else simulation_seeds
        history = history_studies or []
        if type(pool_size) is not int or pool_size < 1 or type(epochs) is not int or epochs < 1:
            raise ValueError("Candidate pool and training epochs must be positive integers")
        study = self._create(scenario, method, budget, batch_size, optimizer_seed, seeds, history,
                             name, study_id, record_trace)
        session = None
        start = time.perf_counter()
        try:
            session = SearchSession(scenario, method=method, seed=optimizer_seed,
                                    budget=budget // len(seeds), batch_size=batch_size,
                                    history=self.observations(history), pool_size=pool_size, epochs=epochs)
            study["searchConfig"] = {"poolSize": pool_size, "epochs": epochs, "initialSize": session.initial_size}
            while not session.finished:
                if cancelled and cancelled():
                    session.cancel(); break
                proposals = session.ask()
                study["costs"].update(trainingSeconds=session.training_seconds, selectionSeconds=session.selection_seconds)
                if not proposals:
                    break
                # All predictions in a batch are frozen before its first real simulation.
                for proposal in proposals:
                    parent = next((c["id"] for c in study["candidates"] if c["mapping"] == proposal.get("parentMapping")), None)
                    candidate = {k: copy.deepcopy(v) for k, v in proposal.items() if k != "parentMapping"}
                    candidate.update(parentId=parent, evaluations=[], throughput=None, calls=study["costs"]["started"])
                    if candidate.get("acquisition"):
                        p, a = candidate["prediction"], candidate["acquisition"]
                        a.update(score=a["ucb"], uncertainty=p["std"], improvement=p["mean"] - (session.best["throughput"] if session.best else 0))
                    study["candidates"].append(candidate)
                self.store.write("studies", study["id"], study)
                for candidate in study["candidates"][-len(proposals):]:
                    if cancelled and cancelled():
                        candidate["status"] = "cancelled"
                        session.cancel(); continue
                    candidate["status"] = "running"
                    summary = self._evaluate_candidate(study, candidate, seeds, cancelled, on_update, "selection")
                    session.tell(candidate["id"], summary)
                    if cancelled and cancelled():
                        session.cancel()
            if not session.stopped:
                session.finalize_model()
            study["status"] = "cancelled" if session.stopped else "completed"
            if session.fit_records:
                extension = ".joblib" if method == "simple" else ".pt"
                path = self.store.path("models", study["id"], extension)
                session.model.save(path)
                study["modelFile"] = path.name
                study["modelHash"] = hashlib.sha256(path.read_bytes()).hexdigest()
            study["search"] = session.snapshot()
            # Candidate data already carries the full evidence; avoid duplicating it in every study.
            study["search"].pop("records", None)
            study["search"].pop("best", None)
        except Exception as error:
            study.update(status="failed", error=str(error))
            raise
        finally:
            if session is not None:
                study["costs"].update(trainingSeconds=session.training_seconds, selectionSeconds=session.selection_seconds)
            study["wallSeconds"] = time.perf_counter() - start
            self.store.write("studies", study["id"], study)
            if on_update:
                on_update(study)
        return study

    def run_manual(self, scenario, mapping, *, simulation_seeds=None, record_trace=True,
                   name=None, study_id=None, cancelled=None, on_update=None,
                   source_study_id=None, source_candidate_id=None, purpose="manual"):
        validate_mapping(scenario, mapping)
        seeds = [101, 211] if simulation_seeds is None else simulation_seeds
        study = self._create(scenario, "manual", len(seeds), 1, None, seeds, [], name,
                             study_id, record_trace, "manual")
        study.update(sourceStudyId=source_study_id, sourceCandidateId=source_candidate_id)
        candidate = {"id": "c0001", "mapping": list(mapping), "operation": "fixed-mapping",
                     "parentId": source_candidate_id, "changedChutes": [], "prediction": None,
                     "evaluations": [], "throughput": None, "calls": 0, "status": "running"}
        study["candidates"].append(candidate)
        start = time.perf_counter()
        try:
            summary = self._evaluate_candidate(study, candidate, seeds, cancelled, on_update, purpose)
            study["status"] = summary["status"]
        except Exception as error:
            study.update(status="failed", error=str(error))
            raise
        finally:
            study["wallSeconds"] = time.perf_counter() - start
            self.store.write("studies", study["id"], study)
            if on_update:
                on_update(study)
        return study
