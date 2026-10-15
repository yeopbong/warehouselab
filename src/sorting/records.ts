import { mappingErrors } from './mapping';
import type { Study } from './types';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;

function zones(value: unknown): boolean {
  return (
    object(value) &&
    Array.isArray(value.zones) &&
    value.zones.length === 12 &&
    value.zones.every(
      (zone) => object(zone) && finite(zone.trafficWaitFraction) && finite(zone.closedFraction),
    )
  );
}

export function parseStudyRecord(value: unknown): Study {
  const invalid = () => {
    throw new Error('This file is not a complete, supported sorting study.');
  };
  if (!object(value) || value.schemaVersion !== 1) return invalid();
  for (const key of ['id', 'name', 'method', 'status']) if (!text(value[key])) return invalid();
  if (
    !['cold-start', 'history', 'manual'].includes(String(value.regime)) ||
    !strings(value.historyIds)
  )
    return invalid();
  if (
    !nonnegative(value.optimizerSeed) &&
    !(value.regime === 'manual' && value.optimizerSeed === null)
  )
    return invalid();
  for (const key of ['budget', 'batchSize']) if (!nonnegative(value[key])) return invalid();
  const scenario = value.scenario;
  if (
    !object(scenario) ||
    !text(scenario.id) ||
    !text(scenario.name) ||
    !nonnegative(scenario.fleetSize) ||
    !nonnegative(scenario.horizon)
  )
    return invalid();
  const map = scenario.map;
  if (
    !object(map) ||
    !text(map.id) ||
    !finite(map.width) ||
    !finite(map.height) ||
    !Number.isInteger(map.width) ||
    !Number.isInteger(map.height) ||
    map.width < 1 ||
    map.height < 1 ||
    !strings(map.layout) ||
    map.layout.length !== map.height ||
    map.layout.some((row) => row.length !== map.width)
  )
    return invalid();
  const width = map.width,
    height = map.height;
  const cell = (entry: unknown): boolean =>
    object(entry) &&
    finite(entry.x) &&
    finite(entry.y) &&
    Number.isInteger(entry.x) &&
    Number.isInteger(entry.y) &&
    entry.x >= 0 &&
    entry.y >= 0 &&
    entry.x < width &&
    entry.y < height &&
    entry.cell === entry.y * width + entry.x;
  if (
    !Array.isArray(map.chutes) ||
    !map.chutes.length ||
    !map.chutes.every((entry) => cell(entry) && object(entry) && text(entry.id)) ||
    !Array.isArray(map.workstations) ||
    !map.workstations.every(cell)
  )
    return invalid();
  if (
    !Array.isArray(scenario.destinations) ||
    !scenario.destinations.length ||
    !scenario.destinations.every(
      (destination) =>
        object(destination) &&
        text(destination.id) &&
        text(destination.label) &&
        finite(destination.weight) &&
        destination.weight > 0 &&
        typeof destination.recirculation === 'boolean' &&
        nonnegative(destination.minChutes) &&
        nonnegative(destination.maxChutes) &&
        destination.maxChutes >= destination.minChutes,
    )
  )
    return invalid();
  if (
    new Set(scenario.destinations.map((destination) => destination.id)).size !==
    scenario.destinations.length
  )
    return invalid();
  if (!object(value.costs)) return invalid();
  for (const key of [
    'started',
    'completed',
    'failed',
    'cancelled',
    'cacheHits',
    'replicates',
    'executedTicks',
    'simulationSeconds',
    'trainingSeconds',
    'historyCalls',
    'historySeconds',
  ])
    if (!nonnegative(value.costs[key])) return invalid();
  const simulator = value.simulator;
  if (
    !object(simulator) ||
    !['upstreamRevision', 'patchRevision', 'buildHash'].every((key) => text(simulator[key]))
  )
    return invalid();
  if (!Array.isArray(value.candidates)) return invalid();
  const chuteCount = map.chutes.length;
  for (const candidate of value.candidates) {
    if (
      !object(candidate) ||
      !text(candidate.id) ||
      !text(candidate.operation) ||
      !strings(candidate.mapping) ||
      !nonnegative(candidate.calls) ||
      !(candidate.throughput === null || finite(candidate.throughput))
    )
      return invalid();
    if (
      !Array.isArray(candidate.changedChutes) ||
      !candidate.changedChutes.every(
        (index) => Number.isInteger(index) && index >= 0 && index < chuteCount,
      )
    )
      return invalid();
    if (candidate.prediction !== null) {
      const prediction = candidate.prediction;
      if (
        !object(prediction) ||
        !finite(prediction.mean) ||
        !nonnegative(prediction.std) ||
        (prediction.auxiliary != null && !zones(prediction.auxiliary))
      )
        return invalid();
    }
    if (!Array.isArray(candidate.evaluations)) return invalid();
    for (const evaluation of candidate.evaluations) {
      if (
        !object(evaluation) ||
        !['id', 'status', 'purpose'].every((key) => text(evaluation[key])) ||
        !nonnegative(evaluation.simulationSeed) ||
        !nonnegative(evaluation.wallSeconds) ||
        !(evaluation.executedTicks === null || nonnegative(evaluation.executedTicks)) ||
        !(evaluation.traceUrl === null || text(evaluation.traceUrl)) ||
        !(evaluation.cacheOf === null || text(evaluation.cacheOf))
      )
        return invalid();
      if (
        evaluation.metrics !== null &&
        (!object(evaluation.metrics) ||
          ![
            'throughput',
            'sortedParcels',
            'recirculated',
            'reroutes',
            'upstreamTaskThroughput',
          ].every((key) => nonnegative((evaluation.metrics as ObjectValue)[key])))
      )
        return invalid();
      if (evaluation.auxiliary !== null && !zones(evaluation.auxiliary)) return invalid();
    }
  }
  const study = value as unknown as Study;
  for (const candidate of study.candidates)
    if (mappingErrors(study.scenario, candidate.mapping).length)
      throw new Error('The record contains an invalid mapping.');
  return study;
}
