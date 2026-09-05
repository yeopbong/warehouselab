export const KERNEL_VERSION = '1.1.0';
export type Point = { x: number; y: number };
export type Item = string;
export type Inventory = Record<Item, number>;
export type StationRole = 'supply' | 'process' | 'assembly' | 'delivery';
export interface Recipe {
  id: string;
  inputs: Inventory;
  output: { item: Item; quantity: number };
  duration: number;
}
export interface StationSpec {
  id: string;
  role: StationRole;
  position: Point;
  service: Point;
  inputCapacity: number;
  outputCapacity: number;
  recipeId?: string;
  supplyItem?: Item;
  supplyInterval?: number;
}
export interface OrderSpec {
  id: string;
  arrival: number;
  item: Item;
  quantity: number;
  destination: string;
}
export interface OrderStream {
  count: number;
  interval: number;
  pattern: 'uniform' | 'hotspot';
  quantity: number;
  item: string;
}
export interface Scenario {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  obstacles: Point[];
  stations: StationSpec[];
  robots: { id: string; position: Point }[];
  recipes: Recipe[];
  orders: OrderSpec[];
  orderStream?: OrderStream;
  seed: number;
}
export interface PolicyConfig {
  assignment: 'nearest' | 'earliest';
  priority: 'fixed' | 'waiting';
  routing: 'distance' | 'congestion';
  congestionWeight: number;
  planningWindow: number;
  replanInterval: number;
}
export interface Task {
  id: string;
  source: string;
  destination: string;
  item: Item;
  quantity: number;
  orderId?: string;
  assignedTo: string;
  createdAt: number;
  phase: 'reserved' | 'carrying';
}
export type RobotStatus = 'idle' | 'to-pickup' | 'loading' | 'to-dropoff' | 'unloading' | 'waiting';
export interface Robot {
  id: string;
  position: Point;
  home: Point;
  status: RobotStatus;
  tasks: Task[];
  load: { item: Item; quantity: number } | null;
  waitReason: string;
  waitTicks: number;
  totalWaitTicks: number;
  path: Point[];
  pathPlannedAt: number;
  serviceUntil: number;
}
export interface Station extends StationSpec {
  input: Inventory;
  output: Inventory;
  reservedInput: number;
  reservedOutput: Inventory;
  processing: { recipeId: string; remaining: number; inputs: Inventory } | null;
  busyTicks: number;
  blockedTicks: number;
  status: string;
}
export interface Order extends OrderSpec {
  remaining: number;
  reserved: number;
  completedAt: number | null;
}
export interface SimEvent {
  tick: number;
  type: string;
  message: string;
}
export interface Ledger {
  supplied: Inventory;
  consumed: Inventory;
  produced: Inventory;
  delivered: Inventory;
}
export interface Metrics {
  ticks: number;
  completedOrders: number;
  unfinishedOrders: number;
  deliveredUnits: number;
  throughput: number;
  meanDelay: number | null;
  maxDelay: number | null;
  /** Age of the oldest arrived, unfinished order; null when no backlog exists. */
  oldestUnfinishedAge: number | null;
  waitingRatio: number;
  stationUtilization: Record<string, number>;
  stalledTicks: number;
  planningMs: number;
}
export interface SimState {
  scenario: Scenario;
  config: PolicyConfig;
  seed: number;
  tick: number;
  robots: Robot[];
  stations: Station[];
  orders: Order[];
  ledger: Ledger;
  events: SimEvent[];
  heatmap: Record<string, number>;
  lastProgressTick: number;
  stalledTicks: number;
  warning: string | null;
  nextTaskId: number;
  planningMs: number;
  /** Semantic path-reuse state, retained by structuredClone / JSON replay checkpoints. */
  planner: {
    topology: string;
    paths: Record<string, { goal: string; config: string }>;
  };
}
export interface RunResult {
  scenarioId: string;
  scenarioHash: string;
  config: PolicyConfig;
  seed: number;
  horizon: number;
  kernelVersion: string;
  codeVersion: string;
  metrics: Metrics;
  stateHash: string;
  runtimeMs: number;
  planningMs: number;
  status: 'completed' | 'cancelled' | 'failed';
  error?: string;
}
export const pointKey = (p: Point): string => `${p.x},${p.y}`;
export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
export const distance = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
