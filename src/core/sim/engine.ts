import {
  KERNEL_VERSION,
  distance,
  pointKey,
  samePoint,
  type Scenario,
  type PolicyConfig,
  type SimState,
  type Metrics,
  type RunResult,
  type Inventory,
  type Task,
  type Point,
} from '../model/types';
import { validateScenario } from '../model/validation';
import { normalizeConfig } from '../policies/config';
import { chooseRobot } from '../policies/assignment';
import { random, contentHash } from '../model/random';
import { planRobotMoves, staticDistanceToGoal, type Grid } from '../planning';
const sum = (stock: Inventory) => Object.values(stock).reduce((a, b) => a + b, 0);
const add = (stock: Inventory, item: string, n: number) => {
  stock[item] = (stock[item] ?? 0) + n;
};
const event = (s: SimState, type: string, message: string) => {
  s.events.push({ tick: s.tick, type, message });
  if (s.events.length > 400) s.events.shift();
  s.lastProgressTick = s.tick;
};
export function createSimulation(
  scenario: Scenario,
  config: PolicyConfig,
  seed = scenario.seed,
): SimState {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295)
    throw new Error('Seed must be uint32');
  const sc = validateScenario(scenario);
  const rng = random(seed);
  const orders = structuredClone(sc.orders);
  if (sc.orderStream) {
    const stream = sc.orderStream;
    const dests = sc.stations
      .filter((st) => st.role === 'delivery')
      .sort((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < stream.count; i++) {
      const u = rng(),
        jitter = Math.floor(rng() * Math.max(1, stream.interval / 3));
      const index =
        stream.pattern === 'hotspot'
          ? u < 0.8
            ? 0
            : Math.min(dests.length - 1, 1 + Math.floor(((u - 0.8) / 0.2) * (dests.length - 1)))
          : i % dests.length;
      orders.push({
        id: `stream-${i + 1}`,
        arrival: i * stream.interval + jitter,
        item: stream.item,
        quantity: stream.quantity,
        destination: dests[index].id,
      });
    }
  }
  return {
    scenario: sc,
    config: normalizeConfig(config),
    seed,
    tick: 0,
    robots: sc.robots
      .map((r) => ({
        ...structuredClone(r),
        home: { ...r.position },
        status: 'idle' as const,
        tasks: [],
        load: null,
        waitReason: 'No available transport',
        waitTicks: 0,
        totalWaitTicks: 0,
        path: [],
        pathPlannedAt: -1,
        serviceUntil: 0,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    stations: sc.stations
      .map((st) => ({
        ...structuredClone(st),
        input: {},
        output: {},
        reservedInput: 0,
        reservedOutput: {},
        processing: null,
        busyTicks: 0,
        blockedTicks: 0,
        status: st.role === 'delivery' ? 'Ready' : 'Starved',
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    orders: orders
      .sort((a, b) => a.arrival - b.arrival || a.id.localeCompare(b.id))
      .map((o) => ({ ...o, remaining: o.quantity, reserved: 0, completedAt: null })),
    ledger: { supplied: {}, consumed: {}, produced: {}, delivered: {} },
    events: [],
    heatmap: {},
    lastProgressTick: 0,
    stalledTicks: 0,
    warning: null,
    nextTaskId: 1,
    planningMs: 0,
    planner: { topology: '', paths: {} },
  };
}
export function cancelTask(s: SimState, taskId: string): boolean {
  const robot = s.robots.find((r) => r.tasks.some((t) => t.id === taskId));
  const task = robot?.tasks.find((t) => t.id === taskId);
  if (!robot || !task || task.phase !== 'reserved') return false;
  const source = s.stations.find((st) => st.id === task.source)!,
    dest = s.stations.find((st) => st.id === task.destination)!;
  add(source.reservedOutput, task.item, -task.quantity);
  dest.reservedInput -= task.quantity;
  if (task.orderId) s.orders.find((o) => o.id === task.orderId)!.reserved -= task.quantity;
  const isCurrent = robot.tasks[0] === task;
  robot.tasks = robot.tasks.filter((t) => t.id !== taskId);
  if (isCurrent) {
    robot.serviceUntil = 0;
    robot.path = [];
    robot.status = 'idle';
  }
  event(s, 'cancel', `${task.id} released`);
  return true;
}
function finishServices(s: SimState): void {
  for (const r of s.robots) {
    if (!r.serviceUntil || r.serviceUntil > s.tick) continue;
    const t = r.tasks[0];
    if (!t) throw new Error('Service without task');
    const source = s.stations.find((st) => st.id === t.source)!,
      dest = s.stations.find((st) => st.id === t.destination)!;
    if (r.status === 'loading') {
      if (
        !samePoint(r.position, source.service) ||
        r.load ||
        (source.output[t.item] ?? 0) < t.quantity
      )
        throw new Error('Invalid pickup');
      add(source.output, t.item, -t.quantity);
      add(source.reservedOutput, t.item, -t.quantity);
      r.load = { item: t.item, quantity: t.quantity };
      t.phase = 'carrying';
      r.status = 'to-dropoff';
      event(s, 'pickup', `${r.id} picked ${t.quantity} ${t.item}`);
    } else if (r.status === 'unloading') {
      if (
        !samePoint(r.position, dest.service) ||
        !r.load ||
        r.load.item !== t.item ||
        r.load.quantity !== t.quantity
      )
        throw new Error('Invalid unload');
      dest.reservedInput -= t.quantity;
      if (t.orderId) {
        const o = s.orders.find((o) => o.id === t.orderId)!;
        if (o.arrival > s.tick || o.remaining < t.quantity)
          throw new Error('Invalid order delivery');
        o.remaining -= t.quantity;
        o.reserved -= t.quantity;
        add(s.ledger.delivered, t.item, t.quantity);
        if (o.remaining === 0) {
          o.completedAt = s.tick;
          event(s, 'order', `${o.id} completed`);
        }
      } else add(dest.input, t.item, t.quantity);
      r.load = null;
      r.tasks.shift();
      r.status = 'idle';
      event(s, 'dropoff', `${r.id} delivered ${t.quantity} ${t.item} to ${dest.id}`);
    } else throw new Error('Unexpected service status');
    r.serviceUntil = 0;
    r.path = [];
  }
}
function production(s: SimState): void {
  const pending = s.orders.some((o) => o.arrival <= s.tick && o.remaining > 0);
  for (const st of s.stations) {
    if (st.role === 'supply') {
      if (
        pending &&
        s.tick % (st.supplyInterval ?? 1) === 0 &&
        sum(st.output) < st.outputCapacity
      ) {
        add(st.output, st.supplyItem!, 1);
        add(s.ledger.supplied, st.supplyItem!, 1);
        event(s, 'supply', `${st.id}: external +1 ${st.supplyItem}`);
      }
      st.status =
        sum(st.output) >= st.outputCapacity
          ? 'Output full'
          : pending
            ? 'Supplying'
            : 'No arrived demand';
      continue;
    }
    if (st.role === 'delivery') {
      st.status = 'Ready';
      continue;
    }
    const recipe = s.scenario.recipes.find((r) => r.id === st.recipeId)!;
    if (st.processing) {
      if (st.processing.remaining > 0) {
        st.processing.remaining--;
        st.busyTicks++;
      }
      if (st.processing.remaining === 0) {
        if (sum(st.output) + recipe.output.quantity <= st.outputCapacity) {
          for (const [item, n] of Object.entries(st.processing.inputs))
            add(s.ledger.consumed, item, n);
          add(st.output, recipe.output.item, recipe.output.quantity);
          add(s.ledger.produced, recipe.output.item, recipe.output.quantity);
          st.processing = null;
          event(s, 'production', `${st.id} made ${recipe.output.quantity} ${recipe.output.item}`);
        } else {
          st.blockedTicks++;
          st.status = 'Output blocked';
        }
      }
    }
    if (
      !st.processing &&
      Object.entries(recipe.inputs).every(([item, n]) => (st.input[item] ?? 0) >= n)
    ) {
      for (const [item, n] of Object.entries(recipe.inputs)) add(st.input, item, -n);
      st.processing = {
        recipeId: recipe.id,
        remaining: recipe.duration,
        inputs: { ...recipe.inputs },
      };
      event(s, 'processing', `${st.id} started ${recipe.id}`);
    }
    if (st.processing && st.processing.remaining > 0) st.status = 'Processing';
    else if (!st.processing) st.status = 'Starved';
  }
}
function assignTasks(s: SimState): void {
  if (!s.orders.some((o) => o.arrival <= s.tick && o.remaining > 0)) return;
  const queueLimit = s.config.assignment === 'nearest' ? 1 : 3;
  if (!s.robots.some((robot) => robot.tasks.length < queueLimit)) return;
  const sources = s.stations.filter((st) => st.role !== 'delivery');
  const grid: Grid = {
    width: s.scenario.width,
    height: s.scenario.height,
    blocked: new Set(
      [...s.scenario.obstacles, ...s.stations.map((station) => station.position)].map(pointKey),
    ),
  };
  const reachability = new Map<string, (point: Point) => number>();
  // Order priority is independent of robot planning priority. Form one global delivery
  // list before visiting production inputs; stable order IDs break same-age ties.
  const needs = s.orders
    .filter((order) => order.arrival <= s.tick && order.remaining > order.reserved)
    .sort((a, b) => a.arrival - b.arrival || a.id.localeCompare(b.id))
    .map((order) => ({
      dest: s.stations.find((station) => station.id === order.destination)!,
      item: order.item,
      quantity: order.remaining - order.reserved,
      orderId: order.id as string | undefined,
    }));
  const destinations = s.stations
    .filter((station) => station.role === 'assembly' || station.role === 'process')
    .sort((a, b) => {
      const rank = { delivery: 0, assembly: 1, process: 2, supply: 3 };
      return rank[a.role] - rank[b.role] || a.id.localeCompare(b.id);
    });
  for (const dest of destinations) {
    needs.push(
      ...Object.entries(s.scenario.recipes.find((r) => r.id === dest.recipeId)!.inputs).map(
        ([item, n]) => {
          const recipe = s.scenario.recipes.find((r) => r.id === dest.recipeId)!;
          const inbound = s.robots
            .flatMap((r) => r.tasks)
            .filter((t) => t.destination === dest.id && t.item === item)
            .reduce((a, t) => a + t.quantity, 0);
          const batches = Math.floor(dest.inputCapacity / sum(recipe.inputs));
          return {
            dest,
            item,
            quantity: Math.max(0, batches * n - (dest.input[item] ?? 0) - inbound),
            orderId: undefined,
          };
        },
      ),
    );
  }
  for (const need of needs) {
    const dest = need.dest;
    let count = need.quantity;
    while (count > 0 && sum(dest.input) + dest.reservedInput < dest.inputCapacity) {
      const available = sources
        .filter(
          (st) =>
            st.id !== dest.id && (st.output[need.item] ?? 0) > (st.reservedOutput[need.item] ?? 0),
        )
        .sort(
          (a, b) =>
            distance(a.service, dest.service) - distance(b.service, dest.service) ||
            a.id.localeCompare(b.id),
        );
      if (!available.length) break;
      const eligible = s.robots.filter((robot) => robot.tasks.length < queueLimit);
      if (!eligible.length) return;
      const distanceToDestination =
        reachability.get(dest.id) ?? staticDistanceToGoal(grid, dest.service);
      reachability.set(dest.id, distanceToDestination);
      // Stock and capacity alone do not make a transport executable. Both its pickup
      // and the chosen robot must share the destination's static connected component.
      // This only filters impossible tasks; live traffic still requires reservations.
      const source = available.find((station) => distanceToDestination(station.service) >= 0);
      if (!source) break;
      const robots = eligible.filter((robot) => distanceToDestination(robot.position) >= 0);
      if (!robots.length) break;
      const r = chooseRobot({ ...s, robots }, { source: source.id, destination: dest.id })!;
      const task: Task = {
        id: `T${s.nextTaskId++}`,
        source: source.id,
        destination: dest.id,
        item: need.item,
        quantity: 1,
        ...(need.orderId ? { orderId: need.orderId } : {}),
        assignedTo: r.id,
        createdAt: s.tick,
        phase: 'reserved',
      };
      r.tasks.push(task);
      add(source.reservedOutput, task.item, 1);
      dest.reservedInput++;
      if (task.orderId) s.orders.find((o) => o.id === task.orderId)!.reserved++;
      event(s, 'assignment', `${task.id}: ${r.id} ${source.id} → ${dest.id}`);
      count--;
    }
  }
}
export function step(s: SimState): void {
  s.tick++;
  finishServices(s);
  production(s);
  assignTasks(s);
  const goals = new Map<string, Point>();
  for (const r of s.robots) {
    r.waitReason = '';
    if (r.serviceUntil > s.tick) continue;
    const task = r.tasks[0];
    if (task) {
      const target = s.stations.find(
        (st) => st.id === (task.phase === 'reserved' ? task.source : task.destination),
      )!.service;
      if (samePoint(r.position, target)) {
        r.status = task.phase === 'reserved' ? 'loading' : 'unloading';
        r.serviceUntil = s.tick + 1;
        r.path = [];
        r.waitReason = 'Station service';
      } else {
        r.status = task.phase === 'reserved' ? 'to-pickup' : 'to-dropoff';
        goals.set(r.id, target);
      }
    } else {
      r.status = 'idle';
      r.waitReason = 'No available transport';
      if (!samePoint(r.position, r.home)) {
        goals.set(r.id, r.home);
        r.waitReason = 'Returning to parking';
      }
    }
  }
  const before = new Map(s.robots.map((r) => [r.id, { ...r.position }]));
  const moves = planRobotMoves(s, goals);
  // Commit simultaneously. The planner also validates; this guard protects the physical kernel boundary.
  for (const r of s.robots) {
    const p = moves.get(r.id) ?? r.position;
    if (distance(r.position, p) > 1) throw new Error('Illegal move');
    if (
      s.scenario.obstacles.some((o) => samePoint(o, p)) ||
      s.stations.some((st) => samePoint(st.position, p))
    )
      throw new Error('Move through wall');
    for (const q of s.robots) {
      if (r.id === q.id) continue;
      const qp = moves.get(q.id) ?? q.position;
      if (samePoint(p, qp)) throw new Error('Vertex collision');
      if (samePoint(p, q.position) && samePoint(qp, r.position) && !samePoint(r.position, p))
        throw new Error('Edge swap');
    }
  }
  for (const r of s.robots) {
    r.position = { ...(moves.get(r.id) ?? r.position) };
    const blocked = goals.has(r.id) && samePoint(before.get(r.id)!, r.position);
    if (blocked) {
      r.waitTicks++;
      r.totalWaitTicks++;
      r.status = 'waiting';
      r.waitReason = 'Traffic / no safe route';
      const k = pointKey(r.position);
      s.heatmap[k] = (s.heatmap[k] ?? 0) + 1;
    } else {
      r.waitTicks = 0;
    }
  }
  const pending = s.orders.some((o) => o.arrival <= s.tick && o.remaining > 0);
  const normalProcessing = s.stations.some((st) => st.processing && st.processing.remaining > 0);
  const stalled = pending && !normalProcessing && s.tick - s.lastProgressTick > 80;
  s.warning = stalled
    ? 'No material progress for 80 ticks. Inspect traffic and disconnected routes. State retained.'
    : null;
  if (stalled) s.stalledTicks++;
  assertInvariants(s);
}
export function assertInvariants(s: SimState): void {
  const ids = new Set<string>(),
    positions = new Set<string>();
  const reservedOut = new Map<string, Inventory>(),
    reservedIn = new Map<string, number>(),
    reservedOrders = new Map<string, number>();
  for (const r of s.robots) {
    const k = pointKey(r.position);
    if (positions.has(k)) throw new Error('Robot overlap');
    positions.add(k);
    if (r.tasks.length > 3) throw new Error('Queue capacity');
    if (Boolean(r.load) !== Boolean(r.tasks[0]?.phase === 'carrying'))
      throw new Error('Load/task mismatch');
    for (const [i, t] of r.tasks.entries()) {
      if (ids.has(t.id) || t.assignedTo !== r.id || t.quantity !== 1)
        throw new Error('Duplicate/invalid task');
      ids.add(t.id);
      if (i > 0 && t.phase !== 'reserved') throw new Error('Queued cargo');
      if (t.phase === 'reserved') {
        const stock = reservedOut.get(t.source) ?? {};
        add(stock, t.item, t.quantity);
        reservedOut.set(t.source, stock);
      }
      reservedIn.set(t.destination, (reservedIn.get(t.destination) ?? 0) + t.quantity);
      if (t.orderId)
        reservedOrders.set(t.orderId, (reservedOrders.get(t.orderId) ?? 0) + t.quantity);
    }
  }
  const physical: Inventory = {};
  for (const st of s.stations) {
    if (
      sum(st.input) + st.reservedInput > st.inputCapacity ||
      sum(st.output) > st.outputCapacity ||
      st.reservedInput !== (reservedIn.get(st.id) ?? 0)
    )
      throw new Error('Capacity/input reservation violation');
    for (const stock of [st.input, st.output, st.reservedOutput])
      for (const n of Object.values(stock))
        if (!Number.isInteger(n) || n < 0) throw new Error('Negative/noninteger stock');
    for (const item of new Set([
      ...Object.keys(st.reservedOutput),
      ...Object.keys(reservedOut.get(st.id) ?? {}),
    ]))
      if (
        (st.reservedOutput[item] ?? 0) !== (reservedOut.get(st.id)?.[item] ?? 0) ||
        (st.reservedOutput[item] ?? 0) > (st.output[item] ?? 0)
      )
        throw new Error('Output reservation violation');
    for (const stock of [st.input, st.output, st.processing?.inputs ?? {}])
      for (const [item, n] of Object.entries(stock)) add(physical, item, n);
  }
  for (const r of s.robots) if (r.load) add(physical, r.load.item, r.load.quantity);
  const items = new Set([
    ...Object.keys(physical),
    ...Object.values(s.ledger).flatMap(Object.keys),
  ]);
  for (const item of items) {
    const expected =
      (s.ledger.supplied[item] ?? 0) +
      (s.ledger.produced[item] ?? 0) -
      (s.ledger.consumed[item] ?? 0) -
      (s.ledger.delivered[item] ?? 0);
    if ((physical[item] ?? 0) !== expected) throw new Error(`Conservation failure: ${item}`);
  }
  for (const o of s.orders)
    if (
      o.remaining < 0 ||
      o.remaining > o.quantity ||
      o.reserved < 0 ||
      o.reserved > o.remaining ||
      o.reserved !== (reservedOrders.get(o.id) ?? 0) ||
      (o.remaining === 0) !== (o.completedAt !== null)
    )
      throw new Error('Order reservation/count violation');
}
export function metrics(s: SimState): Metrics {
  const arrived = s.orders.filter((o) => o.arrival <= s.tick),
    done = arrived.filter((o) => o.completedAt !== null),
    delays = done.map((o) => o.completedAt! - o.arrival);
  return {
    ticks: s.tick,
    completedOrders: done.length,
    unfinishedOrders: arrived.length - done.length,
    deliveredUnits: sum(s.ledger.delivered),
    throughput: s.tick ? done.length / s.tick : 0,
    meanDelay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : null,
    maxDelay: delays.length ? Math.max(...delays) : null,
    oldestUnfinishedAge: arrived.some((order) => order.remaining > 0)
      ? Math.max(
          ...arrived.filter((order) => order.remaining > 0).map((order) => s.tick - order.arrival),
        )
      : null,
    waitingRatio:
      s.tick && s.robots.length
        ? s.robots.reduce((a, r) => a + r.totalWaitTicks, 0) / (s.tick * s.robots.length)
        : 0,
    stationUtilization: Object.fromEntries(
      s.stations
        .filter((st) => st.role === 'process' || st.role === 'assembly')
        .map((st) => [st.id, s.tick ? st.busyTicks / s.tick : 0]),
    ),
    stalledTicks: s.stalledTicks,
    planningMs: s.planningMs,
  };
}
export function stateDigest(s: SimState): string {
  const { planningMs: _timing, ...state } = s;
  return contentHash(state);
}
/** Shared result envelope for synchronous CLI runs and cooperatively yielded worker runs. */
export function summarizeRun(
  s: SimState,
  horizon: number,
  codeVersion: string,
  runtimeMs: number,
  status: RunResult['status'] = 'completed',
  error?: string,
): RunResult {
  return {
    scenarioId: s.scenario.id,
    scenarioHash: contentHash(s.scenario),
    config: s.config,
    seed: s.seed,
    horizon,
    kernelVersion: KERNEL_VERSION,
    codeVersion,
    metrics: metrics(s),
    stateHash: stateDigest(s),
    runtimeMs,
    planningMs: s.planningMs,
    status,
    ...(error ? { error } : {}),
  };
}
export function runSimulation(
  scenario: Scenario,
  config: PolicyConfig,
  seed: number,
  horizon: number,
  codeVersion = 'dev-dirty',
): RunResult {
  if (!Number.isInteger(horizon) || horizon < 1)
    throw new Error('Horizon must be a positive integer');
  const start = performance.now();
  const s = createSimulation(scenario, config, seed);
  let error: string | undefined;
  try {
    while (s.tick < horizon) step(s);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return summarizeRun(
    s,
    horizon,
    codeVersion,
    performance.now() - start,
    error ? 'failed' : 'completed',
    error,
  );
}
