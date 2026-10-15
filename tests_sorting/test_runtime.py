import json
from pathlib import Path
import subprocess

import pytest

from warehouse_sorting.config import make_scenario
from warehouse_sorting.mapping import greedy_mapping
from warehouse_sorting.runtime import Runtime
from warehouse_sorting.store import Store


@pytest.fixture(scope="module")
def native_case(tmp_path_factory):
    store = Store(tmp_path_factory.mktemp("native-wrapper"))
    runtime = Runtime(store)
    if not runtime.identity()["ready"]:
        pytest.skip("Build the native runtime with scripts/setup-tmo.py")
    scenario = make_scenario("wrapper-fixture", "Wrapper integration", "sortation_33_57_105-chutes",
                             41, 300, .7, horizon=240)
    # Recirculation need not appear last in the external scenario representation.
    scenario["destinations"] = scenario["destinations"][-1:] + scenario["destinations"][:-1]
    mapping = greedy_mapping(scenario, "min_dist")
    result = runtime.evaluate(scenario, mapping, 31, study_id="wrapper", candidate_id="baseline")
    assert result["status"] == "completed", result.get("error")
    return runtime, scenario, mapping, result


def test_native_bridge_preserves_destination_labels_and_supervision(native_case):
    runtime, scenario, mapping, result = native_case
    request_path = runtime.store.root / "native" / result["id"] / "input.json"
    request = json.loads(request_path.read_text())
    trace = runtime.store.read_trace(result["id"])
    assert trace["destinationIds"][-1] == "REC"
    assert [trace["destinationIds"][d] for d in request["mapping"]] == mapping
    assert request["agents"] == scenario["fleetSize"]
    assert len(trace["positions"]) == result["executedTicks"] + 1 == 241
    assert all(len(frame) == 300 for frame in trace["positions"])
    assert trace["source"] == "measured" and trace["metrics"] == result["metrics"]
    assert result["metrics"]["sortedParcels"] > 0
    assert result["metrics"]["throughput"] == result["metrics"]["sortedParcels"] / 240
    assert result["metrics"]["upstreamTaskThroughput"] > result["metrics"]["throughput"]
    assert len(result["auxiliary"]["zones"]) == 12
    assert [z["zone"] for z in result["auxiliary"]["zones"]] == list(range(12))
    assert sum(z["trafficWaitTicks"] for z in result["auxiliary"]["zones"]) == result["metrics"]["trafficWaitTicks"]
    assert runtime.store.read("evaluations", result["id"]) == result
    assert not (request_path.parent / "output.json").exists()


def test_cache_hit_has_own_request_record_without_another_simulation(native_case):
    runtime, scenario, mapping, measured = native_case
    result = runtime.evaluate(scenario, mapping, 31, study_id="wrapper", candidate_id="edited", purpose="manual")
    assert result["id"] != measured["id"]
    assert result["candidateId"] == "edited" and result["purpose"] == "manual"
    assert result["cacheOf"] == measured["id"] and result["started"] is False
    assert result["wallSeconds"] == result["executedTicks"] == 0
    assert result["measuredTicks"] == measured["executedTicks"]
    assert result["metrics"] == measured["metrics"]
    assert runtime.store.read("evaluations", result["id"]) == result
    trace = runtime.store.read_trace(result["id"])
    assert trace["source"] == "cached-measurement"
    assert trace["measurementEvaluationId"] == measured["id"]
    assert trace["positions"] == runtime.store.read_trace(measured["id"])["positions"]
    assert not (runtime.store.root / "native" / result["id"]).exists()


def test_forced_repetition_and_separate_study_are_charged(native_case):
    runtime, scenario, mapping, measured = native_case
    for study, force in (("wrapper", True), ("other-method", False)):
        result = runtime.evaluate(scenario, mapping, 31, study_id=study,
                                  candidate_id="repeat", force=force)
        assert result["started"] and result["cacheOf"] is None
        assert result["wallSeconds"] > 0 and result["executedTicks"] == 240
        assert result["metrics"] == measured["metrics"]
        assert result["id"] != measured["id"]


def test_event_only_record_is_not_exposed_as_full_motion_replay(native_case):
    runtime, scenario, mapping, _ = native_case
    result = runtime.evaluate(scenario, mapping, 31, study_id="events-only",
                              candidate_id="without-positions", record_trace=False)
    assert result["status"] == "completed" and result["traceUrl"] is None
    assert result["eventTraceAvailable"] is True
    trace = runtime.store.read_trace(result["id"])
    assert trace["positions"] == [] and trace["events"]
    assert len(trace["curve"]) == 241


def test_invalid_mapping_and_seed_are_rejected_without_started_record(native_case):
    runtime, scenario, mapping, _ = native_case
    records = set((runtime.store.root / "evaluations").glob("*.json"))
    with pytest.raises(ValueError):
        runtime.evaluate(scenario, ["unknown"] * len(mapping), 31, study_id="bad", candidate_id="bad")
    with pytest.raises(ValueError, match="32-bit"):
        runtime.evaluate(scenario, mapping, True, study_id="bad", candidate_id="bad")
    assert set((runtime.store.root / "evaluations").glob("*.json")) == records


@pytest.mark.parametrize("failure", ["exit", "timeout"])
def test_failed_native_attempts_are_saved_without_invented_ticks(native_case, monkeypatch, failure):
    runtime, scenario, mapping, _ = native_case
    def fail(command, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, kwargs["timeout"])
        return subprocess.CompletedProcess(command, 17)
    monkeypatch.setattr("warehouse_sorting.runtime.subprocess.run", fail)
    result = runtime.evaluate(scenario, mapping, 31, study_id=f"failure-{failure}", candidate_id="failed")
    assert result["status"] == "failed" and result["started"] is True
    assert result["executedTicks"] is None and result["metrics"] is None
    assert result["wallSeconds"] > 0 and result["traceUrl"] is None
    assert runtime.store.read("evaluations", result["id"])["error"]


@pytest.mark.parametrize("damage", ["throughput", "trace", "version"])
def test_corrupt_native_output_is_not_accepted_as_a_measurement(native_case, monkeypatch, damage):
    runtime, scenario, mapping, _ = native_case
    original = subprocess.run
    def corrupt(command, **kwargs):
        result = original(command, **kwargs)
        output = Path(command[-1])
        raw = json.loads(output.read_text())
        if damage == "throughput":
            raw["metrics"]["throughput"] += 1
        elif damage == "trace":
            raw["trace"]["positions"].pop()
        else:
            raw["runtime_version"] = "incompatible-runtime"
        output.write_text(json.dumps(raw))
        return result
    monkeypatch.setattr("warehouse_sorting.runtime.subprocess.run", corrupt)
    result = runtime.evaluate(scenario, mapping, 31, study_id=f"corrupt-{damage}", candidate_id="failed")
    assert result["status"] == "failed" and result["metrics"] is None
    assert result["traceUrl"] is None and result["error"]


def test_runtime_identity_refreshes_after_build_or_binary_change(tmp_path):
    path = tmp_path / "runtime"
    runtime = Runtime(Store(tmp_path / "data"), binary=path)
    assert runtime.identity()["ready"] is False
    path.write_bytes(b"first build")
    first = runtime.identity()
    assert first["ready"] is True
    path.write_bytes(b"second build")
    assert runtime.identity()["buildHash"] != first["buildHash"]
