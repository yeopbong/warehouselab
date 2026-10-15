"""Static, destination-label invariant inputs for mapping predictors."""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from functools import lru_cache
from typing import Any
import numpy as np

ZONE_ROWS, ZONE_COLS = 3, 4
AUX_NAMES = ("trafficWaitFraction", "closedFraction")
NODE_DIM, GLOBAL_DIM = 13, 9


def normalize_scenario(scenario: dict) -> dict:
    data = dict(scenario)
    grid = dict(data.get("map", {}))
    if not grid.get("chutes") or not data.get("destinations"):
        raise ValueError("A scenario needs chutes and destinations")
    width, height = int(grid["width"]), int(grid["height"])
    if width < 1 or height < 1:
        raise ValueError("Map dimensions must be positive")
    destinations = [dict(d) for d in data["destinations"]]
    ids = [d["id"] for d in destinations]
    if len(set(ids)) != len(ids):
        raise ValueError("Destination identifiers must be unique")
    weights = np.asarray([d["weight"] for d in destinations], dtype=float)
    if not np.all(np.isfinite(weights)) or np.any(weights < 0) or weights.sum() <= 0:
        raise ValueError("Destination weights must be finite and nonnegative")
    for d, weight in zip(destinations, weights / weights.sum()):
        d["weight"] = float(weight)
    data.update(map=grid, destinations=destinations)
    return data


def zone_index(x: float, y: float, width: int, height: int) -> int:
    return min(ZONE_ROWS - 1, int(y * ZONE_ROWS / height)) * ZONE_COLS + min(ZONE_COLS - 1, int(x * ZONE_COLS / width))


def _workstation_distances(scenario: dict) -> np.ndarray:
    grid = scenario["map"]
    width, height = int(grid["width"]), int(grid["height"])
    chutes, stations = grid["chutes"], grid.get("workstations", [])
    if not stations:
        raise ValueError("A scenario needs induct workstations")
    layout = grid.get("layout")
    if layout:
        if len(layout) != height or any(len(row) != width for row in layout):
            raise ValueError("Layout dimensions do not match map dimensions")
        distance = np.full((height, width), np.inf)
        queue = deque()
        for station in stations:
            x, y = int(station["x"]), int(station["y"])
            distance[y, x] = 0
            queue.append((x, y))
        while queue:
            x, y = queue.popleft()
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < width and 0 <= ny < height and layout[ny][nx] not in "@T#" and distance[ny, nx] == np.inf:
                    distance[ny, nx] = distance[y, x] + 1
                    queue.append((nx, ny))
        result = []
        for chute in chutes:
            x, y = int(chute["x"]), int(chute["y"])
            reachable = [distance[ny, nx] + 1 for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)) if 0 <= nx < width and 0 <= ny < height]
            result.append(min(reachable, default=np.inf))
        result = np.asarray(result)
        if not np.isfinite(result).all():
            raise ValueError("Every chute must be reachable from a workstation")
        return result
    return np.asarray([min(abs(c["x"] - w["x"]) + abs(c["y"] - w["y"]) for w in stations) for c in chutes], dtype=float)


@lru_cache(maxsize=64)
def _cached_distances(width: int, height: int, chutes: tuple, stations: tuple, layout: tuple) -> np.ndarray:
    grid = {"width": width, "height": height, "chutes": [{"x": x, "y": y} for x, y in chutes], "workstations": [{"x": x, "y": y} for x, y in stations]}
    if layout:
        grid["layout"] = layout
    return _workstation_distances({"map": grid})


def workstation_distances(scenario: dict) -> np.ndarray:
    grid = scenario["map"]
    return _cached_distances(int(grid["width"]), int(grid["height"]), tuple((c["x"], c["y"]) for c in grid["chutes"]), tuple((c["x"], c["y"]) for c in grid.get("workstations", [])), tuple(grid.get("layout", [])))


@lru_cache(maxsize=64)
def _spatial_geometry(coordinates: tuple, width: int, height: int) -> tuple[np.ndarray, np.ndarray]:
    xy = np.asarray(coordinates, dtype=float)
    m = len(xy)
    distances_pair = np.linalg.norm(xy[:, None] - xy[None, :], axis=-1)
    nearest = np.argsort(distances_pair, axis=1, kind="stable")[:, :min(7, m)]
    spatial = np.zeros((m, m))
    for i in range(m):
        spatial[i, nearest[i]] = np.exp(-distances_pair[i, nearest[i]] / max(1, max(width, height) / 8))
    spatial /= spatial.sum(axis=1, keepdims=True)
    zones = np.zeros((ZONE_ROWS * ZONE_COLS, m))
    for i, (x, y) in enumerate(xy):
        zones[zone_index(x, y, width, height), i] = 1
    zones /= np.maximum(1, zones.sum(axis=1, keepdims=True))
    return spatial, zones


@dataclass
class MappingFeatures:
    nodes: np.ndarray
    same_destination: np.ndarray
    spatial: np.ndarray
    zones: np.ndarray
    context: np.ndarray
    flat: np.ndarray


def mapping_features(scenario: dict, mapping: list[Any]) -> MappingFeatures:
    scenario = normalize_scenario(scenario)
    grid, destinations = scenario["map"], scenario["destinations"]
    chutes = grid["chutes"]
    m, n = len(chutes), len(destinations)
    if len(mapping) != m:
        raise ValueError("Mapping length must equal chute count")
    lookup = {d["id"]: i for i, d in enumerate(destinations)}
    try:
        assignment = np.asarray([lookup[d] for d in mapping], dtype=int)
    except KeyError as error:
        raise ValueError("Unknown destination in mapping") from error
    count = np.bincount(assignment, minlength=n)
    if np.any(count == 0):
        raise ValueError("Every destination needs a chute")
    width, height = int(grid["width"]), int(grid["height"])
    scale = max(width, height)
    xy = np.asarray([[c["x"], c["y"]] for c in chutes], dtype=float)
    weights = np.asarray([d["weight"] for d in destinations])
    centroids = np.stack([xy[assignment == i].mean(axis=0) for i in range(n)])
    spread = np.asarray([np.linalg.norm(xy[assignment == i] - centroids[i], axis=1).mean() for i in range(n)])
    distances = workstation_distances(scenario)
    demand = weights[assignment]
    assigned_count = count[assignment]
    recirc = np.asarray([bool(d.get("recirculation", False)) for d in destinations], dtype=float)
    upper = np.asarray([d.get("maxChutes", int(np.ceil(max(1, 1.5 * m * d["weight"])))) for d in destinations], dtype=float)
    minimum = np.asarray([d.get("minChutes", 1) for d in destinations], dtype=float)
    expected_closed = float(scenario.get("closeBase", 50)) + 2 * spread ** 2 + float(scenario.get("closeMean", 100))
    nodes = np.column_stack([
        xy[:, 0] / width, xy[:, 1] / height, distances / scale,
        demand, assigned_count / m, demand * m / assigned_count,
        spread[assignment] / scale, expected_closed[assignment] / 1000,
        recirc[assignment], minimum[assignment] / m, upper[assignment] / m,
        centroids[assignment, 0] / width, centroids[assignment, 1] / height,
    ])
    same = (assignment[:, None] == assignment[None, :]).astype(float)
    same /= same.sum(axis=1, keepdims=True)
    spatial, zones = _spatial_geometry(tuple(map(tuple, xy)), width, height)
    context = np.asarray([
        width / 100, height / 100, m / 100, n / 100,
        float(scenario.get("fleetSize", 1)) / (width * height),
        float(scenario.get("horizon", 1000)) / 5000,
        len(grid.get("workstations", [])) / 100,
        float(scenario.get("capacity", 50)) / 100,
        float(scenario.get("closeBase", 50)) / 1000,
    ])
    # The baseline retains useful analytic summaries but discards spatial placement.
    summary_columns = nodes[:, [2, 3, 4, 5, 6, 7, 8, 9, 10]]
    flat = np.concatenate([context, summary_columns.mean(0), summary_columns.std(0), summary_columns.max(0), [np.dot(demand / assigned_count, distances) / scale]])
    return MappingFeatures(*(np.asarray(v, dtype=np.float32) for v in (nodes, same, spatial, zones, context, flat)))


def auxiliary_targets(observation: dict) -> tuple[np.ndarray, np.ndarray]:
    values = np.zeros((ZONE_ROWS * ZONE_COLS, len(AUX_NAMES)), dtype=np.float32)
    mask = np.zeros_like(values)
    auxiliary = observation.get("auxiliary") or {}
    zones = auxiliary.get("zones", []) if isinstance(auxiliary, dict) else []
    for i, zone in enumerate(zones[:len(values)]):
        for j, name in enumerate(AUX_NAMES):
            value = zone.get(name) if isinstance(zone, dict) else None
            if value is not None and np.isfinite(value):
                values[i, j], mask[i, j] = float(value), 1
    return values, mask
