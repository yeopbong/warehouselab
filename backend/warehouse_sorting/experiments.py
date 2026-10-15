"""Reproducible cold-start and historical-data comparisons on the native simulator."""
from __future__ import annotations

import argparse
import copy
import hashlib
import gzip
from importlib.metadata import version
import json
import math
import multiprocessing
import os
import platform
import shutil
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean, stdev
from typing import Any

import numpy as np

from .config import ROOT, digest, scenarios
from .engine import Engine
from .mapping import greedy_mapping, random_mapping
from .model import MappingSurrogate, SimpleSurrogate
from .store import Store

METHODS = ["ea", "simple", "flat_aux", "spatial", "spatial_aux_top", "spatial_aux"]
LEARNING_METHODS = METHODS[1:]
COST_KEYS = ("started", "completed", "failed", "cancelled", "cacheHits", "replicates", "executedTicks", "unknownExecutedTickRuns", "simulationSeconds", "trainingSeconds", "selectionSeconds")


def _write(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def implementation_hash() -> str:
    files = sorted(ROOT / "backend/warehouse_sorting" / name for name in
                   ("config.py", "runtime.py", "engine.py", "features.py", "mapping.py", "model.py", "search.py", "store.py"))
    return hashlib.sha256(b"".join(p.name.encode() + p.read_bytes() for p in files)).hexdigest()


def total_cost(studies: list[dict]) -> dict:
    unique = {s["id"]: s for s in studies}
    return {key: sum(s.get("costs", {}).get(key, 0) for s in unique.values()) for key in COST_KEYS}


def environment_record(engine: Engine, workers: int) -> dict:
    import torch
    return {"schemaVersion": 1, "platform": platform.platform(), "machine": platform.machine(),
            "python": platform.python_version(), "logicalCPUs": os.cpu_count(), "workerCount": workers,
            "device": "cpu", "torchThreadsAtEnvironmentCapture": torch.get_num_threads(),
            "modelFitThreadsPerWorker": 1,
            "packages": {name: version(name) for name in ("numpy", "scipy", "scikit-learn", "torch")},
            "simulator": engine.runtime.identity(), "implementationHash": implementation_hash()}


def public_environment(record: dict) -> dict:
    result = copy.deepcopy(record)
    if "torchThreadsPerWorker" in result:
        captured = result.pop("torchThreadsPerWorker")
        if result.get("torchThreadsAtEnvironmentCapture", captured) != captured:
            raise ValueError("Conflicting thread counts in the environment capture")
        result["torchThreadsAtEnvironmentCapture"] = captured
    result["modelFitThreadsPerWorker"] = 1
    result["threadScope"] = "The captured count describes the recording process. Neural model fitting sets one thread per worker when used."
    return result


def best_candidate(study: dict) -> dict | None:
    completed = [c for c in study["candidates"] if c.get("status") == "completed" and c.get("throughput") is not None]
    return max(completed, key=lambda c: c["throughput"], default=None)


def _reuse_or_run(engine: Engine, identifier: str, scenario: dict, function, **kwargs) -> dict:
    path = engine.store.path("studies", identifier)
    if path.exists():
        study = engine.store.read("studies", identifier)
        if study["status"] != "completed":
            raise RuntimeError(f"Study {identifier} is incomplete; preserve it and resolve it before resuming")
        if digest(study["scenario"]) != digest(scenario) or study["simulator"] != engine.runtime.identity():
            raise ValueError("Existing study does not match the requested scenario and simulator")
        if study.get("implementationHash") != implementation_hash():
            raise ValueError("Existing study used a different implementation")
        return study
    return function(scenario, study_id=identifier, **kwargs)


def run_pilot(engine: Engine, output: Path, *, horizon: int = 1500, simulation_seeds: list[int] | None = None) -> dict:
    output = Path(output)
    seed_values = simulation_seeds or [61, 73, 89]
    scenario = next(copy.deepcopy(s) for s in scenarios() if s["id"] == "sparse-450-55")
    scenario["horizon"] = horizon
    identity = digest({"scenario": scenario, "seeds": seed_values, "runtime": engine.runtime.identity(), "implementation": implementation_hash()})[:10]
    mappings = [("min-dist", greedy_mapping(scenario, "min_dist")), ("cluster", greedy_mapping(scenario, "cluster")), ("random", random_mapping(scenario, np.random.default_rng(1701)))]
    studies = []
    for label, mapping in mappings:
        identifier = f"pilot-{identity}-{label}"
        study = _reuse_or_run(engine, identifier, scenario, engine.run_manual, mapping=mapping, simulation_seeds=seed_values, record_trace=False, name=f"Validation pilot · {label}", purpose="validation-pilot")
        studies.append(study)
        _write(output / "pilot.json", {"status": "running", "studyIds": [s["id"] for s in studies]})
    evaluations = [e for s in studies for c in s["candidates"] for e in c["evaluations"]]
    rows = []
    for label, study in zip((m[0] for m in mappings), studies):
        candidate = study["candidates"][0]
        values = [e["metrics"]["throughput"] for e in candidate["evaluations"] if e["status"] == "completed"]
        rows.append({"mapping": label, "studyId": study["id"], "mean": mean(values) if values else None, "std": stdev(values) if len(values) > 1 else None, "values": values})
    completed = [e for e in evaluations if e["status"] == "completed"]
    event_counts = {"reroutes": sum(e["metrics"]["reroutes"] for e in completed), "recirculated": sum(e["metrics"]["recirculated"] for e in completed), "closedChuteTicks": sum(z["closedChuteTicks"] for e in completed for z in e["auxiliary"]["zones"]), "trafficWaitTicks": sum(e["metrics"]["trafficWaitTicks"] for e in completed)}
    observations = Engine.observations(studies)
    timing = {}
    pool = [random_mapping(scenario, np.random.default_rng(3000 + i)) for i in range(128)]
    for name, model in (("simple", SimpleSurrogate(41)), ("spatial_aux", MappingSurrogate(seed=41, epochs=70))):
        training = model.fit(scenario, observations)
        start = time.perf_counter(); model.predict(scenario, pool)
        timing[name] = {"trainingSeconds": training["seconds"], "predictionSeconds": time.perf_counter() - start, "trainingObservations": len(observations), "predictedCandidates": len(pool)}
    result = {"schemaVersion": 1, "status": "completed" if len(completed) == len(evaluations) else "failed", "createdAt": datetime.now(timezone.utc).isoformat(), "scenarioId": scenario["id"], "horizon": horizon, "simulationSeeds": seed_values, "studyIds": [s["id"] for s in studies], "simulator": engine.runtime.identity(), "implementationHash": implementation_hash(), "mappings": rows, "events": event_counts, "costs": total_cost(studies), "modelTiming": timing, "secondsPerSimulation": float(np.median([e["wallSeconds"] for e in completed])) if completed else None}
    _write(output / "pilot.json", result)
    return result


def freeze_protocol(pilot: dict, output: Path, *, cross_map: bool = False) -> dict:
    if pilot.get("status") != "completed" or not pilot.get("secondsPerSimulation"):
        raise ValueError("A successful native validation pilot is required before freezing the protocol")
    if pilot["events"].get("closedChuteTicks", 0) == 0:
        raise ValueError("The pilot horizon did not expose chute closures; extend the validation pilot first")
    if pilot["implementationHash"] != implementation_hash():
        raise ValueError("The scientific implementation changed after the pilot")
    protocol = {"schemaVersion": 1, "objective": "Sorted parcels per simulation tick", "simulator": pilot["simulator"], "implementationHash": pilot["implementationHash"], "pilotStudyIds": pilot["studyIds"], "horizon": pilot["horizon"], "methods": METHODS, "learningMethods": LEARNING_METHODS, "trainScenarios": ["sparse-450-721", "sparse-300-55"], "validationScenario": "sparse-450-55", "testScenarios": ["sparse-600-721", "sparse-450-85"], "crossMapScenario": "dense-600-721" if cross_map else None, "crossMapMethods": ["simple", "spatial_aux"], "optimizerSeeds": [7, 19, 43], "selectionSeeds": [11, 29], "historySeeds": [101, 211], "finalSeeds": [1009, 2029, 3049, 4051, 5059], "onlineBudget": 24, "historyBudgetPerScenario": 96, "batchSize": 3, "poolSize": 128, "epochs": 70, "initialSize": 4, "auxiliaryWeight": .25, "ensembleSize": 3, "bootstrapSamples": 4000, "bootstrapSeed": 817, "randomization": "Simulation and optimizer seeds are separate. Equal simulator seeds form comparison blocks, not identical exogenous random streams across mappings.", "finalSelection": "Choose each run's best measured mapping using selection seeds; evaluate it on independent final seeds without further selection or tuning.", "costAccounting": "Count every started native call, including failures and replicates. Report cache hits, executed ticks and training time separately. Historical data generation is charged once and its access is declared for every history run.", "historyPolicy": "All learning methods receive the same measured training-condition data. EA remains a cold-start reference; no optimized mapping is transferred for free.", "inferenceScope": "Two unseen demand/fleet conditions on the same map. Cross-map reoptimization, if enabled, is a separate test. Three optimizer repetitions support descriptive uncertainty, not strong significance claims."}
    protocol["plannedCalls"] = planned_calls(protocol)
    pilot_cost = dict(pilot["costs"])
    pilot_cost["trainingSeconds"] += sum(row["trainingSeconds"] for row in pilot["modelTiming"].values())
    pilot_cost["selectionSeconds"] += sum(row["predictionSeconds"] for row in pilot["modelTiming"].values())
    protocol["pilotCost"] = pilot_cost
    protocol["estimatedNativeSeconds"] = protocol["plannedCalls"]["total"] * pilot["secondsPerSimulation"]
    protocol["protocolHash"] = digest(protocol)
    path = Path(output) / "protocol.json"
    if path.exists():
        existing = json.loads(path.read_text())
        if existing["protocolHash"] != protocol["protocolHash"]:
            raise ValueError("A different protocol is already frozen in this directory")
        return existing
    _write(path, protocol)
    return protocol


def planned_calls(protocol: dict) -> dict:
    n, repeats, budget = len(protocol["testScenarios"]), len(protocol["optimizerSeeds"]), protocol["onlineBudget"]
    final = len(protocol["finalSeeds"])
    costs = {"history": len(protocol["trainScenarios"]) * protocol["historyBudgetPerScenario"], "coldOptimization": n * repeats * len(protocol["methods"]) * budget, "historyOptimization": n * repeats * len(protocol["learningMethods"]) * budget, "finalEvaluation": n * repeats * (len(protocol["methods"]) + len(protocol["learningMethods"])) * final, "greedyEvaluation": n * 2 * final, "crossMapOptimization": 0, "crossMapFinal": 0}
    if protocol.get("crossMapScenario"):
        costs["crossMapOptimization"] = 2 * len(protocol["crossMapMethods"]) * repeats * budget
        costs["crossMapFinal"] = (2 * len(protocol["crossMapMethods"]) * repeats + 2) * final
    costs["total"] = sum(costs.values())
    return costs


def hierarchical_interval(repetitions: list[list[float]], *, seed: int = 817, samples: int = 4000) -> dict:
    values = [np.asarray(row, dtype=float) for row in repetitions if len(row)]
    if any(not np.isfinite(row).all() for row in values):
        raise ValueError("Statistics require finite measured values")
    if not values:
        return {"mean": None, "interval95": None, "optimizerRuns": 0, "simulationRuns": 0}
    estimate = float(np.mean([row.mean() for row in values]))
    if len(values) < 2:
        return {"mean": estimate, "interval95": None, "optimizerRuns": len(values), "simulationRuns": sum(map(len, values))}
    rng = np.random.default_rng(seed)
    chosen = rng.integers(len(values), size=(samples, len(values)))
    resampled = np.empty(chosen.shape)
    for j, row in enumerate(values):
        positions = np.where(chosen == j)
        resampled[positions] = rng.choice(row, size=(len(positions[0]), len(row)), replace=True).mean(axis=1)
    draws = resampled.mean(axis=1)
    return {"mean": estimate, "interval95": np.quantile(draws, [.025, .975]).tolist(), "optimizerRuns": len(values), "simulationRuns": sum(map(len, values))}


def crossed_interval(repetitions: list[list[float]], *, seed: int = 817, samples: int = 4000) -> dict:
    if not repetitions:
        return {"mean": None, "interval95": None, "optimizerRuns": 0, "simulationRuns": 0}
    if not repetitions[0] or len({len(row) for row in repetitions}) != 1:
        raise ValueError("Crossed intervals require the same ordered simulation seed blocks in every optimizer run")
    values = np.asarray(repetitions, dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("Statistics require finite measured values")
    rows, columns = values.shape
    result = {"mean": float(values.mean()), "interval95": None, "optimizerRuns": rows, "simulationRuns": rows * columns}
    if rows < 2:
        return result
    rng = np.random.default_rng(seed)
    sampled_rows = rng.integers(rows, size=(samples, rows))
    sampled_columns = rng.integers(columns, size=(samples, columns))
    # Shared seed columns remain shared after resampling the optimizer rows.
    draws = values[sampled_rows[:, :, None], sampled_columns[:, None, :]].mean(axis=(1, 2))
    result["interval95"] = np.quantile(draws, [.025, .975]).tolist()
    return result


def _replicate_values(study: dict) -> dict[int, float]:
    candidate = best_candidate(study)
    if candidate is None:
        return {}
    return {e["simulationSeed"]: e["metrics"]["throughput"] for e in candidate["evaluations"] if e["status"] == "completed"}


def _learning_curve(study: dict) -> dict:
    incumbent, previous, area = 0., 0, 0.
    points = []
    for candidate in study["candidates"]:
        calls = candidate.get("calls", previous)
        area += incumbent * max(0, calls - previous)
        if candidate.get("throughput") is not None:
            incumbent = max(incumbent, candidate["throughput"])
        points.append({"calls": calls, "bestMeasuredThroughput": incumbent, "candidateId": candidate["id"]})
        previous = calls
    area += incumbent * max(0, study["budget"] - previous)
    return {"points": points, "budgetNormalizedArea": area / study["budget"]}


def prediction_diagnostics(study: dict) -> dict:
    predicted, measured, auxiliary_errors = [], [], []
    for candidate in study["candidates"]:
        forecast = candidate.get("prediction")
        if not forecast or candidate.get("throughput") is None:
            continue
        predicted.append(forecast["mean"]); measured.append(candidate["throughput"])
        if forecast.get("auxiliary") and candidate.get("auxiliary"):
            for p, actual in zip(forecast["auxiliary"]["zones"], candidate["auxiliary"]["zones"]):
                for name in ("trafficWaitFraction", "closedFraction"):
                    auxiliary_errors.append((p[name] - actual[name]) ** 2)
    rank = None
    if len(predicted) >= 3 and len(set(predicted)) > 1 and len(set(measured)) > 1:
        from scipy.stats import spearmanr
        rank = float(spearmanr(predicted, measured).statistic)
    return {"predictedCandidates": len(predicted), "throughputRMSE": math.sqrt(mean((p - y) ** 2 for p, y in zip(predicted, measured))) if predicted else None, "rankCorrelation": rank, "auxiliaryRMSE": math.sqrt(mean(auxiliary_errors)) if auxiliary_errors else None, "predictionTiming": "Frozen before the selected batch's simulations"}


def selection_agreement(entries: list[dict], studies: dict[str, dict], initial_size: int) -> list[dict]:
    groups = {}
    for entry in entries:
        if entry["phase"] in ("optimization", "cross-optimization"):
            key = (entry["scenarioId"], entry["regime"], entry["optimizerSeed"])
            groups.setdefault(key, {})[entry["method"]] = entry["studyId"]
    contrasts = (("auxiliary-supervision", "spatial"), ("spatial-representation", "flat_aux"),
                 ("complementary-batch", "spatial_aux_top"))
    comparisons = []
    for key, methods in sorted(groups.items()):
        if "spatial_aux" not in methods:
            continue
        left_study = studies[methods["spatial_aux"]]
        left_all = left_study["candidates"]
        for contrast, reference in contrasts:
            if reference not in methods:
                continue
            right_study = studies[methods[reference]]
            right_all = right_study["candidates"]
            left, right = left_all[initial_size:], right_all[initial_size:]
            a, b = [tuple(c["mapping"]) for c in left], [tuple(c["mapping"]) for c in right]
            position_matches = [x == y for x, y in zip(a, b)]

            def first_batch(candidates):
                if not candidates:
                    return []
                return [tuple(c["mapping"]) for c in candidates if c.get("round") == candidates[0].get("round")]

            first_a, first_b = first_batch(left), first_batch(right)
            winner_a, winner_b = best_candidate(left_study), best_candidate(right_study)
            comparisons.append({"contrast": contrast, "scenarioId": key[0], "regime": key[1], "optimizerSeed": key[2],
                "target": "spatial_aux", "reference": reference, "targetStudyId": left_study["id"], "referenceStudyId": right_study["id"],
                "initializationIdentical": len(left_all) >= initial_size and len(right_all) >= initial_size
                and [c["mapping"] for c in left_all[:initial_size]] == [c["mapping"] for c in right_all[:initial_size]],
                "initialCandidates": initial_size, "targetGuidedCandidates": len(a), "referenceGuidedCandidates": len(b),
                "matchedPositions": len(position_matches), "sameMappingPositions": sum(position_matches),
                "sameMappingFraction": sum(position_matches) / len(position_matches) if position_matches else None,
                "perPositionEqual": position_matches, "sharedGuidedMappings": len(set(a) & set(b)),
                "guidedSetIdentical": set(a) == set(b) if a and b else None,
                "selectedWinnerIdentical": winner_a["mapping"] == winner_b["mapping"] if winner_a and winner_b else None,
                "firstGuidedBatchTargetCount": len(first_a), "firstGuidedBatchReferenceCount": len(first_b),
                "firstGuidedBatchSharedMappings": len(set(first_a) & set(first_b)),
                "firstGuidedBatchDifferent": set(first_a) != set(first_b) if first_a and first_b else None,
                "firstGuidedBatchOrderDifferent": first_a != first_b if first_a and first_b else None})
    return comparisons


def summarize(engine: Engine, protocol: dict, manifest: dict) -> dict:
    known = {e["studyId"]: e for e in manifest.get("entries", [])}
    for entry in manifest.get("plannedStudies", []):
        if entry["studyId"] not in known and engine.store.path("studies", entry["studyId"]).exists():
            known[entry["studyId"]] = entry
    entries = list(known.values())
    studies = {e["studyId"]: engine.store.read("studies", e["studyId"]) for e in entries}
    final_rows, greedy_rows = [], []
    for entry in entries:
        if entry["phase"] not in ("final", "cross-final", "greedy-final"):
            continue
        study = studies[entry["studyId"]]
        values = _replicate_values(study)
        row = {**entry, "status": study["status"], "throughput": mean(values.values()) if values and study["status"] == "completed" else None, "bySimulationSeed": {str(k): v for k, v in values.items()}, "mapping": study["candidates"][0]["mapping"] if study["candidates"] else None, "costs": study["costs"]}
        (greedy_rows if entry["phase"] == "greedy-final" else final_rows).append(row)
    groups = {}
    for row in final_rows:
        key = (row["scenarioId"], row["regime"], row["method"])
        groups.setdefault(key, []).append(row)
    aggregated = []
    for key, rows in sorted(groups.items()):
        rows = sorted(rows, key=lambda row: row["optimizerSeed"])
        measurements = [[r["bySimulationSeed"][str(seed)] for seed in protocol["finalSeeds"]] for r in rows if r["status"] == "completed"]
        terminal_failure = ("failed", "cancelled", "interrupted")
        aggregated.append({"scenarioId": key[0], "regime": key[1], "method": key[2], **crossed_interval(measurements, seed=protocol["bootstrapSeed"], samples=protocol["bootstrapSamples"]), "failedOptimizerRuns": sum(r["status"] in terminal_failure for r in rows), "inProgressOptimizerRuns": sum(r["status"] != "completed" and r["status"] not in terminal_failure for r in rows), "perOptimizerRun": [{"optimizerSeed": r["optimizerSeed"], "throughput": r["throughput"], "studyId": r["studyId"]} for r in rows]})
    comparisons = []
    contrasts = [("spatial-representation", "spatial_aux", "flat_aux"), ("auxiliary-supervision", "spatial_aux", "spatial"), ("complementary-batch", "spatial_aux", "spatial_aux_top"), ("simple-surrogate", "spatial_aux", "simple"), ("evolutionary-reference", "spatial_aux", "ea")]
    for scenario in sorted({row["scenarioId"] for row in final_rows}):
        for regime in ("cold", "history"):
            for name, target, reference in contrasts:
                left = {r["optimizerSeed"]: r for r in groups.get((scenario, regime, target), []) if r["status"] == "completed"}
                right_regime = "cold" if reference == "ea" else regime
                right = {r["optimizerSeed"]: r for r in groups.get((scenario, right_regime, reference), []) if r["status"] == "completed"}
                differences = []
                for optimizer_seed in sorted(left.keys() & right.keys()):
                    a, b = left[optimizer_seed]["bySimulationSeed"], right[optimizer_seed]["bySimulationSeed"]
                    common = sorted(a.keys() & b.keys())
                    if common:
                        differences.append([a[s] - b[s] for s in common])
                if differences:
                    comparisons.append({"contrast": name, "scenarioId": scenario, "regime": regime, "target": target, "reference": reference, "referenceRegime": right_regime, **crossed_interval(differences, seed=protocol["bootstrapSeed"], samples=protocol["bootstrapSamples"])})
        for method in protocol["learningMethods"]:
            cold = {r["optimizerSeed"]: r for r in groups.get((scenario, "cold", method), []) if r["status"] == "completed"}
            history = {r["optimizerSeed"]: r for r in groups.get((scenario, "history", method), []) if r["status"] == "completed"}
            diffs = []
            for optimizer_seed in sorted(cold.keys() & history.keys()):
                a, b = history[optimizer_seed]["bySimulationSeed"], cold[optimizer_seed]["bySimulationSeed"]
                common = sorted(a.keys() & b.keys())
                if common:
                    diffs.append([a[s] - b[s] for s in common])
            if diffs:
                comparisons.append({"contrast": "historical-data", "scenarioId": scenario, "target": method, "reference": method, "regime": "history", "referenceRegime": "cold", **crossed_interval(diffs, seed=protocol["bootstrapSeed"], samples=protocol["bootstrapSamples"])})
    stage_costs = {phase: total_cost([studies[e["studyId"]] for e in entries if e["phase"] == phase]) for phase in sorted({e["phase"] for e in entries})}
    optimization = [{**e, "costs": studies[e["studyId"]]["costs"], "curve": _learning_curve(studies[e["studyId"]]), "prediction": prediction_diagnostics(studies[e["studyId"]])} for e in entries if e["phase"] in ("optimization", "cross-optimization")]
    protocol_cost = total_cost(list(studies.values()))
    pilot_cost = protocol.get("pilotCost", {})
    research_cost = {key: protocol_cost[key] + pilot_cost.get(key, 0) for key in COST_KEYS}
    return {"schemaVersion": 1, "protocolHash": protocol["protocolHash"], "simulator": protocol["simulator"], "implementationHash": protocol["implementationHash"], "status": manifest["status"], "finalResults": final_rows, "greedyReferences": greedy_rows, "groups": aggregated, "pairedContrasts": comparisons, "selectionAgreement": selection_agreement(entries, studies, protocol.get("initialSize", 4)), "selectionAgreementMeaning": "Changed mappings demonstrate an influence on selection, not an improvement. Independent final throughput contrasts measure utility.", "optimization": optimization, "costsByPhase": stage_costs, "totalCost": protocol_cost, "pilotCost": pilot_cost, "totalResearchCost": research_cost, "costScope": "totalCost covers the frozen protocol; totalResearchCost adds its recorded validation pilot. Earlier pilots and engineering checks are retained separately, excluded from these costs, and were not used as historical training data.", "analysisMethod": {"name": "Crossed row and seed-block percentile bootstrap", "reference": "https://doi.org/10.1214/07-AOAS122", "samples": protocol["bootstrapSamples"], "seed": protocol["bootstrapSeed"], "rows": "Optimizer repetitions", "columns": "Shared final simulation seeds, sampled once per bootstrap draw and reused across its rows", "pairedContrasts": "Subtract methods within the same optimizer and simulation-seed block before resampling."}, "uncertainty": "With three optimizer repetitions and five simulation seed blocks, intervals are descriptive and do not establish statistical significance. Results are conditional on the shared selection-seed block.", "scope": protocol["inferenceScope"]}


def _optimization_job(engine: Engine, job: dict, protocol: dict, histories: list[dict]) -> list[tuple[dict, dict]]:
    if engine.runtime.identity() != protocol["simulator"] or implementation_hash() != protocol["implementationHash"]:
        raise ValueError("The scientific implementation changed during the experiment")
    identifier, scenario, method, seed, regime, scope = (job[k] for k in ("id", "scenario", "method", "seed", "regime", "scope"))
    study = _reuse_or_run(engine, identifier, scenario, engine.run_search, method=method, budget=protocol["onlineBudget"], batch_size=protocol["batchSize"], optimizer_seed=seed, simulation_seeds=protocol["selectionSeeds"], history_studies=histories if regime == "history" else [], record_trace=False, name=f"{regime.title()} · {scenario['id']} · {method} · seed {seed}", pool_size=protocol["poolSize"], epochs=protocol["epochs"])
    chosen = best_candidate(study)
    if chosen is None:
        raise RuntimeError(f"Optimization {identifier} has no completed candidate")
    final = _reuse_or_run(engine, identifier + "-final", scenario, engine.run_manual, mapping=chosen["mapping"], simulation_seeds=protocol["finalSeeds"], record_trace=False, name=f"Independent evaluation · {regime} · {method} · seed {seed}", source_study_id=study["id"], source_candidate_id=chosen["id"], purpose="final-holdout")
    common = {"regime": regime, "method": method, "optimizerSeed": seed}
    return [(study, {**common, "phase": "optimization" if scope == "core" else "cross-optimization"}), (final, {**common, "phase": "final" if scope == "core" else "cross-final", "sourceStudyId": study["id"], "sourceCandidateId": chosen["id"]})]


def _process_job(store_root: str, binary: str, job: dict, protocol: dict, history_ids: list[str]) -> list[tuple[dict, dict]]:
    from .runtime import Runtime
    store = Store(Path(store_root))
    engine = Engine(store, Runtime(store, Path(binary)))
    histories = [store.read("studies", identifier) for identifier in history_ids]
    return _optimization_job(engine, job, protocol, histories)


def include_reference(primary: dict, protocol: dict, reference: dict, reference_protocol: dict) -> dict:
    if reference["status"] != "completed":
        raise ValueError("The original reference experiment is incomplete")
    if reference["primaryProtocolHash"] != protocol["protocolHash"] or reference["protocolHash"] != reference_protocol["protocolHash"]:
        raise ValueError("The original reference belongs to a different primary protocol")
    if any(reference_protocol[key] != protocol[key] for key in
           ("implementationHash", "simulator", "testScenarios", "optimizerSeeds", "selectionSeeds", "finalSeeds", "onlineBudget", "horizon")):
        raise ValueError("The original reference does not share the primary comparison conditions")
    result = copy.deepcopy(primary)
    comparisons = []
    for scenario in protocol["testScenarios"]:
        right = {row["optimizerSeed"]: row for row in reference["finalResults"]
                 if row["scenarioId"] == scenario and row["status"] == "completed"}
        for method in ("spatial_aux", "simple", "ea"):
            left = {row["optimizerSeed"]: row for row in primary["finalResults"]
                    if row["scenarioId"] == scenario and row["regime"] == "cold"
                    and row["method"] == method and row["status"] == "completed"}
            differences = []
            for optimizer_seed in sorted(left.keys() & right.keys()):
                a, b = left[optimizer_seed]["bySimulationSeed"], right[optimizer_seed]["bySimulationSeed"]
                differences.append([a[str(seed)] - b[str(seed)] for seed in protocol["finalSeeds"]])
            if differences:
                comparisons.append({"contrast": "original-evolutionary-reference", "scenarioId": scenario,
                                    "regime": "cold", "target": method, "reference": "upstream_ea", "referenceRegime": "cold",
                                    **crossed_interval(differences, seed=protocol["bootstrapSeed"], samples=protocol["bootstrapSamples"])})
    result["originalEAReference"] = {**copy.deepcopy(reference), "pairedContrasts": comparisons,
                                    "costs": reference["totalCost"], "protocol": reference_protocol}
    result["supplementalCost"] = dict(reference["totalCost"])
    result["overallStudyCost"] = {key: primary["totalResearchCost"][key] + reference["totalCost"][key] for key in COST_KEYS}
    result["overallStudyCostScope"] = "Primary frozen protocol, its bound validation pilot, and the separate original reference; engineering checks are excluded."
    return result


def refresh_summary(engine: Engine, protocol: dict, manifest: dict, output: Path) -> dict:
    result = summarize(engine, protocol, manifest)
    reference_dir = Path(output) / "upstream-reference"
    if (reference_dir / "protocol.json").exists():
        reference_protocol = json.loads((reference_dir / "protocol.json").read_text())
        if (reference_dir / "summary.json").exists():
            reference = json.loads((reference_dir / "summary.json").read_text())
            result = include_reference(result, protocol, reference, reference_protocol)
        else:
            result["originalEAReference"] = {"status": "pending", "protocolHash": reference_protocol["protocolHash"]}
    _write(Path(output) / "summary.json", result)
    return result


def run_protocol(engine: Engine, protocol: dict, output: Path, *, phase: str = "all", workers: int = 1, on_progress=None) -> dict:
    output = Path(output)
    if digest({key: value for key, value in protocol.items() if key != "protocolHash"}) != protocol["protocolHash"]:
        raise ValueError("The frozen protocol content does not match its hash")
    if engine.runtime.identity() != protocol["simulator"] or implementation_hash() != protocol["implementationHash"]:
        raise ValueError("The simulator or implementation changed after the protocol was frozen")
    scenario_by_id = {s["id"]: {**s, "horizon": protocol["horizon"]} for s in scenarios()}
    path = output / "manifest.json"
    manifest = json.loads(path.read_text()) if path.exists() else {"schemaVersion": 1, "protocolHash": protocol["protocolHash"], "status": "running", "entries": []}
    if manifest["protocolHash"] != protocol["protocolHash"]:
        raise ValueError("Experiment directory belongs to a different protocol")
    if workers not in (1, 2):
        raise ValueError("Use one or two independent experiment workers")
    manifest["status"] = "running"
    if not (output / "environment.json").exists():
        _write(output / "environment.json", environment_record(engine, workers))
    prefix = "exp-" + protocol["protocolHash"][:8]

    def plan(identifier: str, scenario_id: str, **metadata) -> None:
        entry = {"studyId": identifier, "scenarioId": scenario_id, **metadata}
        if not any(e["studyId"] == identifier for e in manifest.setdefault("plannedStudies", [])):
            manifest["plannedStudies"].append(entry)
        _write(path, manifest)

    def record(study: dict, **metadata) -> None:
        entry = {"studyId": study["id"], "scenarioId": study["scenario"]["id"], **metadata}
        if not any(e["studyId"] == study["id"] for e in manifest["entries"]):
            manifest["entries"].append(entry)
        _write(path, manifest)
        if on_progress:
            on_progress(entry, study["costs"])

    histories = []
    for i, scenario_id in enumerate(protocol["trainScenarios"]):
        identifier = f"{prefix}-train-{i}"
        plan(identifier, scenario_id, phase="history-data", regime="training", method="random", optimizerSeed=7001 + i)
        if phase in ("all", "history"):
            study = _reuse_or_run(engine, identifier, scenario_by_id[scenario_id], engine.run_search, method="random", budget=protocol["historyBudgetPerScenario"], batch_size=protocol["batchSize"], optimizer_seed=7001 + i, simulation_seeds=protocol["historySeeds"], record_trace=False, name=f"Training conditions · {scenario_id}", pool_size=protocol["poolSize"], epochs=protocol["epochs"])
            record(study, phase="history-data", regime="training", method="random", optimizerSeed=7001 + i)
            histories.append(study)
        elif engine.store.path("studies", identifier).exists():
            study = engine.store.read("studies", identifier)
            if study["status"] != "completed":
                raise ValueError("Shared training history is incomplete")
            histories.append(study)
            record(study, phase="history-data", regime="training", method="random", optimizerSeed=7001 + i)
    if phase == "history":
        manifest["status"] = "partial"
        _write(path, manifest)
        _write(output / "summary.json", summarize(engine, protocol, manifest)); return manifest
    if len(histories) != len(protocol["trainScenarios"]):
        raise ValueError("Generate the shared training histories first")

    scopes = [("core", protocol["testScenarios"], protocol["methods"], protocol["learningMethods"])]
    if protocol.get("crossMapScenario"):
        scopes.append(("cross", [protocol["crossMapScenario"]], protocol["crossMapMethods"], protocol["crossMapMethods"]))
    jobs, references = [], []
    for scope, scenario_ids, cold_methods, history_methods in scopes:
        if phase not in ("all", scope):
            continue
        for scenario_id in scenario_ids:
            scenario = scenario_by_id[scenario_id]
            for regime, methods in (("cold", cold_methods), ("history", history_methods)):
                for method in methods:
                    for seed in protocol["optimizerSeeds"]:
                        identifier = f"{prefix}-{scope}-{scenario_id}-{regime}-{method}-{seed}"
                        jobs.append({"id": identifier, "scenario": scenario, "method": method, "seed": seed, "regime": regime, "scope": scope})
                        plan(identifier, scenario_id, phase="optimization" if scope == "core" else "cross-optimization", regime=regime, method=method, optimizerSeed=seed)
                        plan(identifier + "-final", scenario_id, phase="final" if scope == "core" else "cross-final", regime=regime, method=method, optimizerSeed=seed, sourceStudyId=identifier)
            for strategy in ("min_dist", "cluster"):
                references.append((scope, scenario, strategy))
                plan(f"{prefix}-{scope}-{scenario_id}-greedy-{strategy}", scenario_id, phase="greedy-final", regime="reference", method=strategy, optimizerSeed=None)
    if workers == 1:
        for job in jobs:
            for study, metadata in _optimization_job(engine, job, protocol, histories):
                record(study, **metadata)
    else:
        # Separate processes keep model initialization and optimizer RNGs independent.
        with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) as executor:
            futures = [executor.submit(_process_job, str(engine.store.root), str(engine.runtime.binary), job, protocol, [s["id"] for s in histories]) for job in jobs]
            for future in as_completed(futures):
                for study, metadata in future.result():
                    record(study, **metadata)
    for scope, scenario, strategy in references:
        greedy = _reuse_or_run(engine, f"{prefix}-{scope}-{scenario['id']}-greedy-{strategy}", scenario, engine.run_manual, mapping=greedy_mapping(scenario, strategy), simulation_seeds=protocol["finalSeeds"], record_trace=False, name=f"Independent greedy reference · {scenario['id']} · {strategy}", purpose="greedy-holdout")
        record(greedy, phase="greedy-final", regime="reference", method=strategy, optimizerSeed=None)
    manifest["status"] = "completed" if phase == "all" else "partial"
    _write(path, manifest)
    _write(output / "summary.json", summarize(engine, protocol, manifest))
    return manifest


def export_results(engine: Engine, output: Path, destination: Path) -> dict:
    output, destination = Path(output), Path(destination)
    protocol = json.loads((output / "protocol.json").read_text())
    manifest = json.loads((output / "manifest.json").read_text())
    summary = json.loads((output / "summary.json").read_text())
    if manifest["status"] != "completed" or summary["status"] != "completed":
        raise ValueError("Finish the frozen experiment before exporting final results")
    if manifest["protocolHash"] != protocol["protocolHash"] or summary["protocolHash"] != protocol["protocolHash"]:
        raise ValueError("Results do not belong to the same frozen protocol")
    if (destination / "manifest.json").exists() and json.loads((destination / "manifest.json").read_text())["protocolHash"] != protocol["protocolHash"]:
        raise ValueError("Export destination already contains a different protocol")
    supplemental_protocols, supplemental_entries = [], []
    reference_dir = output / "upstream-reference"
    if (reference_dir / "protocol.json").exists():
        reference_protocol = json.loads((reference_dir / "protocol.json").read_text())
        if not (reference_dir / "manifest.json").exists() or summary.get("originalEAReference", {}).get("status") != "completed":
            raise ValueError("Complete the original reference and refresh the combined summary before exporting")
        reference_manifest = json.loads((reference_dir / "manifest.json").read_text())
        if reference_manifest.get("status") != "completed" or reference_protocol["protocolHash"] != summary["originalEAReference"]["protocolHash"]:
            raise ValueError("The original reference manifest does not match the combined summary")
        supplement = {"name": "Original upstream reference", "protocol": reference_protocol, "manifest": reference_manifest}
        if (reference_dir / "environment.json").exists():
            supplement["environment"] = public_environment(json.loads((reference_dir / "environment.json").read_text()))
        supplemental_protocols.append(supplement)
        supplemental_entries = reference_manifest["entries"]
    identifiers = sorted({e["studyId"] for e in manifest["entries"] + supplemental_entries} | set(protocol["pilotStudyIds"]))
    studies = [engine.store.read("studies", identifier) for identifier in identifiers]
    if any(s["status"] != "completed" for s in studies):
        raise ValueError("Incomplete studies must remain in the local ledger until resolved")
    if any(s["simulator"] != protocol["simulator"] or s["implementationHash"] != protocol["implementationHash"] for s in studies):
        raise ValueError("Study versions do not match the frozen protocol")
    environment = json.loads((output / "environment.json").read_text())
    if environment["implementationHash"] != protocol["implementationHash"]:
        raise ValueError("The recorded execution environment used a different implementation")

    def public_record(value):
        if isinstance(value, dict):
            return {key: public_record(item) for key, item in value.items()
                    if key not in ("processId", "nativePath", "nativeDirectory", "nativeOutput", "stdout", "stderr", "logs", "log", "command")}
        if isinstance(value, list):
            return [public_record(item) for item in value]
        if isinstance(value, str):
            return value.replace(str(engine.store.root), "<data>").replace(str(ROOT), "<project>")
        return value

    destination.mkdir(parents=True, exist_ok=True)
    models = []
    for regime in ("cold", "history"):
        entry = next((e for e in manifest["entries"] if e["phase"] == "optimization"
                      and e["scenarioId"] == "sparse-600-721" and e["regime"] == regime
                      and e["method"] == "spatial_aux" and e["optimizerSeed"] == 7), None)
        if entry is None:
            raise ValueError("The representative spatial model study is missing")
        study = next(s for s in studies if s["id"] == entry["studyId"])
        filename = study["modelFile"]
        if Path(filename).name != filename:
            raise ValueError("Checkpoint filename must not contain a directory")
        source = engine.store.root / "models" / filename
        if hashlib.sha256(source.read_bytes()).hexdigest() != study["modelHash"]:
            raise ValueError("Checkpoint contents do not match the measured study")
        model_path = destination / "models" / filename
        model_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, model_path)
        models.append({"studyId": study["id"], "regime": regime, "file": f"models/{filename}",
                       "sha256": study["modelHash"], "trainingIds": study["search"]["fits"][-1]["trainingIds"]})
    for name in ("protocol.json", "summary.json"):
        shutil.copyfile(output / name, destination / name)
    _write(destination / "environment.json", public_environment(environment))
    observations = destination / "observations.jsonl.gz"
    with observations.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=6) as compressed:
            for study in studies:
                compressed.write((json.dumps(public_record(study), separators=(",", ":"), sort_keys=True, allow_nan=False) + "\n").encode())
    exported = {**public_record(manifest), "supplementalProtocols": supplemental_protocols, "observationArchive": {"file": observations.name,
                "sha256": hashlib.sha256(observations.read_bytes()).hexdigest(), "studies": len(studies),
                "includes": "All primary and supplemental protocol studies and the validation pilot; full measured evaluations and frozen predictions, without large playback traces."},
                "modelArtifacts": models, "modelScope": "Two representative final checkpoints are included. Other checkpoints remain local and can be regenerated with the frozen protocol."}
    _write(destination / "manifest.json", exported)
    return {"studies": len(studies), "checkpoints": len(models), "archiveBytes": observations.stat().st_size}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run native mapping optimization comparisons")
    parser.add_argument("command", choices=("pilot", "freeze", "run", "summary", "export"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--horizon", type=int, default=1500)
    parser.add_argument("--cross-map", action="store_true")
    parser.add_argument("--phase", choices=("all", "history", "core", "cross"), default="all")
    parser.add_argument("--workers", type=int, choices=(1, 2), default=1)
    parser.add_argument("--destination", type=Path, default=ROOT / "results/tmo")
    args = parser.parse_args()
    engine = Engine(Store())
    output = args.output or engine.store.root / "experiment"
    if args.command == "pilot":
        result = run_pilot(engine, output, horizon=args.horizon)
        print(json.dumps({"status": result["status"], "costs": result["costs"], "events": result["events"], "modelTiming": result["modelTiming"]}))
    elif args.command == "freeze":
        protocol = freeze_protocol(json.loads((output / "pilot.json").read_text()), output, cross_map=args.cross_map)
        print(json.dumps({"protocolHash": protocol["protocolHash"], "plannedCalls": protocol["plannedCalls"], "estimatedNativeSeconds": protocol["estimatedNativeSeconds"]}))
    else:
        protocol = json.loads((output / "protocol.json").read_text())
        if args.command == "run":
            def progress(entry, costs):
                print(json.dumps({"study": entry["studyId"], "phase": entry["phase"], "calls": costs["started"], "simulationSeconds": costs["simulationSeconds"], "trainingSeconds": costs["trainingSeconds"]}), flush=True)
            run_protocol(engine, protocol, output, phase=args.phase, workers=args.workers, on_progress=progress)
        elif args.command == "summary":
            manifest = json.loads((output / "manifest.json").read_text())
            refresh_summary(engine, protocol, manifest, output)
        else:
            print(json.dumps(export_results(engine, output, args.destination)))


if __name__ == "__main__":
    main()
