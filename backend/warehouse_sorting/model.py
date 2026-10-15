"""Small ensembles with shared throughput and measured-operation supervision."""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any
import numpy as np
import torch
from torch import nn
from sklearn.ensemble import ExtraTreesRegressor

from .features import AUX_NAMES, GLOBAL_DIM, NODE_DIM, ZONE_COLS, ZONE_ROWS, auxiliary_targets, mapping_features


class SpatialPredictor(nn.Module):
    def __init__(self, hidden: int = 32, flat: bool = False):
        super().__init__()
        self.flat = flat
        if flat:
            self.encoder = nn.Sequential(nn.Linear(37, hidden), nn.SiLU(), nn.Linear(hidden, hidden), nn.SiLU())
        else:
            self.input = nn.Linear(NODE_DIM, hidden)
            self.message = nn.ModuleList([nn.Linear(hidden * 3, hidden) for _ in range(2)])
            self.encoder = nn.Sequential(nn.Linear(hidden * 2 + GLOBAL_DIM, hidden), nn.SiLU())
        self.score = nn.Sequential(nn.Linear(hidden, hidden), nn.SiLU(), nn.Linear(hidden, 1))
        self.events = nn.Sequential(nn.Linear(hidden + GLOBAL_DIM, hidden), nn.SiLU(), nn.Linear(hidden, len(AUX_NAMES)))
        if flat:
            self.flat_events = nn.Linear(hidden, ZONE_ROWS * ZONE_COLS * len(AUX_NAMES))

    def forward(self, batch: dict[str, torch.Tensor]) -> tuple[torch.Tensor, torch.Tensor]:
        if self.flat:
            global_state = self.encoder(batch["flat"])
            return self.score(global_state).squeeze(-1), self.flat_events(global_state).reshape(-1, ZONE_ROWS * ZONE_COLS, len(AUX_NAMES))
        mask = batch["mask"].unsqueeze(-1)
        h = torch.nn.functional.silu(self.input(batch["nodes"])) * mask
        for layer in self.message:
            h = torch.nn.functional.silu(layer(torch.cat([h, batch["same"] @ h, batch["spatial"] @ h], dim=-1))) * mask
        count = mask.sum(1).clamp(min=1)
        mean = h.sum(1) / count
        maximum = h.masked_fill(mask == 0, -1e9).max(1).values
        global_state = self.encoder(torch.cat([mean, maximum, batch["context"]], dim=-1))
        zone_state = batch["zones"] @ h
        context = batch["context"].unsqueeze(1).expand(-1, ZONE_ROWS * ZONE_COLS, -1)
        return self.score(global_state).squeeze(-1), self.events(torch.cat([zone_state, context], dim=-1))


def _batch(features: list) -> dict[str, torch.Tensor]:
    size, m = len(features), max(len(f.nodes) for f in features)
    values = {
        "nodes": np.zeros((size, m, NODE_DIM), dtype=np.float32),
        "same": np.zeros((size, m, m), dtype=np.float32),
        "spatial": np.zeros((size, m, m), dtype=np.float32),
        "zones": np.zeros((size, ZONE_ROWS * ZONE_COLS, m), dtype=np.float32),
        "mask": np.zeros((size, m), dtype=np.float32),
        "context": np.stack([f.context for f in features]),
        "flat": np.stack([f.flat for f in features]),
    }
    for i, feature in enumerate(features):
        k = len(feature.nodes)
        values["nodes"][i, :k] = feature.nodes
        values["same"][i, :k, :k] = feature.same_destination
        values["spatial"][i, :k, :k] = feature.spatial
        values["zones"][i, :, :k] = feature.zones
        values["mask"][i, :k] = 1
    return {key: torch.from_numpy(value) for key, value in values.items()}


class MappingSurrogate:
    def __init__(self, seed: int = 0, auxiliary_weight: float = .25, flat: bool = False, epochs: int = 70, ensemble_size: int = 3):
        self.seed, self.auxiliary_weight, self.flat = seed, auxiliary_weight, flat
        self.epochs, self.ensemble_size = epochs, ensemble_size
        self.models: list[SpatialPredictor] = []
        self.mean, self.scale = 0., 1.
        self.aux_mean = np.zeros(len(AUX_NAMES), dtype=np.float32)
        self.aux_scale = np.ones(len(AUX_NAMES), dtype=np.float32)
        self.training_ids: list[str] = []
        self.fit_seconds = 0.
        self.fit_diagnostics: dict[str, Any] = {}

    def fit(self, scenario: dict, observations: list[dict]) -> dict:
        start = time.perf_counter()
        records = [o for o in observations if o.get("status", "completed") in ("completed", "success") and np.isfinite(o.get("throughput", np.nan))]
        if not records:
            raise ValueError("No completed observations to train on")
        features = [mapping_features(o.get("scenario", scenario), o["mapping"]) for o in records]
        score = np.asarray([o["throughput"] for o in records], dtype=np.float32)
        self.mean, self.scale = float(score.mean()), max(float(score.std()), abs(float(score.mean())) * .02, .01)
        target = torch.tensor((score - self.mean) / self.scale)
        auxiliaries = [auxiliary_targets(o) for o in records]
        aux = np.stack([a[0] for a in auxiliaries]); mask = np.stack([a[1] for a in auxiliaries])
        counts = mask.sum((0, 1)).clip(min=1)
        self.aux_mean = (aux * mask).sum((0, 1)) / counts
        self.aux_scale = np.maximum(np.sqrt(((aux - self.aux_mean) ** 2 * mask).sum((0, 1)) / counts), .01)
        aux_target = torch.tensor((aux - self.aux_mean) / self.aux_scale)
        aux_mask = torch.tensor(mask)
        self.models = []
        torch.set_num_threads(1)
        losses = []
        for member in range(self.ensemble_size):
            model_seed = self.seed + 104729 * member
            with torch.random.fork_rng():
                torch.manual_seed(model_seed)
                model = SpatialPredictor(flat=self.flat)
            optimizer = torch.optim.AdamW(model.parameters(), lr=.004, weight_decay=.002)
            rng = np.random.default_rng(model_seed)
            bootstrap = rng.integers(len(records), size=len(records))
            for epoch in range(self.epochs):
                order = rng.permutation(bootstrap)
                for offset in range(0, len(order), 16):
                    indices = order[offset:offset + 16]
                    inputs = _batch([features[int(i)] for i in indices])
                    prediction, predicted_aux = model(inputs)
                    score_loss = (prediction - target[indices]).square().mean()
                    event_mask = aux_mask[indices]
                    event_loss = ((predicted_aux - aux_target[indices]).square() * event_mask).sum() / event_mask.sum().clamp(min=1)
                    loss = score_loss + self.auxiliary_weight * event_loss
                    optimizer.zero_grad(); loss.backward()
                    torch.nn.utils.clip_grad_norm_(model.parameters(), 5.)
                    optimizer.step()
            model.eval(); self.models.append(model)
            losses.append({"score": float(score_loss.detach()), "auxiliary": float(event_loss.detach())})
        self.training_ids = [str(o.get("id", o.get("runId", i))) for i, o in enumerate(records)]
        self.fit_seconds = time.perf_counter() - start
        self.fit_diagnostics = {"seconds": self.fit_seconds, "observations": len(records), "trainingIds": self.training_ids, "auxiliaryWeight": self.auxiliary_weight, "auxiliaryLabels": int(mask.sum()), "losses": losses}
        return self.fit_diagnostics

    def predict(self, scenario: dict, mappings: list[list]) -> list[dict]:
        if not self.models:
            raise ValueError("Fit the surrogate before predicting")
        if not mappings:
            return []
        features = [mapping_features(scenario, mapping) for mapping in mappings]
        result = []
        with torch.no_grad():
            for offset in range(0, len(features), 64):
                inputs = _batch(features[offset:offset + 64])
                outputs = [model(inputs) for model in self.models]
                scores = np.stack([score.numpy() * self.scale + self.mean for score, _ in outputs])
                events = np.stack([aux.numpy() * self.aux_scale + self.aux_mean for _, aux in outputs])
                for i in range(scores.shape[1]):
                    mean_aux, std_aux = events[:, i].mean(0), events[:, i].std(0)
                    prediction = {"mean": float(scores[:, i].mean()), "std": float(scores[:, i].std()), "ensemble": scores[:, i].tolist(), "trainingIds": list(self.training_ids)}
                    if self.auxiliary_weight > 0 and self.fit_diagnostics.get("auxiliaryLabels", 0):
                        prediction["auxiliary"] = {"zones": [{name: float(np.clip(mean_aux[z, j], 0, 1)) for j, name in enumerate(AUX_NAMES)} for z in range(ZONE_ROWS * ZONE_COLS)]}
                        prediction["auxiliaryStd"] = {"zones": [{name: float(std_aux[z, j]) for j, name in enumerate(AUX_NAMES)} for z in range(ZONE_ROWS * ZONE_COLS)]}
                    result.append(prediction)
        return result

    def save(self, path: str | Path) -> None:
        torch.save({"format": 1, "kind": "spatial", "seed": self.seed, "auxiliaryWeight": self.auxiliary_weight, "flat": self.flat, "epochs": self.epochs, "ensembleSize": self.ensemble_size, "mean": self.mean, "scale": self.scale, "auxMean": self.aux_mean.tolist(), "auxScale": self.aux_scale.tolist(), "trainingIds": self.training_ids, "fitDiagnostics": self.fit_diagnostics, "states": [model.state_dict() for model in self.models]}, path)

    @classmethod
    def load(cls, path: str | Path) -> "MappingSurrogate":
        data = torch.load(path, map_location="cpu", weights_only=True)
        if data.get("format") != 1:
            raise ValueError("Unsupported model format")
        model = cls(seed=data["seed"], auxiliary_weight=data["auxiliaryWeight"], flat=data["flat"], epochs=data["epochs"], ensemble_size=data["ensembleSize"])
        model.mean, model.scale = data["mean"], data["scale"]
        model.aux_mean = np.asarray(data["auxMean"], dtype=np.float32); model.aux_scale = np.asarray(data["auxScale"], dtype=np.float32)
        model.training_ids, model.fit_diagnostics = data["trainingIds"], data["fitDiagnostics"]
        for state in data["states"]:
            network = SpatialPredictor(flat=model.flat); network.load_state_dict(state); network.eval(); model.models.append(network)
        return model


class SimpleSurrogate:
    def __init__(self, seed: int = 0):
        self.seed, self.training_ids, self.fit_seconds = seed, [], 0.
        self.model = ExtraTreesRegressor(n_estimators=48, min_samples_leaf=2, bootstrap=True, random_state=seed, n_jobs=1)

    def fit(self, scenario: dict, observations: list[dict]) -> dict:
        start = time.perf_counter()
        records = [o for o in observations if o.get("status", "completed") in ("completed", "success") and np.isfinite(o.get("throughput", np.nan))]
        if not records:
            raise ValueError("No completed observations to train on")
        inputs = np.stack([mapping_features(o.get("scenario", scenario), o["mapping"]).flat for o in records])
        targets = np.asarray([o["throughput"] for o in records])
        self.model.fit(inputs, targets)
        self.training_ids = [str(o.get("id", o.get("runId", i))) for i, o in enumerate(records)]
        self.fit_seconds = time.perf_counter() - start
        return {"seconds": self.fit_seconds, "observations": len(records), "trainingIds": self.training_ids}

    def predict(self, scenario: dict, mappings: list[list]) -> list[dict]:
        if not mappings:
            return []
        inputs = np.stack([mapping_features(scenario, m).flat for m in mappings])
        predictions = np.stack([tree.predict(inputs) for tree in self.model.estimators_])
        return [{"mean": float(predictions[:, i].mean()), "std": float(predictions[:, i].std()), "trainingIds": list(self.training_ids)} for i in range(len(mappings))]

    def save(self, path: str | Path) -> None:
        import joblib
        joblib.dump(self, path)
