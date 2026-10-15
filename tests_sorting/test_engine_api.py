import copy
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from warehouse_sorting.api import create_app, recover_interrupted
from warehouse_sorting.cli import export_studies
from warehouse_sorting.config import scenarios
from warehouse_sorting.engine import Engine, aggregate
from warehouse_sorting.mapping import greedy_mapping
from warehouse_sorting.store import Store


@pytest.fixture
def scenario():
    value = scenarios()[2]
    value["horizon"] = 100
    return value


def test_real_search_uses_call_budget_and_freezes_predictions(tmp_path, scenario):
    store = Store(tmp_path)
    engine = Engine(store)
    study = engine.run_search(scenario, "spatial_aux", budget=12, simulation_seeds=[37, 43],
                              epochs=3, pool_size=16, record_trace=False)
    assert study["status"] == "completed"
    assert study["costs"]["started"] == study["costs"]["completed"] == 12
    assert study["costs"]["replicates"] == 6
    assert study["costs"]["executedTicks"] == 1200
    assert [c["calls"] for c in study["candidates"]] == [2, 4, 6, 8, 10, 12]
    assert study["costs"]["trainingSeconds"] > 0
    assert (tmp_path / "models" / study["modelFile"]).is_file()
    for candidate in study["candidates"]:
        if candidate["prediction"]:
            assert all(identifier != f"{study['id']}/{candidate['id']}"
                       for identifier in candidate["prediction"]["trainingIds"])
        assert all(e["traceUrl"] is None for e in candidate["evaluations"])
    history = engine.run_search(scenario, "simple", budget=8, simulation_seeds=[47, 59],
                                history_studies=[study], record_trace=False)
    assert history["costs"]["historyCalls"] == 12
    assert history["costs"]["started"] == 8
    assert history["historyIds"] == [study["id"]]
    original = store.read("studies", study["id"])
    export_studies(store, [study["id"]], tmp_path / "published", study["id"])
    published = json.loads((tmp_path / "published/studies" / f"{study['id']}.json").read_text())
    assert published["costs"] == original["costs"]
    assert published["candidates"][0]["mapping"] == original["candidates"][0]["mapping"]
    assert published["candidates"][-1]["prediction"] == original["candidates"][-1]["prediction"]
    assert "processId" not in published
    assert all("processId" not in e for c in published["candidates"] for e in c["evaluations"])
    assert store.read("studies", study["id"]) == original


def test_cancel_after_real_run_keeps_cost_and_does_not_train_partial_candidate(tmp_path, scenario):
    engine = Engine(Store(tmp_path))
    cancellation = {"value": False}

    def update(study):
        if study["costs"]["started"]:
            cancellation["value"] = True

    study = engine.run_search(scenario, budget=12, simulation_seeds=[13, 19],
                              cancelled=lambda: cancellation["value"], on_update=update)
    assert study["status"] == "cancelled"
    assert study["costs"]["started"] == 1
    assert study["costs"]["completed"] == 1
    assert study["candidates"][0]["throughput"] is None
    assert study["search"]["completed"] == 0
    assert study["costs"]["trainingSeconds"] == 0


def test_partial_failure_cannot_be_reported_as_a_successful_mean():
    assert aggregate([{"status": "failed"}, {"status": "completed"}])["throughput"] is None


def test_api_runs_original_simulator_and_checks_constraints(tmp_path, scenario):
    store = Store(tmp_path)
    mapping = greedy_mapping(scenario)
    app = create_app(store, scenario_list=[scenario], static_dir=tmp_path / "missing")
    with TestClient(app, base_url="http://localhost") as client:
        assert client.get("/api/sorting/status").json()["simulator"]["ready"]
        request = {"scenarioId": scenario["id"], "mapping": mapping, "horizon": 100,
                   "simulationSeeds": [89]}
        assert client.post("/api/sorting/evaluate", json={**request, "mapping": mapping[:-1]}).status_code == 422
        assert client.post("/api/sorting/evaluate", json=request, headers={"origin": "https://unrelated.example"}).status_code == 403
        receipt = client.post("/api/sorting/evaluate", json=request)
        assert receipt.status_code == 200
        job_id = receipt.json()["jobId"]
        for _ in range(300):
            job = client.get(f"/api/sorting/jobs/{job_id}").json()
            if job["status"] in ("completed", "failed"):
                break
            time.sleep(.02)
        assert job["status"] == "completed", job
        study = client.get(f"/api/sorting/studies/{job['studyId']}").json()
        evaluation = study["candidates"][0]["evaluations"][0]
        trace = client.get(evaluation["traceUrl"]).json()
        assert len(trace["positions"]) == 101
        assert trace["metrics"]["sortedParcels"] == evaluation["metrics"]["sortedParcels"]
        assert study["costs"]["started"] == 1
        assert client.get("/api/sorting/studies/missing").status_code == 404


def test_invalid_budget_and_repeated_seed_start_no_simulations(tmp_path, scenario):
    engine = Engine(Store(tmp_path))
    with pytest.raises(ValueError, match="multiple"):
        engine.run_search(scenario, budget=5, simulation_seeds=[1, 2])
    with pytest.raises(ValueError, match="distinct"):
        engine.run_search(scenario, budget=6, simulation_seeds=[1, 1])
    assert list((tmp_path / "evaluations").glob("*.json")) == []


@pytest.mark.parametrize("options", [
    {"simulation_seeds": []}, {"simulation_seeds": [True]},
    {"optimizer_seed": True}, {"batch_size": 0}, {"method": "unknown"},
])
def test_invalid_search_options_leave_no_running_study(tmp_path, scenario, options):
    store = Store(tmp_path)
    with pytest.raises(ValueError):
        Engine(store).run_search(scenario, **options)
    assert store.studies() == []


def test_cancel_after_last_run_keeps_completed_measurement_but_cancels_search(tmp_path, scenario):
    cancellation = {"value": False}

    def update(study):
        cancellation["value"] = study["costs"]["started"] > 0

    study = Engine(Store(tmp_path)).run_search(
        scenario, "simple", budget=1, simulation_seeds=[47], on_update=update,
        cancelled=lambda: cancellation["value"])
    assert study["status"] == "cancelled"
    assert study["costs"]["started"] == 1
    assert study["candidates"][0]["status"] == "completed"
    assert study["search"]["completed"] == 1


def test_history_rejects_duplicate_incompatible_or_partial_measurements(tmp_path, scenario):
    engine = Engine(Store(tmp_path))
    source = engine.run_manual(scenario, greedy_mapping(scenario), simulation_seeds=[37], record_trace=False)
    with pytest.raises(ValueError, match="repeated"):
        engine.run_search(scenario, budget=1, simulation_seeds=[41], history_studies=[source, source])
    changed = copy.deepcopy(source)
    changed["simulator"]["version"] = "different"
    with pytest.raises(ValueError, match="simulator"):
        engine.run_search(scenario, budget=1, simulation_seeds=[41], history_studies=[changed])
    partial = copy.deepcopy(source)
    partial["simulationSeeds"].append(43)
    assert engine.observations([partial]) == []
    failed = copy.deepcopy(source)
    failed["candidates"][0]["evaluations"][0]["status"] = "failed"
    assert engine.observations([failed]) == []


def test_nested_history_costs_count_each_source_once(tmp_path, scenario):
    engine = Engine(Store(tmp_path))
    source = engine.run_manual(scenario, greedy_mapping(scenario), simulation_seeds=[37], record_trace=False)
    middle = engine.run_search(scenario, "ea", budget=1, simulation_seeds=[41], history_studies=[source])
    final = engine.run_search(scenario, "ea", budget=1, simulation_seeds=[43], history_studies=[source, middle])
    assert final["costs"]["historyCalls"] == 2
    assert {entry["studyId"] for entry in final["historyLedger"]} == {source["id"], middle["id"]}


def wait_for_job(client, receipt):
    assert receipt.status_code == 200, receipt.text
    for _ in range(300):
        job = client.get(f"/api/sorting/jobs/{receipt.json()['jobId']}").json()
        if job["status"] not in ("queued", "running", "cancelling"):
            assert job["status"] == "completed", job
            return client.get(f"/api/sorting/studies/{job['studyId']}").json()
        time.sleep(.02)
    pytest.fail("Real evaluation did not finish")


def test_fixed_mapping_can_be_repeated_under_target_condition(tmp_path, scenario):
    store = Store(tmp_path)
    engine = Engine(store)
    mapping = greedy_mapping(scenario)
    source = engine.run_manual(scenario, mapping, simulation_seeds=[37], record_trace=False)
    target = copy.deepcopy(scenario)
    target["id"] = "changed-demand"
    popular = max(target["destinations"], key=lambda d: mapping.count(d["id"]))
    assert mapping.count(popular["id"]) > 1
    popular["maxChutes"] = mapping.count(popular["id"]) - 1
    target["destinations"][-1]["maxChutes"] += 1
    original_quota = popular["maxChutes"]
    app = create_app(store, engine, [scenario, target], tmp_path / "missing")
    with TestClient(app, base_url="http://localhost") as client:
        request = {"scenarioId": target["id"], "mapping": mapping, "horizon": 100,
                   "simulationSeeds": [89], "sourceStudyId": source["id"], "sourceCandidateId": "c0001"}
        first = wait_for_job(client, client.post("/api/sorting/evaluate", json=request))
        assert first["scenario"]["constraintMode"] == "fixed-mapping"
        repeated = wait_for_job(client, client.post("/api/sorting/evaluate", json={
            **request, "sourceStudyId": first["id"]}))
        assert repeated["status"] == "completed"
        assert repeated["scenario"]["originalSearchQuotas"][popular["id"]] == original_quota
        assert client.post("/api/sorting/evaluate", json={key: value for key, value in request.items()
                                                       if not key.startswith("source")}).status_code == 422
        assert popular["maxChutes"] == original_quota


@pytest.mark.parametrize("change", [
    {"horizon": True}, {"horizon": 1.5}, {"horizon": 10001},
    {"simulationSeeds": [True]}, {"simulationSeeds": [1.2]}, {"simulationSeeds": [-1]},
    {"simulationSeeds": [1, 1]}, {"simulationSeeds": []},
    {"sourceCandidateId": "c0001"}, {"sourceStudyId": "../outside"},
])
def test_api_invalid_inputs_start_no_work(tmp_path, scenario, change):
    store = Store(tmp_path)
    app = create_app(store, scenario_list=[scenario], static_dir=tmp_path / "missing")
    with TestClient(app, base_url="http://localhost") as client:
        response = client.post("/api/sorting/evaluate", json={
            "scenarioId": scenario["id"], "mapping": greedy_mapping(scenario), **change})
        assert response.status_code == 422
        assert client.get("/api/sorting/status", headers={"host": "unrelated.example"}).status_code == 400
    assert store.studies() == []
    assert list((tmp_path / "evaluations").glob("*.json")) == []


def test_restart_marks_lost_runs_interrupted_and_reconciles_saved_measurements(tmp_path, scenario):
    store = Store(tmp_path)
    study = Engine(store).run_manual(scenario, greedy_mapping(scenario), simulation_seeds=[37], record_trace=False)
    completed = study["candidates"][0]["evaluations"][0]
    lost = {**completed, "id": "eval-lost", "status": "running", "executedTicks": None,
            "metrics": None, "wallSeconds": 0, "processId": -1}
    store.write("evaluations", lost["id"], lost)
    study.update(status="running", processId=-1)
    study["candidates"][0].update(status="running", evaluations=[], activeSeed=41)
    store.write("studies", study["id"], study)
    recover_interrupted(store)
    restored = store.read("studies", study["id"])
    assert restored["status"] == "interrupted"
    assert restored["costs"]["completed"] == 1
    assert restored["costs"]["interrupted"] == 1
    assert restored["costs"]["started"] == 2
    assert restored["costs"]["unknownExecutedTickRuns"] == 1
    assert restored["costs"]["executedTicks"] == 100
    assert restored["candidates"][0]["throughput"] is None
    assert "activeSeed" not in restored["candidates"][0]
    assert store.read("evaluations", "eval-lost")["status"] == "interrupted"
    assert Engine.observations([restored]) == []

    restored.update(status="running", processId=os.getpid())
    store.write("studies", study["id"], restored)
    recover_interrupted(store)
    assert store.read("studies", study["id"])["status"] == "running"


def test_concurrent_store_reads_and_writes_are_atomic_across_instances(tmp_path):
    stores = [Store(tmp_path), Store(tmp_path)]
    stores[0].write("evaluations", "record", {"value": 0, "copies": [0] * 100})

    def write(index):
        for value in range(50):
            stores[index].write("evaluations", "record", {"value": value, "copies": [value] * 100})

    def read():
        for _ in range(100):
            record = stores[0].read("evaluations", "record")
            assert record["copies"] == [record["value"]] * 100

    with ThreadPoolExecutor(max_workers=3) as pool:
        tasks = [pool.submit(write, 0), pool.submit(write, 1), pool.submit(read)]
        for task in tasks:
            task.result()
    with pytest.raises(ValueError):
        stores[0].write("evaluations", "record", {"value": float("nan")})
    assert list(tmp_path.rglob("*.tmp")) == []
