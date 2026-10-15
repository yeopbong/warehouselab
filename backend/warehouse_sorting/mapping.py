"""Feasible task mappings and exact minimum-change quota repair."""
from __future__ import annotations

from collections import Counter
from typing import Any
import numpy as np

from .features import normalize_scenario, workstation_distances


def quotas(scenario: dict) -> tuple[list, np.ndarray, np.ndarray, np.ndarray]:
    scenario = normalize_scenario(scenario)
    destinations = scenario["destinations"]
    m = len(scenario["map"]["chutes"])
    ids = [d["id"] for d in destinations]
    p = np.asarray([d["weight"] for d in destinations])
    lower = np.asarray([d.get("minChutes", 1) for d in destinations], dtype=int)
    upper = np.asarray([d.get("maxChutes", int(np.ceil(max(1, 1.5 * m * d["weight"])))) for d in destinations], dtype=int)
    if np.any(lower < 1) or np.any(upper < lower) or lower.sum() > m or upper.sum() < m:
        raise ValueError("Destination chute quotas are infeasible")
    return ids, lower, upper, p


def validate_mapping(scenario: dict, mapping: list[Any]) -> list[str]:
    ids, lower, upper, _ = quotas(scenario)
    errors = []
    if len(mapping) != len(scenario["map"]["chutes"]):
        errors.append("Mapping length does not match chute count")
    counts = Counter(mapping)
    if any(d not in ids for d in mapping):
        errors.append("Mapping contains an unknown destination")
    for d, lo, hi in zip(ids, lower, upper):
        if counts[d] < lo or counts[d] > hi:
            errors.append(f"Destination {d} needs between {lo} and {hi} chutes")
    return errors


def repair_mapping(scenario: dict, mapping: list[Any], rng: np.random.Generator | None = None) -> list[Any]:
    ids, lower, upper, _ = quotas(scenario)
    if len(mapping) != len(scenario["map"]["chutes"]):
        raise ValueError("Mapping length does not match chute count")
    index = {d: i for i, d in enumerate(ids)}
    result = [index.get(d, -1) for d in mapping]
    counts = np.bincount([d for d in result if d >= 0], minlength=len(ids))
    order = np.arange(len(result)) if rng is None else rng.permutation(len(result))
    # Unknown labels and excess assignments must change in every feasible repair.
    free = [int(i) for i in order if result[i] == -1]
    for i in order:
        d = result[i]
        if d >= 0 and counts[d] > upper[d]:
            free.append(int(i)); counts[d] -= 1; result[i] = -1
    # A remaining deficit requires exactly one additional edit from a surplus.
    deficit = int(np.maximum(lower - counts, 0).sum())
    for i in order:
        d = result[i]
        if len(free) >= deficit:
            break
        if d >= 0 and counts[d] > lower[d]:
            free.append(int(i)); counts[d] -= 1; result[i] = -1
    for i in free:
        needed = np.flatnonzero(counts < lower)
        allowed = needed if len(needed) else np.flatnonzero(counts < upper)
        if not len(allowed):
            raise ValueError("No quota-feasible repair exists")
        d = int(allowed[0] if rng is None else rng.choice(allowed))
        result[i] = d; counts[d] += 1
    repaired = [ids[d] for d in result]
    if validate_mapping(scenario, repaired):
        raise ValueError("Quota repair failed")
    return repaired


def random_mapping(scenario: dict, rng: np.random.Generator) -> list[Any]:
    ids, _, _, p = quotas(scenario)
    raw = [ids[int(i)] for i in rng.choice(len(ids), len(scenario["map"]["chutes"]), p=p)]
    return repair_mapping(scenario, raw, rng)


def greedy_mapping(scenario: dict, strategy: str = "min_dist") -> list[Any]:
    """Demand-proportional min-distance or spread-centroid cluster initialization."""
    scenario = normalize_scenario(scenario)
    ids, lower, upper, p = quotas(scenario)
    m, n = len(scenario["map"]["chutes"]), len(ids)
    counts = np.zeros(n, dtype=int)
    remaining = m
    for d in range(n):
        count = min(int(p[d] * m) + 1, remaining - int(lower[d + 1:].sum()))
        counts[d] = max(int(lower[d]), min(int(upper[d]), count))
        remaining -= counts[d]
    while remaining:
        allowed = np.flatnonzero(counts < upper)
        d = int(allowed[np.argmax(p[allowed] / (counts[allowed] + 1))])
        counts[d] += 1; remaining -= 1
    xy = np.asarray([[c["x"], c["y"]] for c in scenario["map"]["chutes"]], dtype=float)
    result = [None] * m
    available = list(range(m))
    centroids = []
    nearest = workstation_distances(scenario)
    for d, count in enumerate(counts):
        if strategy == "min_dist":
            selected = sorted(available, key=lambda i: (nearest[i], i))[:count]
        elif strategy == "cluster":
            if not centroids:
                first = min(available, key=lambda i: (xy[i, 1], xy[i, 0]))
            else:
                first = max(available, key=lambda i: (np.linalg.norm(xy[i] - np.asarray(centroids), axis=1).mean(), -i))
            selected = [first]
            for _ in range(int(count) - 1):
                rest = [i for i in available if i not in selected]
                selected.append(min(rest, key=lambda i: (np.linalg.norm(xy[i] - xy[selected], axis=1).mean(), i)))
            centroids.append(xy[selected].mean(0))
        else:
            raise ValueError("Unknown greedy initialization")
        for i in selected:
            result[i] = ids[d]
        selected_set = set(selected)
        available = [i for i in available if i not in selected_set]
    return repair_mapping(scenario, result)


def mutate_mapping(scenario: dict, mapping: list[Any], rng: np.random.Generator, operation: str = "geometric") -> list[Any]:
    ids, lower, upper, _ = quotas(scenario)
    result = list(mapping)
    m = len(result)
    if validate_mapping(scenario, result):
        raise ValueError("Mutation requires a feasible parent")
    if operation == "swap":
        a, b = rng.choice(m, 2, replace=False) if m > 1 else (0, 0)
        result[a], result[b] = result[b], result[a]
    elif operation == "transfer":
        counts = Counter(result)
        donors = [i for i, d in enumerate(result) if counts[d] > lower[ids.index(d)]]
        if donors:
            i = int(rng.choice(donors))
            receivers = [d for j, d in enumerate(ids) if d != result[i] and counts[d] < upper[j]]
            if receivers:
                result[i] = receivers[int(rng.integers(len(receivers)))]
    elif operation in ("geometric", "block"):
        k = min(m, int(rng.geometric(.5))) if operation == "geometric" else min(m, max(3, int(rng.geometric(.25))))
        if operation == "block":
            xy = np.asarray([[c["x"], c["y"]] for c in scenario["map"]["chutes"]])
            center = int(rng.integers(m))
            selected = np.argsort(np.linalg.norm(xy - xy[center], axis=1), kind="stable")[:k]
        else:
            selected = rng.choice(m, k, replace=False)
        for i in selected:
            result[int(i)] = ids[int(rng.integers(len(ids)))]
        result = repair_mapping(scenario, result, rng)
    else:
        raise ValueError("Unknown mutation operation")
    return result
