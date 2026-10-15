from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def source_dir() -> Path:
    return Path(os.environ.get("WAREHOUSE_TMO_SOURCE", ROOT / ".cache/tmo/source"))


def data_dir() -> Path:
    return Path(os.environ.get("WAREHOUSE_SORTING_DATA", ROOT / ".sorting-data"))


def demand_weights(count: int, hot_mass: float | None) -> list[float]:
    if hot_mass is None:
        return [1 / count] * count + [0.02]
    hot, middle = max(1, int(count * .1)), max(1, int(count * .2))
    cold = count - hot - middle
    middle_mass = (1 - hot_mass) * 2 / 3
    return ([hot_mass / hot] * hot + [middle_mass / middle] * middle
            + [(1 - hot_mass - middle_mass) / cold] * cold + [.02])


def make_scenario(scenario_id: str, name: str, map_name: str, destinations: int,
                  fleet: int, hot_mass: float | None, horizon: int = 1500) -> dict:
    raw = json.loads((source_dir() / "maps/sortation" / (map_name + ".json")).read_text())
    layout = raw["layout"]
    width, height = len(layout[0]), len(layout)
    chutes, stations = [], []
    for y, row in enumerate(layout):
        for x, tile in enumerate(row):
            cell = y * width + x
            if tile == "@":
                chutes.append({"id": f"C{len(chutes) + 1:03}", "cell": cell, "x": x, "y": y})
            if tile == "w":
                stations.append({"cell": cell, "x": x, "y": y})
    weights = demand_weights(destinations, hot_mass)
    ds = [{"id": f"D{i + 1:02}" if i < destinations else "REC",
           "label": f"Destination {i + 1}" if i < destinations else "Recirculation",
           "weight": w, "recirculation": i == destinations, "minChutes": 1,
           "maxChutes": max(1, math.ceil(1.5 * len(chutes) * w))}
          for i, w in enumerate(weights)]
    result = {"id": scenario_id, "name": name,
              "map": {"id": map_name, "width": width, "height": height, "layout": layout,
                      "chutes": chutes, "workstations": stations},
              "destinations": ds, "fleetSize": fleet, "horizon": horizon,
              "demandDescription": "Uniform" if hot_mass is None else f"Top 10% receive {hot_mass:.0%} of packages",
              "randomization": "Independent simulation seeds; mapping-dependent draws are not common random numbers."}
    validate_scenario(result)
    return result


def scenarios() -> list[dict]:
    sparse = "sortation_33_57_105-chutes"
    return [
        make_scenario("sparse-450-721", "105 chutes · 450 robots · 70% hot demand", sparse, 41, 450, .7),
        make_scenario("sparse-300-55", "105 chutes · 300 robots · 55% hot demand", sparse, 41, 300, .55),
        make_scenario("sparse-450-55", "105 chutes · 450 robots · 55% hot demand", sparse, 41, 450, .55),
        make_scenario("sparse-600-721", "105 chutes · 600 robots · 70% hot demand", sparse, 41, 600, .7),
        make_scenario("sparse-450-85", "105 chutes · 450 robots · 85% hot demand", sparse, 41, 450, .85),
        make_scenario("sparse-300-uniform", "105 chutes · 300 robots · uniform demand", sparse, 41, 300, None),
        make_scenario("dense-600-721", "253 chutes · 600 robots · 70% hot demand", "sortation_33_57", 99, 600, .7),
    ]


def validate_scenario(scenario: dict) -> None:
    floor = scenario["map"]
    layout, width, height = floor["layout"], floor["width"], floor["height"]
    if len(layout) != height or any(len(row) != width for row in layout):
        raise ValueError("Map dimensions do not match the layout")
    expected = [(x, y) for y, row in enumerate(layout) for x, tile in enumerate(row) if tile == "@"]
    if [(c["x"], c["y"]) for c in floor["chutes"]] != expected:
        raise ValueError("Chutes must follow the map's row-major order")
    destinations = scenario["destinations"]
    if len({d["id"] for d in destinations}) != len(destinations):
        raise ValueError("Destination IDs must be unique")
    if sum(bool(d.get("recirculation")) for d in destinations) != 1:
        raise ValueError("Exactly one recirculation destination is required")
    for d in destinations:
        if not math.isfinite(d["weight"]) or d["weight"] <= 0:
            raise ValueError("Destination weights must be finite and positive")
        if not 1 <= d["minChutes"] <= d["maxChutes"]:
            raise ValueError("Invalid chute quota")
    if not sum(d["minChutes"] for d in destinations) <= len(expected) <= sum(d["maxChutes"] for d in destinations):
        raise ValueError("Chute quotas cannot cover this map")
    walkable = sum(tile not in "T@#" for row in layout for tile in row)
    if not isinstance(scenario["fleetSize"], int) or not 1 <= scenario["fleetSize"] <= walkable:
        raise ValueError("Fleet size exceeds the traversable floor")
    if not isinstance(scenario["horizon"], int) or not 1 <= scenario["horizon"] <= 100000:
        raise ValueError("Horizon must be an integer from 1 to 100000")


def validate_mapping(scenario: dict, mapping: list[str]) -> None:
    if len(mapping) != len(scenario["map"]["chutes"]):
        raise ValueError("One destination is required for every chute")
    ids = {d["id"] for d in scenario["destinations"]}
    if any(d not in ids for d in mapping):
        raise ValueError("Unknown destination in mapping")
    for destination in scenario["destinations"]:
        n = mapping.count(destination["id"])
        if not destination["minChutes"] <= n <= destination["maxChutes"]:
            raise ValueError(f"Quota violated for {destination['id']}: {n} chutes")
