from itertools import product
import numpy as np
import pytest

from warehouse_sorting.mapping import greedy_mapping, mutate_mapping, quotas, random_mapping, repair_mapping, validate_mapping


def scene(m=9, n=3):
    return {"id": "fixture", "map": {"width": 12, "height": 8, "chutes": [{"id": i, "x": i % 6 * 2, "y": 2 + i // 6 * 2} for i in range(m)], "workstations": [{"x": 0, "y": 0}]}, "destinations": [{"id": i, "weight": 1 / n, "minChutes": 1, "maxChutes": m} for i in range(n)], "fleetSize": 12, "horizon": 500}


def test_quota_repair_has_minimum_number_of_edits():
    scenario = scene(5, 3)
    for destination in scenario["destinations"]:
        destination["maxChutes"] = 3
    legal = [list(x) for x in product(range(3), repeat=5) if not validate_mapping(scenario, list(x))]
    for raw in ([0, 0, 0, 0, 0], [0, 0, 1, 1, 1], [-1, 0, 0, 0, 0], [1, 1, 1, 2, 2]):
        result = repair_mapping(scenario, raw, np.random.default_rng(12))
        actual = sum(a != b for a, b in zip(raw, result))
        minimum = min(sum(a != b for a, b in zip(raw, candidate)) for candidate in legal)
        assert not validate_mapping(scenario, result)
        assert actual == minimum


def test_reassignment_does_not_lock_destination_counts():
    scenario = scene()
    parent = [0, 0, 0, 1, 1, 1, 2, 2, 2]
    original = np.bincount(parent)
    rng = np.random.default_rng(42)
    for operator in ("swap", "transfer", "block", "geometric"):
        for _ in range(30):
            candidate = mutate_mapping(scenario, parent, rng, operator)
            assert not validate_mapping(scenario, candidate)
    assert any(not np.array_equal(np.bincount(mutate_mapping(scenario, parent, rng, "transfer"), minlength=3), original) for _ in range(20))


def test_greedy_and_random_respect_nonuniform_quotas():
    scenario = scene(9, 3)
    scenario["destinations"][0].update(weight=.7, maxChutes=6)
    scenario["destinations"][1].update(weight=.2, maxChutes=2)
    scenario["destinations"][2].update(weight=.1, maxChutes=2)
    for strategy in ("min_dist", "cluster"):
        assert not validate_mapping(scenario, greedy_mapping(scenario, strategy))
    for seed in range(20):
        assert not validate_mapping(scenario, random_mapping(scenario, np.random.default_rng(seed)))


def test_impossible_quotas_fail_before_evaluation():
    scenario = scene()
    for d in scenario["destinations"]:
        d["maxChutes"] = 2
    with pytest.raises(ValueError, match="infeasible"):
        quotas(scenario)
