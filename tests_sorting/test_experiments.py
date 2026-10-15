import gzip
import hashlib
import json
from types import SimpleNamespace

import pytest

from warehouse_sorting.config import digest
from warehouse_sorting.experiments import (
    COST_KEYS, crossed_interval, export_results, freeze_protocol, hierarchical_interval, implementation_hash, include_reference,
    planned_calls, public_environment, run_protocol, selection_agreement, summarize, total_cost,
)
from warehouse_sorting.mapping import greedy_mapping
from warehouse_sorting.store import Store


def pilot():
    return {"status": "completed", "secondsPerSimulation": 1.2,
            "events": {"closedChuteTicks": 100}, "simulator": {"version": "fixture"},
            "implementationHash": implementation_hash(), "studyIds": ["pilot"], "horizon": 1500,
            "costs": {**dict.fromkeys(COST_KEYS, 0), "started": 9, "completed": 9},
            "modelTiming": {"model": {"trainingSeconds": .5, "predictionSeconds": .1}}}


def test_frozen_protocol_separates_costs_conditions_and_random_streams(tmp_path):
    protocol = freeze_protocol(pilot(), tmp_path)
    assert planned_calls(protocol)["total"] == 2126
    assert protocol["pilotCost"]["started"] == 9
    assert protocol["pilotCost"]["trainingSeconds"] == .5
    assert set(protocol["trainScenarios"]).isdisjoint(protocol["testScenarios"])
    assert protocol["validationScenario"] not in protocol["trainScenarios"] + protocol["testScenarios"]
    assert set(protocol["selectionSeeds"]).isdisjoint(protocol["finalSeeds"])
    assert set(protocol["historySeeds"]).isdisjoint(protocol["finalSeeds"])
    assert freeze_protocol(pilot(), tmp_path)["protocolHash"] == protocol["protocolHash"]
    with pytest.raises(ValueError, match="different protocol"):
        freeze_protocol(pilot(), tmp_path, cross_map=True)
    assert freeze_protocol(pilot(), tmp_path / "cross", cross_map=True)["plannedCalls"]["total"] == 2484
    with pytest.raises(ValueError, match="closures"):
        freeze_protocol({**pilot(), "events": {"closedChuteTicks": 0}}, tmp_path / "invalid")


def test_hierarchical_intervals_preserve_optimizer_unit_and_reject_invalid_values():
    result = hierarchical_interval([[1., 1., 1.], [3.], [5., 5.]], samples=2000)
    assert result["mean"] == 3
    assert result["optimizerRuns"] == 3 and result["simulationRuns"] == 6
    assert result["interval95"][0] <= 3 <= result["interval95"][1]
    assert hierarchical_interval([[2.]])["interval95"] is None
    assert hierarchical_interval([[0., 0.], [0., 0.]])["interval95"] == [0., 0.]
    with pytest.raises(ValueError, match="finite"):
        hierarchical_interval([[float("nan")]])
    assert total_cost([{"id": "one", "costs": {"started": 2}}] * 3)["started"] == 2


def test_crossed_bootstrap_keeps_shared_simulator_blocks_together():
    result = crossed_interval([[0., 100.]] * 3, samples=2000)
    assert result["mean"] == 50
    assert result["interval95"] == [0., 100.]
    assert result["optimizerRuns"] == 3 and result["simulationRuns"] == 6
    assert crossed_interval([[1., 1.]] * 3)["interval95"] == [1., 1.]
    assert crossed_interval([[0., 100.]])["interval95"] is None
    with pytest.raises(ValueError, match="same ordered"):
        crossed_interval([[1., 2.], [3.]])
    with pytest.raises(ValueError, match="finite"):
        crossed_interval([[1., float("inf")], [2., 3.]])


def test_selection_agreement_distinguishes_reordering_from_changed_choices():
    def study(identifier, mappings):
        return {"id": identifier, "candidates": [{"mapping": [mapping], "round": 1 if i < 2 else 2 if i < 4 else 3,
                                                  "status": "completed", "throughput": i}
                                                  for i, mapping in enumerate(mappings)]}
    studies = {"full": study("full", ["a", "b", "c", "d", "e"]),
               "noaux": study("noaux", ["a", "b", "d", "c", "f"]),
               "top": study("top", ["a", "b", "c", "x", "e"])}
    entries = [{"phase": "optimization", "scenarioId": "scenario", "regime": "cold", "optimizerSeed": 7,
                "method": method, "studyId": identifier} for method, identifier in
               (("spatial_aux", "full"), ("spatial", "noaux"), ("spatial_aux_top", "top"))]
    rows = selection_agreement(entries, studies, 2)
    auxiliary, batch = rows
    assert auxiliary["initializationIdentical"]
    assert auxiliary["sameMappingPositions"] == 0 and auxiliary["matchedPositions"] == 3
    assert auxiliary["sharedGuidedMappings"] == 2
    assert not auxiliary["guidedSetIdentical"] and not auxiliary["selectedWinnerIdentical"]
    assert not auxiliary["firstGuidedBatchDifferent"] and auxiliary["firstGuidedBatchOrderDifferent"]
    assert batch["firstGuidedBatchDifferent"]
    assert batch["sameMappingFraction"] == pytest.approx(2 / 3)
    assert not batch["guidedSetIdentical"] and batch["selectedWinnerIdentical"]


def test_original_reference_is_separate_and_costs_are_additive():
    protocol = {"protocolHash": "primary", "implementationHash": "core", "simulator": {"version": "test"},
                "testScenarios": ["scenario"], "optimizerSeeds": [7, 19, 43], "selectionSeeds": [11, 29],
                "finalSeeds": [101, 211], "onlineBudget": 24, "horizon": 1500, "bootstrapSeed": 817, "bootstrapSamples": 100}
    reference_protocol = {**protocol, "protocolHash": "reference"}
    rows = [{"scenarioId": "scenario", "regime": "cold", "method": "spatial_aux", "optimizerSeed": seed,
             "status": "completed", "bySimulationSeed": {"101": 4., "211": 6.}} for seed in protocol["optimizerSeeds"]]
    main_cost = {**dict.fromkeys(COST_KEYS, 0), "started": 100}
    extra_cost = {**dict.fromkeys(COST_KEYS, 0), "started": 20}
    primary = {"finalResults": rows, "groups": [{"mean": 5.}], "totalCost": main_cost, "totalResearchCost": main_cost}
    reference = {"status": "completed", "primaryProtocolHash": "primary", "protocolHash": "reference",
                 "finalResults": [{**r, "method": "upstream_ea", "bySimulationSeed": {"101": 3., "211": 5.}} for r in rows],
                 "totalCost": extra_cost}
    result = include_reference(primary, protocol, reference, reference_protocol)
    assert result["groups"] == primary["groups"] and result["totalCost"] == primary["totalCost"]
    assert "originalEAReference" not in primary
    assert result["supplementalCost"]["started"] == 20 and result["overallStudyCost"]["started"] == 120
    contrast = result["originalEAReference"]["pairedContrasts"][0]
    assert contrast["mean"] == 1 and contrast["interval95"] == [1., 1.]
    with pytest.raises(ValueError, match="comparison conditions"):
        include_reference(primary, protocol, reference, {**reference_protocol, "finalSeeds": [100, 200]})


def test_environment_threads_distinguish_capture_from_model_training():
    original = {"torchThreadsPerWorker": 4, "workerCount": 2}
    result = public_environment(original)
    assert original == {"torchThreadsPerWorker": 4, "workerCount": 2}
    assert "torchThreadsPerWorker" not in result
    assert result["torchThreadsAtEnvironmentCapture"] == 4
    assert result["modelFitThreadsPerWorker"] == 1
    assert public_environment(result) == result
    with pytest.raises(ValueError, match="Conflicting thread counts"):
        public_environment({**original, "torchThreadsAtEnvironmentCapture": 8})


class FixtureEngine:
    def __init__(self, path):
        self.store = Store(path)
        self.runtime = SimpleNamespace(identity=lambda: {"version": "fixture"})
        self.calls = []

    def run_search(self, scenario, *, method, budget, simulation_seeds, study_id, **kwargs):
        self.calls.append(("search", method, kwargs.get("history_studies", []), list(simulation_seeds)))
        return self._study(scenario, study_id, budget, simulation_seeds, greedy_mapping(scenario), 100.)

    def run_manual(self, scenario, *, mapping, simulation_seeds, study_id, **kwargs):
        self.calls.append(("manual", kwargs["purpose"], list(mapping), list(simulation_seeds)))
        return self._study(scenario, study_id, len(simulation_seeds), simulation_seeds, mapping, 2.)

    def _study(self, scenario, identifier, budget, seeds, mapping, throughput):
        candidates = []
        for i in range(budget // len(seeds)):
            evaluations = [{"status": "completed", "simulationSeed": seed,
                            "metrics": {"throughput": throughput + i}} for seed in seeds]
            candidates.append({"id": f"candidate-{i}", "status": "completed", "throughput": throughput + i,
                               "calls": (i + 1) * len(seeds), "mapping": mapping, "evaluations": evaluations})
        study = {"id": identifier, "scenario": scenario, "status": "completed", "simulator": self.runtime.identity(),
                 "implementationHash": implementation_hash(), "candidates": candidates, "budget": budget,
                 "costs": {**dict.fromkeys(COST_KEYS, 0), "started": budget, "completed": budget}}
        self.store.write("studies", identifier, study)
        return study


def test_runner_charges_shared_history_once_and_reports_independent_holdout(tmp_path):
    output = tmp_path / "experiment"
    protocol = freeze_protocol(pilot(), output)
    protocol.update({"trainScenarios": protocol["trainScenarios"][:1], "testScenarios": protocol["testScenarios"][:1],
                     "methods": ["ea", "simple"], "learningMethods": ["simple"], "optimizerSeeds": [7, 19],
                     "onlineBudget": 8, "historyBudgetPerScenario": 8, "finalSeeds": [1009, 2029], "bootstrapSamples": 100})
    protocol["protocolHash"] = digest({k: v for k, v in protocol.items() if k != "protocolHash"})
    engine = FixtureEngine(tmp_path / "data")
    manifest = run_protocol(engine, protocol, output)
    result = summarize(engine, protocol, manifest)
    assert manifest["status"] == "completed"
    assert result["totalCost"]["started"] == planned_calls(protocol)["total"] == 72
    assert result["totalResearchCost"]["started"] == 81
    assert result["costsByPhase"]["history-data"]["started"] == 8
    assert len(result["greedyReferences"]) == 2
    assert len(result["finalResults"]) == 6
    assert all(group["mean"] == 2 for group in result["groups"])
    assert all(curve["curve"]["points"][-1]["bestMeasuredThroughput"] == 103 for curve in result["optimization"])
    final_id = next(entry["studyId"] for entry in manifest["entries"] if entry["phase"] == "final")
    in_progress = engine.store.read("studies", final_id)
    in_progress["status"] = "running"
    engine.store.write("studies", final_id, in_progress)
    partial_result = summarize(engine, protocol, manifest)
    assert sum(group["inProgressOptimizerRuns"] for group in partial_result["groups"]) == 1
    assert sum(group["failedOptimizerRuns"] for group in partial_result["groups"]) == 0
    in_progress["status"] = "completed"
    engine.store.write("studies", final_id, in_progress)
    history_calls = [call for call in engine.calls if call[0] == "search" and call[2]]
    assert len(history_calls) == 2
    assert all(len(call[2]) == 1 for call in history_calls)
    previous = len(engine.calls)
    run_protocol(engine, protocol, output)
    assert len(engine.calls) == previous
    identifier = manifest["entries"][0]["studyId"]
    partial = engine.store.read("studies", identifier)
    partial["status"] = "failed"
    engine.store.write("studies", identifier, partial)
    with pytest.raises(RuntimeError, match="incomplete"):
        run_protocol(engine, protocol, output)
    assert engine.store.read("studies", identifier)["status"] == "failed"
    interrupted = {**manifest, "entries": [], "status": "running"}
    recovered = summarize(engine, protocol, interrupted)
    assert recovered["totalCost"]["started"] == 72
    assert recovered["costsByPhase"]["history-data"]["completed"] == 8
    with pytest.raises(ValueError, match="content does not match"):
        run_protocol(engine, {**protocol, "onlineBudget": 12}, output)


def test_export_preserves_measurements_and_checks_checkpoint_integrity(tmp_path):
    output = tmp_path / "experiment"
    protocol = freeze_protocol(pilot(), output)
    protocol.update({"trainScenarios": protocol["trainScenarios"][:1], "testScenarios": protocol["testScenarios"][:1],
                     "methods": ["spatial_aux"], "learningMethods": ["spatial_aux"], "optimizerSeeds": [7],
                     "onlineBudget": 8, "historyBudgetPerScenario": 8, "finalSeeds": [1009, 2029], "bootstrapSamples": 100})
    protocol["protocolHash"] = digest({k: v for k, v in protocol.items() if k != "protocolHash"})
    (output / "protocol.json").write_text(json.dumps(protocol))
    engine = FixtureEngine(tmp_path / "data")
    manifest = run_protocol(engine, protocol, output)
    for entry in manifest["entries"]:
        if entry["phase"] != "optimization":
            continue
        study = engine.store.read("studies", entry["studyId"])
        model_bytes = b"checkpoint-format-test-fixture"
        filename = study["id"] + ".pt"
        (engine.store.root / "models" / filename).write_bytes(model_bytes)
        study.update(modelFile=filename, modelHash=hashlib.sha256(model_bytes).hexdigest(),
                     search={"fits": [{"trainingIds": [study["id"] + "/candidate-0"]}]}, processId=42)
        study["candidates"][0]["evaluations"][0]["processId"] = 43
        engine.store.write("studies", study["id"], study)
    pilot_study = engine.store.read("studies", manifest["entries"][0]["studyId"])
    pilot_study["id"] = "pilot"
    engine.store.write("studies", "pilot", pilot_study)
    destination = tmp_path / "results"
    environment_path = output / "environment.json"
    environment = json.loads(environment_path.read_text())
    environment.pop("torchThreadsAtEnvironmentCapture")
    environment["torchThreadsPerWorker"] = 4
    environment_path.write_text(json.dumps(environment))
    result = export_results(engine, output, destination)
    assert result["checkpoints"] == 2
    assert (destination / "summary.json").read_bytes() == (output / "summary.json").read_bytes()
    exported_environment = json.loads((destination / "environment.json").read_text())
    assert exported_environment["torchThreadsAtEnvironmentCapture"] == 4
    assert exported_environment["modelFitThreadsPerWorker"] == 1
    assert "torchThreadsPerWorker" not in exported_environment
    assert json.loads(environment_path.read_text()) == environment
    with gzip.open(destination / "observations.jsonl.gz", "rt") as source:
        records = [json.loads(line) for line in source]
    assert len(records) == len(manifest["entries"]) + 1
    assert "processId" not in json.dumps(records)
    assert any(record["candidates"][0]["evaluations"][0]["metrics"]["throughput"] == 100 for record in records)
    checkpoint = next((engine.store.root / "models").glob("*.pt"))
    checkpoint.write_bytes(b"changed")
    with pytest.raises(ValueError, match="Checkpoint contents"):
        export_results(engine, output, destination)
    manifest["status"] = "running"
    (output / "manifest.json").write_text(json.dumps(manifest))
    with pytest.raises(ValueError, match="Finish"):
        export_results(engine, output, destination)
