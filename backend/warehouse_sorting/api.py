from __future__ import annotations

import copy
import asyncio
import json
import os
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .config import ROOT, scenarios, validate_mapping, validate_scenario
from .engine import Engine
from .search import METHODS
from .store import Store

Seed = Annotated[int, Field(strict=True, ge=0, le=4294967295)]
Identifier = Annotated[str, Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_-]+$")]


class EvaluationRequest(BaseModel):
    scenarioId: Identifier
    mapping: list[Identifier] = Field(min_length=1, max_length=10000)
    simulationSeeds: list[Seed] = Field(default_factory=lambda: [101, 211], min_length=1, max_length=10)
    horizon: int = Field(default=1500, strict=True, ge=1, le=10000)
    sourceStudyId: Identifier | None = None
    sourceCandidateId: Identifier | None = None


class SearchRequest(BaseModel):
    scenarioId: Identifier
    method: str = "spatial_aux"
    budget: int = Field(default=24, strict=True, ge=1, le=200)
    batchSize: int = Field(default=3, strict=True, ge=1, le=10)
    optimizerSeed: Seed = 7
    simulationSeeds: list[Seed] = Field(default_factory=lambda: [11, 29], min_length=1, max_length=10)
    regime: str = "cold-start"
    historyStudyIds: list[Identifier] = Field(default_factory=list, max_length=20)


def recover_interrupted(store: Store) -> None:
    """Preserve completed measurements when their coordinating process has exited."""
    for study in store.studies():
        if study["status"] != "running":
            continue
        process_id = study.get("processId")
        if type(process_id) is int and process_id > 0:
            try:
                os.kill(process_id, 0)
                continue
            except PermissionError:
                continue
            except ProcessLookupError:
                pass
        saved = {e["id"]: e for candidate in study["candidates"] for e in candidate["evaluations"]}
        for path in (store.root / "evaluations").glob("*.json"):
            evaluation = json.loads(path.read_text())
            if evaluation.get("studyId") == study["id"]:
                saved[evaluation["id"]] = evaluation
        records = list(saved.values())
        for evaluation in records:
            if evaluation["status"] == "running":
                evaluation.update(status="interrupted", error="The coordinating process exited before the result was saved")
                store.write("evaluations", evaluation["id"], evaluation)
        for candidate in study["candidates"]:
            candidate["evaluations"] = [e for e in records if e["candidateId"] == candidate["id"]]
            candidate.pop("activeSeed", None)
            if candidate["status"] in ("running", "pending"):
                candidate.update(status="interrupted", throughput=None)
        costs = study["costs"]
        executed = [e for e in records if not e.get("cacheOf")]
        costs.update(started=sum(bool(e.get("started")) for e in executed),
                     completed=sum(e["status"] == "completed" for e in executed),
                     failed=sum(e["status"] == "failed" for e in executed),
                     interrupted=sum(e["status"] == "interrupted" for e in executed),
                     cacheHits=len(records) - len(executed),
                     executedTicks=sum(e.get("executedTicks") or 0 for e in executed),
                     unknownExecutedTickRuns=sum(e.get("executedTicks") is None for e in executed),
                     simulationSeconds=sum(e.get("wallSeconds", 0.) for e in executed),
                     replicates=sum(max(0, sum(not e.get("cacheOf") for e in c["evaluations"]) - 1)
                                    for c in study["candidates"]))
        study.update(status="interrupted", costsComplete=False,
                     error="The coordinating process exited; unfinished durations and results are unknown")
        store.write("studies", study["id"], study)


def create_app(store: Store | None = None, engine: Engine | None = None, scenario_list=None,
               static_dir: Path | None = None) -> FastAPI:
    store = store or Store()
    engine = engine or Engine(store)
    static_dir = Path(static_dir or ROOT / "dist")
    recover_interrupted(store)
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="simulation")
    jobs, events = {}, {}
    lock = threading.RLock()

    @asynccontextmanager
    async def lifespan(app):
        yield
        with lock:
            for event in events.values():
                event.set()
        await asyncio.to_thread(pool.shutdown, wait=True)

    app = FastAPI(title="WarehouseLab", docs_url=None, redoc_url=None, lifespan=lifespan)
    try:
        available_scenarios = scenario_list if scenario_list is not None else scenarios()
    except (FileNotFoundError, ValueError):
        available_scenarios = []
    public = ROOT / "public/sorting"
    if not available_scenarios and (public / "catalog.json").exists():
        available_scenarios = json.loads((public / "catalog.json").read_text())["scenarios"]

    @app.middleware("http")
    async def local_mutations(request: Request, call_next):
        if request.url.hostname not in ("127.0.0.1", "localhost", "::1"):
            return JSONResponse({"detail": "Use the loopback application address"}, status_code=400)
        # The local service has no authentication; browser mutations must be same-origin.
        if request.method == "POST":
            origin = request.headers.get("origin")
            expected = f"{request.url.scheme}://{request.headers.get('host')}"
            if origin and origin != expected:
                return JSONResponse({"detail": "Use the same-origin local application"}, status_code=403)
        return await call_next(request)

    def read_study(identifier):
        try:
            return store.read("studies", identifier)
        except FileNotFoundError:
            path = public / "studies" / store.path("studies", identifier).name
            if not path.exists():
                raise HTTPException(404, "Study not found")
            return json.loads(path.read_text())
        except ValueError as error:
            raise HTTPException(400, str(error))

    def get_scenario(identifier):
        scenario = next((s for s in available_scenarios if s["id"] == identifier), None)
        if scenario is None:
            raise HTTPException(404, "Scenario not found")
        return copy.deepcopy(scenario)

    def validate_seeds(seeds):
        if len(set(seeds)) != len(seeds) or any(not 0 <= s <= 4294967295 for s in seeds):
            raise HTTPException(422, "Use distinct unsigned 32-bit simulation seeds")

    def submit(function, kwargs):
        if not engine.runtime.identity()["ready"]:
            raise HTTPException(503, "Build the native simulator before evaluating")
        with lock:
            if any(j["status"] in ("queued", "running", "cancelling") for j in jobs.values()):
                raise HTTPException(409, "An evaluation is already running; wait or cancel it first")
            job_id, study_id = store.new_id("job"), store.new_id("study")
            event = threading.Event()
            events[job_id] = event
            jobs[job_id] = {"id": job_id, "studyId": study_id, "status": "queued", "progress": None}

        def update(study):
            with lock:
                jobs[job_id]["progress"] = copy.deepcopy(study["costs"])

        def execute():
            with lock:
                jobs[job_id]["status"] = "running"
            try:
                study = function(**kwargs, study_id=study_id, cancelled=event.is_set, on_update=update)
                with lock:
                    jobs[job_id]["status"] = study["status"]
            except Exception as error:
                with lock:
                    jobs[job_id].update(status="failed", error=str(error))

        pool.submit(execute)
        return {"jobId": job_id, "studyId": study_id}

    @app.get("/api/sorting/status")
    def status():
        return {"available": True, "simulator": engine.runtime.identity()}

    @app.get("/api/sorting/catalog")
    def catalog():
        local = store.catalog(available_scenarios)
        if (public / "catalog.json").exists():
            published = json.loads((public / "catalog.json").read_text())
            ids = {s["id"] for s in local["studies"]}
            local["studies"] = [s for s in published["studies"] if s["id"] not in ids] + local["studies"]
            local["defaultStudyId"] = published.get("defaultStudyId") or local["defaultStudyId"]
            if published.get("resultsUrl"):
                local["resultsUrl"] = published["resultsUrl"]
        return local

    @app.get("/api/sorting/studies/{identifier}")
    def study(identifier: str):
        return read_study(identifier)

    @app.get("/api/sorting/evaluations/{identifier}/trace")
    def trace(identifier: str):
        try:
            return store.read_trace(identifier)
        except (FileNotFoundError, ValueError):
            raise HTTPException(404, "Trace not found")

    @app.post("/api/sorting/evaluate")
    def evaluate(request: EvaluationRequest):
        scenario = get_scenario(request.scenarioId)
        scenario["horizon"] = request.horizon
        validate_seeds(request.simulationSeeds)
        source_candidate = None
        if request.sourceCandidateId and not request.sourceStudyId:
            raise HTTPException(422, "A source candidate requires its study identifier")
        if request.sourceStudyId:
            source = read_study(request.sourceStudyId)
            if request.sourceCandidateId and not any(c["id"] == request.sourceCandidateId for c in source["candidates"]):
                raise HTTPException(422, "Source candidate does not belong to this study")
            source_candidate = next((c for c in source["candidates"] if c["id"] == request.sourceCandidateId), None)
            if any(source["scenario"]["map"][key] != scenario["map"][key]
                   for key in ("width", "height", "layout", "chutes")):
                raise HTTPException(422, "A fixed mapping test requires the same chute geometry")
            if source["scenario"]["id"] != scenario["id"] or source["scenario"].get("constraintMode") == "fixed-mapping":
                try:
                    validate_mapping(source["scenario"], request.mapping)
                except ValueError as error:
                    raise HTTPException(422, str(error))
                counts = Counter(request.mapping)
                scenario["constraintMode"] = "fixed-mapping"
                scenario["originalSearchQuotas"] = {d["id"]: d["maxChutes"] for d in scenario["destinations"]}
                for destination in scenario["destinations"]:
                    destination["maxChutes"] = max(destination["maxChutes"], counts[destination["id"]])
        try:
            validate_scenario(scenario)
            validate_mapping(scenario, request.mapping)
        except ValueError as error:
            raise HTTPException(422, str(error))
        def run_evaluation(**kwargs):
            notify = kwargs.pop("on_update")

            def annotate(study):
                if source_candidate is not None and study["candidates"]:
                    candidate = study["candidates"][0]
                    changed = [i for i, value in enumerate(candidate["mapping"]) if value != source_candidate["mapping"][i]]
                    candidate.update(operation="manual-edit" if changed else "fixed-mapping", changedChutes=changed)
                    store.write("studies", study["id"], study)
                notify(study)

            return engine.run_manual(**kwargs, on_update=annotate)

        return submit(run_evaluation, {"scenario": scenario, "mapping": request.mapping,
                      "simulation_seeds": request.simulationSeeds, "record_trace": True,
                      "source_study_id": request.sourceStudyId, "source_candidate_id": request.sourceCandidateId})

    @app.post("/api/sorting/search")
    def search(request: SearchRequest):
        scenario = get_scenario(request.scenarioId)
        validate_seeds(request.simulationSeeds)
        if request.method not in METHODS or request.regime not in ("cold-start", "history"):
            raise HTTPException(422, "Unknown search method or regime")
        if request.budget % len(request.simulationSeeds):
            raise HTTPException(422, "Budget must be divisible by the number of simulation seeds")
        if request.regime == "history" and not request.historyStudyIds:
            raise HTTPException(422, "Select historical observations before a history-assisted search")
        if request.regime == "cold-start" and request.historyStudyIds:
            raise HTTPException(422, "Cold-start search cannot consume historical observations")
        if len(set(request.historyStudyIds)) != len(request.historyStudyIds):
            raise HTTPException(422, "Historical studies must not be repeated")
        history = [read_study(identifier) for identifier in request.historyStudyIds] if request.regime == "history" else []
        identity = engine.runtime.identity()
        for source in history:
            if source["status"] not in ("completed", "cancelled") or not engine.observations([source]):
                raise HTTPException(422, "Historical studies must contain completed measurements and be inactive")
            if any(source.get("simulator", {}).get(key) != identity[key]
                   for key in ("version", "upstreamRevision", "plannerRevision", "patchRevision")):
                raise HTTPException(422, "Historical measurements use a different simulator version")
            if source["costs"].get("historyCalls", 0) and not source.get("historyLedger"):
                raise HTTPException(422, "Historical learning costs lack source provenance")
        return submit(engine.run_search, {"scenario": scenario, "method": request.method, "budget": request.budget,
                      "batch_size": request.batchSize, "optimizer_seed": request.optimizerSeed,
                      "simulation_seeds": request.simulationSeeds, "history_studies": history, "record_trace": True})

    @app.get("/api/sorting/jobs/{identifier}")
    def job(identifier: str):
        with lock:
            if identifier not in jobs:
                raise HTTPException(404, "Job not found")
            return copy.deepcopy(jobs[identifier])

    @app.post("/api/sorting/jobs/{identifier}/cancel")
    def cancel(identifier: str):
        with lock:
            if identifier not in jobs:
                raise HTTPException(404, "Job not found")
            if jobs[identifier]["status"] in ("queued", "running", "cancelling"):
                events[identifier].set()
                jobs[identifier]["status"] = "cancelling"
            return copy.deepcopy(jobs[identifier])

    if static_dir.is_dir():
        app.mount("/", StaticFiles(directory=static_dir, html=True), name="application")
    else:
        @app.get("/")
        def unbuilt():
            return JSONResponse({"detail": "Build the interface with npm run build first"}, status_code=503)
    return app
