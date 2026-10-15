"""Pinned TMO evolutionary proposals under the shared simulation budget."""
from __future__ import annotations

import argparse
import ast
import contextlib
import copy
import hashlib
import io
import json
from pathlib import Path
from queue import Queue
import subprocess
import tempfile
import time
from types import SimpleNamespace

import numpy as np

from .config import digest, scenarios, source_dir, validate_mapping
from .engine import Engine, aggregate
from .experiments import _write, best_candidate, crossed_interval, implementation_hash, total_cost
from .features import normalize_scenario
from .mapping import repair_mapping
from .runtime import UPSTREAM
from .search import SearchSession
from .store import Store

EMITTER = "env_search/emitters/map_elites_baseline_emitter.py"
GREEDY = "env_search/analysis/gen_heuristic_chute_mapping.py"
UTILS = "env_search/utils/__init__.py"
MODULE = "env_search/warehouse/module.py"
SOURCE_FILES = (EMITTER, GREEDY, UTILS, MODULE,
                "env_search/warehouse/milp_chute_cplex.py",
                "env_search/schedulers/scheduler.py",
                "config/Genetic_Algo_Plus_600_agents_sortation-33-57-105-chutes_sim-5000.gin")


def adapter_hash() -> str:
    return hashlib.sha256(Path(__file__).read_bytes()).hexdigest()


def _pinned_text(path: str) -> str:
    result = subprocess.run(["git", "show", f"{UPSTREAM}:{path}"], cwd=source_dir(),
                            check=True, capture_output=True, text=True)
    return result.stdout


def source_identity() -> dict:
    return {"upstreamRevision": UPSTREAM, "adapterHash": adapter_hash(),
            "sourceFiles": [{"path": path, "sha256": hashlib.sha256(_pinned_text(path).encode()).hexdigest()}
                            for path in SOURCE_FILES]}


def _functions(path: str, names: tuple[str, ...], namespace: dict, *, class_name: str | None = None) -> None:
    tree = ast.parse(_pinned_text(path), filename=path)
    body = tree.body
    if class_name:
        body = next(node.body for node in body if isinstance(node, ast.ClassDef) and node.name == class_name)
    selected = [node for node in body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != set(names):
        raise ValueError("Pinned upstream functions are missing")
    # Execute the original bodies without importing unrelated experiment infrastructure.
    exec(compile(ast.Module(body=selected, type_ignores=[]), path, "exec"), namespace)


def upstream_functions() -> dict:
    namespace = {"np": np, "copy": copy, "json": json, "Queue": Queue, "Dict": dict,
                 "tqdm": lambda values: values}
    utilities = ast.parse(_pinned_text(UTILS))
    for node in utilities.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            name = node.targets[0].id
            if name in ("DIRS", "sortation_obj_types"):
                namespace[name] = ast.literal_eval(node.value)
    _functions(UTILS, ("env_str2number", "sortation_env_str2number", "get_tile_loc", "get_chute_loc",
                       "get_workstation_loc", "chute_mapping_to_array"), namespace)
    _functions(MODULE, ("BFS_path_len_one_goal",), namespace)
    _functions(GREEDY, ("compute_avg_dist", "gen_heuristic_chute_mapping"), namespace)
    _functions(EMITTER, ("ask", "sample_k"), namespace, class_name="MapElitesBaselineChuteMappingEmitter")
    return namespace


class SingleElite:
    """The upstream [1, 1] grid: strict improvement, first batch maximum wins ties."""
    def __init__(self):
        self.raw = self.repaired = self.candidate_id = None
        self.objective = -np.inf

    def add_batch(self, candidates: list[dict]) -> None:
        eligible = [candidate for candidate in candidates
                    if candidate["status"] == "completed" and candidate.get("throughput") is not None]
        if not eligible:
            return
        best = max(eligible, key=lambda candidate: candidate["throughput"])
        if best["throughput"] > self.objective:
            self.raw = np.asarray(best["rawIndices"], dtype=int)
            self.repaired = list(best["mapping"])
            self.candidate_id, self.objective = best["id"], best["throughput"]

    def sample_elites(self, count: int):
        if self.raw is None:
            raise ValueError("The upstream archive has no successful initial evaluation")
        # The emitter's repaired-parent metadata is only relevant to layout repair.
        return SimpleNamespace(solution_batch=np.tile(self.raw, (count, 1)), metadata_batch=[None] * count)


def original_greedy(scenario: dict, strategy: str) -> list[str]:
    if strategy not in ("min_dist", "cluster"):
        raise ValueError("Unknown upstream greedy strategy")
    namespace = upstream_functions()
    normalized = normalize_scenario(scenario)
    ids = [destination["id"] for destination in normalized["destinations"]]
    weights = np.asarray([destination["weight"] for destination in normalized["destinations"]])
    floor = namespace["sortation_env_str2number"](scenario["map"]["layout"])
    with tempfile.TemporaryDirectory(prefix="sorting-greedy-") as temporary:
        name = str(Path(temporary) / "mapping")
        with contextlib.redirect_stdout(io.StringIO()):
            namespace["gen_heuristic_chute_mapping"](floor, name, weights, len(ids), algo=strategy)
        raw = json.loads(Path(f"{name}_heuristic_baseline_algo={strategy}.json").read_text())
    indices = namespace["chute_mapping_to_array"](raw, namespace["get_chute_loc"](floor))
    result = [ids[int(i)] for i in indices]
    validate_mapping(scenario, result)
    return result


def run_upstream_ea(engine: Engine, scenario: dict, *, optimizer_seed: int,
                    simulation_seeds: list[int], budget: int = 24, batch_size: int = 3,
                    study_id: str | None = None, record_trace: bool = False) -> dict:
    start = time.perf_counter()
    if not simulation_seeds or type(optimizer_seed) is not int or not 0 <= optimizer_seed <= 4294967295:
        raise ValueError("Use simulation seeds and an unsigned 32-bit optimizer seed")
    candidate_budget = budget // len(simulation_seeds)
    if candidate_budget < 4:
        raise ValueError("The matched upstream reference needs four initial mappings")
    initialized = SearchSession(scenario, method="ea", seed=optimizer_seed, budget=candidate_budget,
                                batch_size=batch_size)
    initial = copy.deepcopy(initialized.initial)
    if len(initial) != 4:
        raise ValueError("The matched upstream reference requires four distinct initial mappings")
    study = engine._create(scenario, "manual", budget, batch_size, optimizer_seed, simulation_seeds,
                           [], f"Upstream EA · {scenario['id']} · seed {optimizer_seed}",
                           study_id, record_trace, "cold-start")
    study.update(method="upstream_ea", baseline=source_identity(),
                 searchConfig={"initialSize": 4, "batchSize": batch_size,
                               "parentRepresentation": "unrepaired", "sharedMutationSize": True,
                               "repeatPolicy": "Every repeated proposal executes both seeds again; no cache reuse",
                               "repair": "Exact minimum Hamming edits; deterministic row-major tie selection"})
    archive = SingleElite()
    namespace = upstream_functions()
    emitter_class = type("PinnedEmitter", (), {name: namespace[name] for name in ("ask", "sample_k")})
    emitter = emitter_class()
    emitter.rng, emitter.archive = np.random.default_rng(optimizer_seed), archive
    emitter.initial_population = emitter.batch_size = 4
    emitter.solution_dim = len(scenario["map"]["chutes"])
    emitter.num_objects, emitter.geometric_k, emitter.mutation_k = len(scenario["destinations"]), True, 10
    emitter.sols_emitted = 0
    emitter.chute_locs = np.asarray([chute["cell"] for chute in scenario["map"]["chutes"]])
    ids = [destination["id"] for destination in scenario["destinations"]]
    lookup = {identifier: i for i, identifier in enumerate(ids)}
    try:
        with tempfile.TemporaryDirectory(prefix="sorting-initial-") as temporary:
            emitter.initial_chute_mappings = []
            for i, candidate in enumerate(initial):
                mapping = {str(d): [int(cell) for cell, identifier in zip(emitter.chute_locs, candidate["mapping"])
                                   if lookup[identifier] == d] for d in range(len(ids))}
                path = Path(temporary) / f"initial-{i}.json"
                path.write_text(json.dumps(mapping))
                emitter.initial_chute_mappings.append(str(path))
            round_number = 0
            while len(study["candidates"]) < candidate_budget:
                selection_start = time.perf_counter()
                raw_batch, _ = emitter.ask()
                parent_id, parent_mapping = archive.candidate_id, archive.repaired
                round_number += 1
                candidates = []
                for raw_indices in raw_batch:
                    raw_mapping = [ids[int(i)] for i in raw_indices]
                    mapping = repair_mapping(scenario, raw_mapping)
                    validate_mapping(scenario, mapping)
                    prior = next((c["id"] for c in study["candidates"] + candidates if c["mapping"] == mapping), None)
                    number = len(study["candidates"]) + len(candidates) + 1
                    candidates.append({"id": f"c{number:04d}", "mapping": mapping, "rawMapping": raw_mapping,
                                       "rawIndices": [int(i) for i in raw_indices], "parentId": parent_id,
                                       "operation": initial[number - 1]["operation"] if round_number == 1 else "upstream-geometric",
                                       "changedChutes": [i for i, d in enumerate(mapping) if parent_mapping is not None and d != parent_mapping[i]],
                                       "repairChanges": [i for i, (raw, fixed) in enumerate(zip(raw_mapping, mapping)) if raw != fixed],
                                       "duplicateOf": prior, "round": round_number, "status": "pending", "prediction": None,
                                       "evaluations": [], "throughput": None, "calls": study["costs"]["started"]})
                study["costs"]["selectionSeconds"] += time.perf_counter() - selection_start
                study["candidates"].extend(candidates)
                engine.store.write("studies", study["id"], study)
                for candidate in candidates:
                    candidate["status"] = "running"
                    for seed in simulation_seeds:
                        candidate["activeSeed"] = seed
                        engine.store.write("studies", study["id"], study)
                        evaluation = engine.runtime.evaluate(scenario, candidate["mapping"], seed,
                                     study_id=study["id"], candidate_id=candidate["id"], purpose="selection",
                                     record_trace=record_trace, force=True)
                        engine._record(study, candidate, evaluation)
                    candidate.pop("activeSeed", None)
                    candidate.update(aggregate(candidate["evaluations"]))
                    engine.store.write("studies", study["id"], study)
                archive.add_batch(candidates)
                emitter.batch_size = min(batch_size, candidate_budget - len(study["candidates"]))
            study["status"] = "completed"
            study["search"] = {"attempts": len(study["candidates"]), "finished": True,
                               "archiveCandidateId": archive.candidate_id,
                               "duplicateEvaluations": sum(c["duplicateOf"] is not None for c in study["candidates"])}
    except Exception as error:
        study.update(status="failed", error=str(error))
        raise
    finally:
        study["wallSeconds"] = time.perf_counter() - start
        engine.store.write("studies", study["id"], study)
    return study


def freeze_reference(engine: Engine, primary: dict, output: Path) -> dict:
    if primary["implementationHash"] != implementation_hash() or primary["simulator"] != engine.runtime.identity():
        raise ValueError("The primary experiment implementation changed")
    protocol = {"schemaVersion": 1, "primaryProtocolHash": primary["protocolHash"],
                "implementationHash": primary["implementationHash"], "simulator": primary["simulator"],
                "baseline": source_identity(), "testScenarios": primary["testScenarios"],
                "optimizerSeeds": primary["optimizerSeeds"], "selectionSeeds": primary["selectionSeeds"],
                "finalSeeds": primary["finalSeeds"], "onlineBudget": primary["onlineBudget"],
                "batchSize": primary["batchSize"], "horizon": primary["horizon"],
                "initialSize": 4, "methods": ["upstream_ea"],
                "greedyMethods": ["upstream_min_dist", "upstream_cluster"],
                "initialization": "Same four legal mappings as every primary method; all are evaluated and charged",
                "emitter": "Execute pinned original ask/sample_k; one mutation size per batch; mutate the raw archive genotype",
                "archive": "One-cell elitist archive; strict improvement and first maximum in batch wins ties, as pyribs 0.5.0",
                "repair": "Same minimum Hamming objective and quota constraints; deterministic row-major optimal ties replace CPLEX ties",
                "duplicates": "Retain original duplicate proposals and execute every replicate; no cached calls count as evaluations",
                "differencesFromPaper": "Shared initial size 4 and lambda 3, project demand conditions, corrected native runtime, 1500 ticks, parcel objective, two selection seeds and independent final evaluation; no numerical paper reproduction",
                "greedyInput": "Pinned original greedy function uses normalized project demand weights; no stored author mappings",
                "uncertainty": "Crossed bootstrap resamples optimizer rows and shared simulation-seed columns independently; descriptive only",
                "decisionRule": "Supplement added to verify source-level baseline correspondence; no parameter tuning from final outcomes"}
    n, repeats, final = len(protocol["testScenarios"]), len(protocol["optimizerSeeds"]), len(protocol["finalSeeds"])
    protocol["plannedCalls"] = {"optimization": n * repeats * protocol["onlineBudget"],
                                "finalEvaluation": n * repeats * final, "greedyEvaluation": n * 2 * final}
    protocol["plannedCalls"]["total"] = sum(protocol["plannedCalls"].values())
    protocol["protocolHash"] = digest(protocol)
    path = Path(output) / "protocol.json"
    if path.exists():
        saved = json.loads(path.read_text())
        if saved != protocol:
            raise ValueError("A different upstream reference protocol already exists")
        return saved
    _write(path, protocol)
    return protocol


def run_reference(engine: Engine, protocol: dict, output: Path, on_progress=None) -> dict:
    if digest({k: v for k, v in protocol.items() if k != "protocolHash"}) != protocol["protocolHash"]:
        raise ValueError("Reference protocol content does not match its hash")
    if protocol["baseline"] != source_identity() or protocol["implementationHash"] != implementation_hash() or protocol["simulator"] != engine.runtime.identity():
        raise ValueError("The frozen upstream reference implementation changed")
    output = Path(output)
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"schemaVersion": 1, "protocolHash": protocol["protocolHash"], "entries": []}
    if manifest["protocolHash"] != protocol["protocolHash"]:
        raise ValueError("Reference results belong to a different protocol")
    manifest["status"] = "running"
    _write(manifest_path, manifest)
    scenario_by_id = {s["id"]: {**s, "horizon": protocol["horizon"]} for s in scenarios()}
    prefix = "ref-" + protocol["protocolHash"][:8]

    def measure(identifier, scenario, function, metadata, **kwargs):
        if engine.store.path("studies", identifier).exists():
            study = engine.store.read("studies", identifier)
            if (study["status"] != "completed" or study.get("baseline") != protocol["baseline"]
                    or study["implementationHash"] != protocol["implementationHash"]
                    or study["simulator"] != protocol["simulator"] or digest(study["scenario"]) != digest(scenario)):
                raise ValueError("Existing reference study is incomplete or uses different provenance")
        else:
            study = function(engine, scenario, study_id=identifier, **kwargs) if function == run_upstream_ea else function(scenario, study_id=identifier, **kwargs)
            study["baseline"] = protocol["baseline"]
            engine.store.write("studies", identifier, study)
        entry = {"studyId": identifier, "scenarioId": scenario["id"], **metadata}
        if not any(e["studyId"] == identifier for e in manifest["entries"]):
            manifest["entries"].append(entry)
        _write(manifest_path, manifest)
        if on_progress:
            on_progress(entry, study["costs"])
        return study

    for scenario_id in protocol["testScenarios"]:
        scenario = scenario_by_id[scenario_id]
        for seed in protocol["optimizerSeeds"]:
            identifier = f"{prefix}-{scenario_id}-{seed}"
            common = {"method": "upstream_ea", "optimizerSeed": seed, "regime": "cold"}
            study = measure(identifier, scenario, run_upstream_ea, {**common, "phase": "optimization"},
                            optimizer_seed=seed, simulation_seeds=protocol["selectionSeeds"],
                            budget=protocol["onlineBudget"], batch_size=protocol["batchSize"])
            chosen = best_candidate(study)
            if chosen is None:
                raise ValueError("Upstream reference has no successful candidate")
            measure(identifier + "-final", scenario, engine.run_manual,
                    {**common, "phase": "final", "sourceStudyId": identifier, "sourceCandidateId": chosen["id"]},
                    mapping=chosen["mapping"], simulation_seeds=protocol["finalSeeds"], record_trace=False,
                    source_study_id=identifier, source_candidate_id=chosen["id"], purpose="final-holdout",
                    name=f"Independent evaluation · upstream EA · seed {seed}")
        for strategy in ("min_dist", "cluster"):
            measure(f"{prefix}-{scenario_id}-{strategy}", scenario, engine.run_manual,
                    {"phase": "greedy-final", "method": "upstream_" + strategy, "optimizerSeed": None, "regime": "reference"},
                    mapping=original_greedy(scenario, strategy), simulation_seeds=protocol["finalSeeds"], record_trace=False,
                    purpose="greedy-holdout", name=f"Original greedy · {scenario_id} · {strategy}")
    studies = {entry["studyId"]: engine.store.read("studies", entry["studyId"]) for entry in manifest["entries"]}
    rows = []
    for entry in manifest["entries"]:
        if entry["phase"] not in ("final", "greedy-final"):
            continue
        study = studies[entry["studyId"]]
        candidate = best_candidate(study)
        rows.append({**entry, "status": study["status"], "throughput": candidate["throughput"] if candidate else None,
                     "bySimulationSeed": {str(e["simulationSeed"]): e["metrics"]["throughput"]
                                          for e in candidate["evaluations"]} if candidate else {}, "costs": study["costs"]})
    groups = [{"scenarioId": identifier, "regime": "cold", "method": "upstream_ea",
               **crossed_interval([list(r["bySimulationSeed"].values()) for r in rows
                    if r["scenarioId"] == identifier and r["phase"] == "final" and r["status"] == "completed"])}
              for identifier in protocol["testScenarios"]]
    manifest["status"] = "completed"
    summary = {"schemaVersion": 1, "status": "completed", "protocolHash": protocol["protocolHash"],
               "primaryProtocolHash": protocol["primaryProtocolHash"], "baseline": protocol["baseline"],
               "finalResults": [r for r in rows if r["phase"] == "final"],
               "greedyReferences": [r for r in rows if r["phase"] == "greedy-final"], "groups": groups,
               "totalCost": total_cost(list(studies.values())),
               "costsByPhase": {phase: total_cost([studies[e["studyId"]] for e in manifest["entries"] if e["phase"] == phase])
                                for phase in ("optimization", "final", "greedy-final")}}
    _write(manifest_path, manifest)
    _write(output / "summary.json", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("freeze", "run"))
    parser.add_argument("--experiment", type=Path)
    args = parser.parse_args()
    store = Store()
    experiment = args.experiment or store.root / "experiment"
    output = experiment / "upstream-reference"
    engine = Engine(store)
    if args.command == "freeze":
        primary = json.loads((experiment / "protocol.json").read_text())
        result = freeze_reference(engine, primary, output)
        print(json.dumps({"protocolHash": result["protocolHash"], "plannedCalls": result["plannedCalls"]}))
    else:
        protocol = json.loads((output / "protocol.json").read_text())
        result = run_reference(engine, protocol, output, lambda entry, costs: print(json.dumps({**entry, "calls": costs["started"]}), flush=True))
        print(json.dumps({"status": result["status"], "costs": result["totalCost"]}))


if __name__ == "__main__":
    main()
