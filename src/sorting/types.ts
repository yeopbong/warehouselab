export interface ZoneMetrics {
  trafficWaitFraction: number;
  closedFraction: number;
}

export interface SortingScenario {
  id: string;
  name: string;
  map: {
    id: string;
    width: number;
    height: number;
    layout: string[];
    chutes: { id: string; x: number; y: number; cell: number }[];
    workstations: { x: number; y: number; cell: number }[];
  };
  destinations: {
    id: string;
    label: string;
    weight: number;
    recirculation: boolean;
    minChutes: number;
    maxChutes: number;
  }[];
  fleetSize: number;
  horizon: number;
  seed?: number;
  demandDescription?: string;
  randomization?: string;
  constraintMode?: string;
}

export interface Prediction {
  mean: number;
  std: number;
  auxiliary: { zones: ZoneMetrics[] };
  modelId?: string;
  trainedThrough?: number;
  trainingIds?: string[];
}

export interface Evaluation {
  id: string;
  status: string;
  purpose: string;
  simulationSeed: number;
  executedTicks: number | null;
  wallSeconds: number;
  metrics: {
    throughput: number;
    sortedParcels: number;
    recirculated: number;
    reroutes: number;
    upstreamTaskThroughput: number;
  } | null;
  auxiliary: { zones: ZoneMetrics[] } | null;
  traceUrl: string | null;
  cacheOf: string | null;
  error?: string;
}

export interface Candidate {
  id: string;
  mapping: string[];
  parentId?: string;
  operation: string;
  changedChutes: number[];
  prediction: Prediction | null;
  acquisition?: Record<string, number | string | boolean | null>;
  evaluations: Evaluation[];
  throughput: number | null;
  calls: number;
}

export interface Study {
  schemaVersion: 1;
  id: string;
  name: string;
  scenario: SortingScenario;
  method: string;
  regime: 'cold-start' | 'history' | 'manual';
  optimizerSeed: number | null;
  budget: number;
  batchSize: number;
  status: string;
  candidates: Candidate[];
  costs: {
    started: number;
    completed: number;
    failed: number;
    cancelled: number;
    cacheHits: number;
    replicates: number;
    executedTicks: number;
    simulationSeconds: number;
    trainingSeconds: number;
    historyCalls: number;
    historySeconds: number;
  };
  simulator: { upstreamRevision: string; patchRevision: string; buildHash: string };
  historyIds: string[];
}

export interface Catalog {
  schemaVersion: 1;
  scenarios: SortingScenario[];
  studies: {
    id: string;
    name: string;
    scenarioId: string;
    method: string;
    status: string;
    regime: string;
    bestThroughput: number | null;
  }[];
  defaultStudyId?: string;
  resultsUrl?: string;
}

export interface ServiceStatus {
  available: boolean;
  simulator: { ready: boolean; [key: string]: unknown };
}

export interface Job {
  id: string;
  status: string;
  studyId: string;
  progress: unknown;
  error?: string;
}

export interface JobReceipt {
  jobId: string;
  studyId: string;
}

export interface EvaluationRequest {
  scenarioId: string;
  mapping: string[];
  simulationSeeds: number[];
  horizon: number;
  sourceStudyId?: string;
  sourceCandidateId?: string;
}

export interface SearchRequest {
  scenarioId: string;
  method: string;
  budget: number;
  batchSize: number;
  optimizerSeed: number;
  simulationSeeds: number[];
  regime: 'cold-start' | 'history';
  historyStudyIds: string[];
}

export interface TraceEvent {
  type: string;
  tick: number;
  robot?: number;
  task?: number;
  parcel?: number;
  destination?: number;
  goal?: number;
  chute?: number;
  previous_chute?: number;
  recirculating?: boolean;
}

export interface RunTrace {
  scenarioId: string;
  evaluationId: string;
  candidateId: string;
  horizon: number;
  mapWidth: number;
  mapHeight: number;
  seed: number;
  destinationIds?: string[];
  positions: number[][];
  events: TraceEvent[];
  closures: [number, number, number][];
  curve: [number, number, number, number][];
}
