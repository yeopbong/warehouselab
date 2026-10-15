import copy
import numpy as np
import torch

from warehouse_sorting.features import auxiliary_targets, mapping_features
from warehouse_sorting.mapping import random_mapping
from warehouse_sorting.model import MappingSurrogate, SimpleSurrogate
from warehouse_sorting.search import SearchSession, select_batch
from test_mapping import scene


def observations(scenario, count=8):
    rng = np.random.default_rng(35)
    records = []
    for i in range(count):
        mapping = random_mapping(scenario, rng)
        nodes = mapping_features(scenario, mapping).nodes
        score = float(2 + nodes[:, 5].std() + nodes[0, 3])
        zones = [{"trafficWaitFraction": float((i + z) % 7 / 15), "closedFraction": float((i * 2 + z) % 11 / 15)} for z in range(12)]
        records.append({"id": f"training-{i}", "scenario": scenario, "mapping": mapping, "throughput": score, "auxiliary": {"zones": zones}})
    return records


def test_destination_renaming_preserves_representation_and_predictions():
    scenario = scene()
    mapping = [0, 1, 2, 0, 0, 1, 2, 2, 2]
    scenario["destinations"][0]["weight"] = .6
    renamed = copy.deepcopy(scenario)
    replacement = {0: "west", 1: "north", 2: "east"}
    renamed["destinations"] = list(reversed([{**d, "id": replacement[d["id"]]} for d in scenario["destinations"]]))
    changed = [replacement[d] for d in mapping]
    a, b = mapping_features(scenario, mapping), mapping_features(renamed, changed)
    for name in ("nodes", "same_destination", "spatial", "zones", "context", "flat"):
        np.testing.assert_allclose(getattr(a, name), getattr(b, name), atol=1e-6)
    model = MappingSurrogate(seed=3, epochs=3)
    model.fit(scenario, observations(scenario))
    pa, pb = model.predict(scenario, [mapping])[0], model.predict(renamed, [changed])[0]
    assert abs(pa["mean"] - pb["mean"]) < 1e-6
    assert abs(pa["std"] - pb["std"]) < 1e-6


def test_auxiliary_loss_changes_shared_weights_and_ranking_inputs():
    scenario = scene()
    records = observations(scenario)
    supervised = MappingSurrogate(seed=8, epochs=8, auxiliary_weight=.5)
    plain = MappingSurrogate(seed=8, epochs=8, auxiliary_weight=0.)
    supervised.fit(scenario, records); plain.fit(scenario, records)
    assert not torch.equal(supervised.models[0].input.weight, plain.models[0].input.weight)
    candidate = records[1]["mapping"]
    assert supervised.predict(scenario, [candidate])[0]["mean"] != plain.predict(scenario, [candidate])[0]["mean"]
    assert supervised.fit_diagnostics["auxiliaryLabels"] == len(records) * 12 * 2
    assert "auxiliary" not in plain.predict(scenario, [candidate])[0]


def test_missing_auxiliary_values_are_masked_and_variable_sizes_work(tmp_path):
    first, second = scene(), scene(6, 2)
    data = observations(first, 4) + observations(second, 4)
    data[0].pop("auxiliary")
    _, mask = auxiliary_targets(data[0]); assert mask.sum() == 0
    model = MappingSurrogate(seed=12, epochs=2)
    model.fit(first, data)
    prediction = model.predict(second, [data[-1]["mapping"]])[0]
    assert np.isfinite(prediction["mean"])
    path = tmp_path / "model.pt"; model.save(path)
    restored = MappingSurrogate.load(path)
    assert restored.predict(second, [data[-1]["mapping"]])[0] == prediction


def test_simple_surrogate_and_flat_model_fit():
    scenario = scene()
    data = observations(scenario)
    for model in (SimpleSurrogate(seed=4), MappingSurrogate(seed=4, flat=True, epochs=2)):
        model.fit(scenario, data)
        assert np.isfinite(model.predict(scenario, [data[0]["mapping"]])[0]["mean"])


def test_initial_evaluations_are_identical_and_failed_results_not_learned():
    scenario = scene()
    sessions = [SearchSession(scenario, method=method, seed=77, budget=6, batch_size=4, epochs=2, pool_size=20) for method in ("ea", "simple", "flat_aux", "spatial", "spatial_aux_top", "spatial_aux")]
    initial = [s.ask() for s in sessions]
    assert all([c["mapping"] for c in batch] == [c["mapping"] for c in initial[0]] for batch in initial)
    session = sessions[-1]
    for i, candidate in enumerate(initial[-1]):
        session.tell(candidate, {"id": f"r{i}", "status": "failed"} if i == 0 else {"id": f"r{i}", "throughput": float(i), "status": "completed"})
    assert session.attempts == 4 and len(session.observations) == 3
    next_batch = session.ask()
    assert all(c["prediction"]["trainingIds"] == ["r1", "r2", "r3"] for c in next_batch)
    frozen = copy.deepcopy(next_batch[0]["prediction"])
    session.tell(next_batch[0], {"id": "r4", "throughput": 999.})
    assert session.records[-1]["prediction"] == frozen


def test_diversity_does_not_select_obviously_low_quality_candidates():
    scenario = scene()
    rng = np.random.default_rng(5)
    proposals = [{"mapping": random_mapping(scenario, rng), "prediction": {"mean": 10. - i if i < 8 else -100., "std": 0.}} for i in range(20)]
    selected = select_batch(scenario, proposals, 2)
    assert len(selected) == 2
    assert all(p["prediction"]["mean"] > 0 for p in selected)


def test_complementary_batch_can_replace_a_near_duplicate():
    scenario = scene()
    first = [0, 0, 0, 1, 1, 1, 2, 2, 2]
    near = [1, 0, 0, 0, 1, 1, 2, 2, 2]
    far = [2, 2, 2, 1, 1, 1, 0, 0, 0]
    candidates = [{"mapping": mapping, "prediction": {"mean": mean, "std": 0.}} for mapping, mean in ((first, 10.), (near, 9.99), (far, 9.98))]
    candidates += [{"mapping": near, "prediction": {"mean": 9., "std": 0.}} for _ in range(10)]
    top = select_batch(scenario, copy.deepcopy(candidates), 2, complementary=False)
    diverse = select_batch(scenario, copy.deepcopy(candidates), 2, complementary=True)
    assert top[1]["mapping"] == near
    assert diverse[1]["mapping"] == far
