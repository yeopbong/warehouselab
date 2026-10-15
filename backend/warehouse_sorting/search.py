"""Budgeted ask/tell search over feasible destination-to-chute mappings."""
from __future__ import annotations

import copy
import time
from typing import Callable
import numpy as np

from .features import mapping_features, normalize_scenario
from .mapping import greedy_mapping, mutate_mapping, random_mapping, validate_mapping
from .model import MappingSurrogate, SimpleSurrogate

METHODS = ("ea", "simple", "flat_aux", "spatial", "spatial_aux_top", "spatial_aux", "random")


def _distance(left: list, right: list, left_features: np.ndarray, right_features: np.ndarray) -> float:
    changed = float(np.mean(np.asarray(left, dtype=object) != np.asarray(right, dtype=object)))
    impact = float(np.clip(np.linalg.norm(left_features - right_features) / np.sqrt(left_features.size), 0, 1))
    return .7 * changed + .3 * impact


def select_batch(scenario: dict, candidates: list[dict], count: int, complementary: bool = True, beta: float = 1.) -> list[dict]:
    """Quality-filtered selection; diversity cannot rescue a low-ranked proposal."""
    if not candidates or count <= 0:
        return []
    acquisitions = np.asarray([c["prediction"]["mean"] + beta * c["prediction"]["std"] for c in candidates])
    order = np.argsort(-acquisitions, kind="stable")
    keep = min(len(order), max(count * 4, int(np.ceil(len(order) / 4))))
    gated = list(map(int, order[:keep]))
    threshold = float(acquisitions[gated[-1]])
    maximum, minimum = float(acquisitions.max()), float(acquisitions[gated].min())
    spread = max(maximum - minimum, 1e-9)
    signatures = {i: mapping_features(scenario, candidates[i]["mapping"]).nodes[:, [3, 5, 6, 7, 8]].flatten() for i in gated} if complementary else {}
    selected = []
    while gated and len(selected) < count:
        ranked = []
        for i in gated:
            novelty = min((_distance(candidates[i]["mapping"], candidates[j]["mapping"], signatures[i], signatures[j]) for j in selected), default=0.) if complementary else 0.
            score = (float(acquisitions[i]) - minimum) / spread + .2 * novelty
            ranked.append((score, -int(np.where(order == i)[0][0]), i, novelty))
        _, _, chosen, novelty = max(ranked)
        candidate = candidates[chosen]
        candidate["acquisition"] = {"ucb": float(acquisitions[chosen]), "beta": beta, "qualityThreshold": threshold, "complementarity": float(novelty), "batchRank": len(selected), "selector": "quality-diversity" if complementary else "top-ucb"}
        selected.append(chosen); gated.remove(chosen)
    return [candidates[i] for i in selected]


class SearchSession:
    def __init__(self, scenario: dict, method: str = "spatial_aux", seed: int = 0, budget: int = 24, batch_size: int = 3, history: list[dict] | None = None, initial_size: int = 4, pool_size: int = 128, epochs: int = 70):
        if method not in METHODS:
            raise ValueError(f"Unknown search method: {method}")
        if budget < 1 or batch_size < 1 or initial_size < 1:
            raise ValueError("Budget and batch sizes must be positive")
        self.scenario, self.method, self.seed = normalize_scenario(scenario), method, seed
        self.budget, self.batch_size, self.pool_size = int(budget), int(batch_size), int(pool_size)
        self.initial_size = min(int(initial_size), self.budget)
        self.rng = np.random.default_rng(seed)
        self.history = copy.deepcopy(history or [])
        self.observations: list[dict] = []
        self.records: list[dict] = []
        self.pending: dict[str, dict] = {}
        self.seen: set[tuple] = set()
        self.attempts, self.proposals, self.duplicates, self.round = 0, 0, 0, 0
        self.training_seconds, self.selection_seconds = 0., 0.
        self.fit_records: list[dict] = []
        self._fitted_count = -1
        self.stopped = False
        self.initial = []
        for strategy in ("min_dist", "cluster"):
            self._append_initial(greedy_mapping(self.scenario, strategy), strategy)
        for _ in range(1000):
            if len(self.initial) >= self.initial_size:
                break
            self._append_initial(random_mapping(self.scenario, self.rng), "demand-random")
        self.initial = self.initial[:self.initial_size]
        self.model = SimpleSurrogate(seed) if method == "simple" else MappingSurrogate(seed, auxiliary_weight=0. if method == "spatial" else .25, flat=method == "flat_aux", epochs=epochs)

    def _append_initial(self, mapping: list, operation: str) -> None:
        if not any(c["mapping"] == mapping for c in self.initial):
            self.initial.append({"mapping": mapping, "operation": operation, "parentMapping": None, "prediction": None})

    @property
    def best(self) -> dict | None:
        return max(self.observations, key=lambda o: o["throughput"], default=None)

    @property
    def finished(self) -> bool:
        return self.stopped or (self.attempts >= self.budget and not self.pending)

    def ask(self) -> list[dict]:
        if self.finished or self.pending:
            return []
        start = time.perf_counter()
        training_before = self.training_seconds
        remaining = min(self.batch_size, self.budget - self.attempts)
        initialization = [c for c in self.initial if tuple(c["mapping"]) not in self.seen]
        if initialization:
            chosen = copy.deepcopy(initialization[:remaining])
        else:
            candidates = self._pool()
            if not candidates:
                self.stopped = True
                return []
            completed = self.history + self.observations
            if self.method in ("ea", "random") or len(completed) < 3:
                if self.method == "ea":
                    geometric = [c for c in candidates if c["operation"] == "geometric"]
                    chosen = (geometric + [c for c in candidates if c["operation"] != "geometric"])[:remaining]
                else:
                    chosen = candidates[:remaining]
            else:
                self.finalize_model()
                predictions = self.model.predict(self.scenario, [c["mapping"] for c in candidates])
                for candidate, prediction in zip(candidates, predictions):
                    candidate["prediction"] = prediction
                chosen = select_batch(self.scenario, candidates, remaining, complementary=self.method in ("spatial_aux", "spatial", "flat_aux"))
        self.round += 1
        for i, candidate in enumerate(chosen):
            candidate.update(id=f"c{self.attempts + i + 1:04d}", round=self.round, status="pending", source="new-evaluation")
            parent = candidate["parentMapping"]
            candidate["changedChutes"] = [j for j, d in enumerate(candidate["mapping"]) if parent is not None and d != parent[j]]
            self.seen.add(tuple(candidate["mapping"])); self.pending[candidate["id"]] = copy.deepcopy(candidate)
        self.selection_seconds += time.perf_counter() - start - (self.training_seconds - training_before)
        return copy.deepcopy(chosen)

    def _pool(self) -> list[dict]:
        parent = self.best["mapping"] if self.best else self.initial[0]["mapping"]
        candidates, keys = [], set(self.seen)
        operations = ("geometric", "swap", "transfer", "block")
        for i in range(max(100, self.pool_size * 30)):
            operation = operations[i % len(operations)]
            if self.method == "random" or i % 10 == 9:
                mapping = random_mapping(self.scenario, self.rng); operation = "restart"
            else:
                mapping = mutate_mapping(self.scenario, parent, self.rng, operation)
            self.proposals += 1
            key = tuple(mapping)
            if key in keys:
                self.duplicates += 1; continue
            keys.add(key)
            candidates.append({"mapping": mapping, "parentMapping": list(parent), "operation": operation, "prediction": None})
            if len(candidates) >= self.pool_size:
                break
        return candidates

    def tell(self, candidate: dict | str, result: dict) -> dict:
        candidate_id = candidate if isinstance(candidate, str) else candidate["id"]
        if candidate_id not in self.pending:
            raise ValueError("Candidate is not awaiting evaluation")
        proposal = self.pending.pop(candidate_id)
        self.attempts += 1
        record = {**proposal, "result": copy.deepcopy(result), "status": result.get("status", "completed"), "evaluation": self.attempts}
        successful = record["status"] in ("completed", "success") and np.isfinite(result.get("throughput", np.nan))
        if successful:
            observation = {**copy.deepcopy(result), "mapping": list(proposal["mapping"]), "scenario": self.scenario, "candidateId": candidate_id, "id": result.get("id", result.get("runId", candidate_id))}
            self.observations.append(observation)
        self.records.append(record)
        return record

    def finalize_model(self) -> dict | None:
        completed = self.history + self.observations
        if self.method in ("ea", "random") or len(completed) < 3:
            return None
        if self._fitted_count == len(completed):
            return self.fit_records[-1]
        fit = self.model.fit(self.scenario, completed)
        fit = {**fit, "round": self.round, "onlineObservations": len(self.observations), "historicalObservations": len(self.history)}
        self.fit_records.append(fit)
        self.training_seconds += fit["seconds"]
        self._fitted_count = len(completed)
        return fit

    def cancel(self) -> None:
        self.stopped = True

    def snapshot(self) -> dict:
        return {"method": self.method, "seed": self.seed, "budget": self.budget, "budgetUnit": "candidate-evaluations", "attempts": self.attempts, "completed": len(self.observations), "pending": len(self.pending), "proposals": self.proposals, "duplicateProposals": self.duplicates, "trainingSeconds": self.training_seconds, "selectionSeconds": max(0., self.selection_seconds), "historyCount": len(self.history), "fits": copy.deepcopy(self.fit_records), "best": copy.deepcopy(self.best), "records": copy.deepcopy(self.records), "finished": self.finished}


def run_search(scenario: dict, evaluate: Callable[[dict], dict], *, on_update: Callable[[dict], None] | None = None, cancelled: Callable[[], bool] | None = None, **options) -> dict:
    session = SearchSession(scenario, **options)
    while not session.finished:
        if cancelled and cancelled():
            session.cancel(); break
        candidates = session.ask()
        if not candidates:
            break
        for candidate in candidates:
            if cancelled and cancelled():
                session.cancel(); break
            result = evaluate(candidate)
            session.tell(candidate, result)
            if on_update:
                on_update(session.snapshot())
    if not (cancelled and cancelled()):
        session.finalize_model()
    return session.snapshot()
