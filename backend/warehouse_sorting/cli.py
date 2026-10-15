from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path

from .config import ROOT, scenarios
from .engine import Engine
from .store import Store


def published_record(value):
    if isinstance(value, dict):
        return {key: published_record(item) for key, item in value.items()
                if key not in ("processId", "nativePath", "nativeDirectory", "nativeOutput",
                               "stdout", "stderr", "logs", "log", "command")}
    if isinstance(value, list):
        return [published_record(item) for item in value]
    return value


def export_studies(store: Store, identifiers: list[str], target: Path, default_id: str | None = None):
    target.mkdir(parents=True, exist_ok=True)
    (target / "studies").mkdir(exist_ok=True)
    (target / "traces").mkdir(exist_ok=True)
    summaries, selected_scenarios = [], {}
    for identifier in identifiers:
        study = published_record(store.read("studies", identifier))
        selected_scenarios[study["scenario"]["id"]] = study["scenario"]
        measured = [c for c in study["candidates"] if c["throughput"] is not None]
        best = max(measured, key=lambda c: c["throughput"], default=None)
        replay_candidates = {c["id"] for c in ([measured[0], best] if measured else [])}
        for candidate in study["candidates"]:
            for index, evaluation in enumerate(candidate["evaluations"]):
                if evaluation.get("traceUrl") and candidate["id"] in replay_candidates and index == 0:
                    source_id = evaluation.get("cacheOf") or evaluation["id"]
                    trace = store.read_trace(source_id)
                    filename = source_id + ".json.gz"
                    with gzip.open(target / "traces" / filename, "wt", compresslevel=9) as output:
                        json.dump(trace, output, separators=(",", ":"), allow_nan=False)
                    evaluation["traceUrl"] = "sorting/traces/" + filename
                else:
                    evaluation["traceUrl"] = None
        (target / "studies" / f"{identifier}.json").write_text(json.dumps(study, separators=(",", ":"), allow_nan=False))
        summaries.append({"id": identifier, "name": study["name"], "scenarioId": study["scenario"]["id"],
                          "method": study["method"], "regime": study["regime"], "status": study["status"],
                          "bestThroughput": max((c["throughput"] for c in study["candidates"] if c["throughput"] is not None), default=None)})
    catalog = {"schemaVersion": 1, "scenarios": scenarios(), "studies": summaries,
               "defaultStudyId": default_id or (identifiers[0] if identifiers else None)}
    if (target / "results.json").exists():
        catalog["resultsUrl"] = "sorting/results.json"
    (target / "catalog.json").write_text(json.dumps(catalog, separators=(",", ":"), allow_nan=False))
    print(json.dumps({"studies": len(summaries), "destination": str(target)}))


def main():
    parser = argparse.ArgumentParser(description="WarehouseLab sorting simulation and search")
    parser.add_argument("--data", type=Path, help="Local scientific records and model directory")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Serve the production interface and real native evaluations")
    serve.add_argument("--port", type=int, default=8000)
    search = commands.add_parser("search", help="Run a budgeted optimization from the initial simulation state")
    search.add_argument("--scenario", default="sparse-600-721")
    search.add_argument("--method", default="spatial_aux")
    search.add_argument("--budget", type=int, default=24)
    search.add_argument("--batch-size", type=int, default=3)
    search.add_argument("--optimizer-seed", type=int, default=7)
    search.add_argument("--seeds", type=int, nargs="+", default=[11, 29])
    search.add_argument("--trace", action="store_true")
    search.add_argument("--id")
    export = commands.add_parser("export", help="Export selected measured records for the static browser")
    export.add_argument("studies", nargs="+")
    export.add_argument("--output", type=Path, default=ROOT / "public/sorting")
    export.add_argument("--default")
    args = parser.parse_args()
    store = Store(args.data)
    if args.command == "serve":
        import uvicorn
        from .api import create_app
        uvicorn.run(create_app(store), host="127.0.0.1", port=args.port, access_log=False)
    elif args.command == "search":
        scenario = next((s for s in scenarios() if s["id"] == args.scenario), None)
        if scenario is None:
            parser.error("Unknown scenario")
        result = Engine(store).run_search(scenario, method=args.method, budget=args.budget,
                                          batch_size=args.batch_size, optimizer_seed=args.optimizer_seed,
                                          simulation_seeds=args.seeds, record_trace=args.trace, study_id=args.id)
        print(json.dumps({"id": result["id"], "status": result["status"], "costs": result["costs"]}))
    elif args.command == "export":
        export_studies(store, args.studies, args.output, args.default)


if __name__ == "__main__":
    main()
