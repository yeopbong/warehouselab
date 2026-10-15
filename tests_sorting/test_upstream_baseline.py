import json

import numpy as np
import pytest

from warehouse_sorting.config import scenarios, validate_mapping
from warehouse_sorting.engine import Engine
from warehouse_sorting.search import SearchSession
from warehouse_sorting.store import Store
from warehouse_sorting.upstream_baseline import (
    SingleElite, freeze_reference, original_greedy, run_reference, run_upstream_ea,
    source_identity, upstream_functions,
)
from warehouse_sorting.experiments import implementation_hash


def test_pinned_emitter_uses_shared_k_and_raw_parent():
    functions = upstream_functions()
    emitter_class = type("PinnedEmitter", (), {name: functions[name] for name in ("ask", "sample_k")})
    emitter = emitter_class()
    raw = np.array([0] * 7 + [1, 2])
    repaired = [0, 0, 1, 1, 1, 1, 2, 2, 2]
    archive = SingleElite()
    archive.add_batch([{"id": "first", "rawIndices": raw.tolist(), "mapping": repaired,
                        "throughput": 3., "status": "completed"}])
    emitter.archive = archive
    emitter.rng = np.random.default_rng(74)
    emitter.initial_population = emitter.sols_emitted = 4
    emitter.batch_size, emitter.solution_dim, emitter.num_objects = 3, 9, 3
    emitter.geometric_k, emitter.mutation_k = True, 10
    reference = np.random.default_rng(74)
    k = min(9, reference.geometric(.5))
    indices = reference.permuted(np.tile(np.arange(9), (3, 1)), axis=1)[:, :k]
    values = reference.integers(3, size=(3, k))
    expected = np.tile(raw, (3, 1))
    for i in range(3):
        expected[i, indices[i]] = values[i]
    actual, _ = emitter.ask()
    np.testing.assert_array_equal(actual, expected)
    assert emitter.sols_emitted == 7
    # Equal fitness leaves the existing raw genotype unchanged.
    archive.add_batch([{"id": "equal", "rawIndices": repaired, "mapping": repaired,
                        "throughput": 3., "status": "completed"}])
    assert archive.candidate_id == "first"
    archive.add_batch([{"id": name, "rawIndices": repaired, "mapping": repaired,
                        "throughput": 4., "status": "completed"} for name in ("batch-first", "batch-second")])
    assert archive.candidate_id == "batch-first"


class CountingRuntime:
    def __init__(self):
        self.calls = []

    def identity(self):
        return {"ready": True, "version": "fixture", "upstreamRevision": "fixture",
                "plannerRevision": "fixture", "patchRevision": "fixture", "buildHash": "fixture"}

    def evaluate(self, scenario, mapping, seed, **kwargs):
        self.calls.append((list(mapping), seed, kwargs))
        count = len(self.calls)
        # A flat objective keeps the first archive genotype and makes repeats possible.
        return {"id": f"evaluation-{count}", "status": "completed", "started": True,
                "simulationSeed": seed, "executedTicks": scenario["horizon"], "wallSeconds": .1,
                "metrics": {"throughput": 1.}, "auxiliary": {"zones": [
                    {"trafficWaitFraction": .1, "closedFraction": .2} for _ in range(12)]}}


def test_matched_initialization_raw_provenance_and_full_native_budget(tmp_path):
    scenario = scenarios()[3]
    runtime = CountingRuntime()
    study = run_upstream_ea(Engine(Store(tmp_path), runtime), scenario, optimizer_seed=7,
                            simulation_seeds=[11, 29], budget=24, batch_size=3)
    expected = SearchSession(scenario, method="ea", seed=7, budget=12).initial
    assert [candidate["mapping"] for candidate in study["candidates"][:4]] == [candidate["mapping"] for candidate in expected]
    assert study["costs"]["started"] == study["costs"]["completed"] == len(runtime.calls) == 24
    assert study["costs"]["replicates"] == 12 and study["costs"]["cacheHits"] == 0
    assert all(call[2]["force"] is True for call in runtime.calls)
    assert [c["calls"] for c in study["candidates"]] == list(range(2, 25, 2))
    assert [len([c for c in study["candidates"] if c["round"] == r]) for r in range(1, 5)] == [4, 3, 3, 2]
    assert study["baseline"] == source_identity()
    assert study["search"]["archiveCandidateId"] == "c0001"
    for candidate in study["candidates"]:
        validate_mapping(scenario, candidate["mapping"])
        assert candidate["repairChanges"] == [i for i, (a, b) in enumerate(zip(candidate["rawMapping"], candidate["mapping"])) if a != b]


@pytest.mark.parametrize("strategy", ["min_dist", "cluster"])
def test_original_greedy_function_produces_complete_legal_assignment(strategy):
    scenario = scenarios()[3]
    first = original_greedy(scenario, strategy)
    assert original_greedy(scenario, strategy) == first
    validate_mapping(scenario, first)
    assert len(first) == 105


def test_invalid_reference_options_start_no_evaluations(tmp_path):
    runtime = CountingRuntime()
    engine = Engine(Store(tmp_path), runtime)
    scenario = scenarios()[3]
    with pytest.raises(ValueError):
        run_upstream_ea(engine, scenario, optimizer_seed=7, simulation_seeds=[], budget=24)
    with pytest.raises(ValueError):
        run_upstream_ea(engine, scenario, optimizer_seed=7, simulation_seeds=[11, 29], budget=7)
    assert runtime.calls == []


def test_supplement_freezes_independent_costs_and_resumes_without_reexecution(tmp_path):
    runtime = CountingRuntime()
    engine = Engine(Store(tmp_path / "data"), runtime)
    primary = {"implementationHash": implementation_hash(), "simulator": runtime.identity(),
               "protocolHash": "primary-reference", "testScenarios": ["sparse-600-721"],
               "optimizerSeeds": [7], "selectionSeeds": [11, 29], "finalSeeds": [1009, 2029],
               "onlineBudget": 24, "batchSize": 3, "horizon": 100}
    output = tmp_path / "reference"
    protocol = freeze_reference(engine, primary, output)
    assert protocol["plannedCalls"]["total"] == 30
    assert freeze_reference(engine, primary, output) == protocol
    summary = run_reference(engine, protocol, output)
    assert summary["status"] == "completed" and summary["totalCost"]["started"] == 30
    assert len(summary["finalResults"]) == 1 and len(summary["greedyReferences"]) == 2
    assert summary["costsByPhase"]["optimization"]["started"] == 24
    assert summary["costsByPhase"]["final"]["started"] == 2
    assert summary["costsByPhase"]["greedy-final"]["started"] == 4
    assert set(summary["finalResults"][0]["bySimulationSeed"]) == {"1009", "2029"}
    assert len(runtime.calls) == 30
    run_reference(engine, protocol, output)
    assert len(runtime.calls) == 30
    manifest = json.loads((output / "manifest.json").read_text())
    assert len(manifest["entries"]) == 4
    with pytest.raises(ValueError, match="content does not match"):
        run_reference(engine, {**protocol, "onlineBudget": 30}, output)
