import { createSimulation, step, metrics, stateDigest } from '../core/sim/engine';
import type { SimState } from '../core/model/types';
import { makeDisplayFrame, type DisplayFrame } from '../ui/display';
import {
  BASE_TICKS_PER_SECOND,
  SNAPSHOT_INTERVAL_MS,
  INSPECTION_INTERVAL_MS,
  CHECKPOINT_INTERVAL,
  CHECKPOINT_CAPACITY,
  type Inspection,
  type SimulationCommand,
  type SimulationResponse,
} from './simulation-protocol';

/** Scheduling clocks never influence the shared kernel's integer-tick decisions. */
export function createSimulationRuntime(post: (message: SimulationResponse) => void) {
  let state: SimState | null = null;
  let revision = -1,
    requestId = -1,
    generation = 0,
    playing = false,
    speed = 1,
    maxTick = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let previousTime = 0,
    credit = 0,
    lastPublish = 0,
    lastInspection = 0;
  let rateTime = 0,
    rateTick = 0,
    actualTicksPerSecond = 0,
    snapshotBuildMs = 0;
  let frames: DisplayFrame[] = [];
  const checkpoints = new Map<number, SimState>();
  const identity = () => ({ revision, requestId });
  const stop = () => {
    playing = false;
    clearTimeout(timer);
    timer = undefined;
    credit = 0;
    frames = [];
  };
  function checkpoint() {
    if (!state || state.tick % CHECKPOINT_INTERVAL !== 0) return;
    checkpoints.set(state.tick, structuredClone(state));
    while (checkpoints.size > CHECKPOINT_CAPACITY) {
      const oldest = [...checkpoints.keys()].filter((t) => t !== 0).sort((a, b) => a - b)[0];
      checkpoints.delete(oldest);
    }
  }
  function inspection(): Inspection {
    const s = state!;
    return {
      tick: s.tick,
      maxTick,
      robots: s.robots,
      stations: s.stations,
      metrics: metrics(s),
      warning: s.warning,
      heatmap: s.heatmap,
      actualTicksPerSecond,
      checkpoints: checkpoints.size,
      snapshotBuildMs,
    };
  }
  function boundary(reason: string) {
    if (!state) return;
    frames = [];
    post({
      ...identity(),
      type: 'boundary',
      frame: makeDisplayFrame(state),
      inspection: inspection(),
      playing,
      speed,
      digest: stateDigest(state),
      reason,
    });
  }
  function advance() {
    step(state!);
    maxTick = Math.max(maxTick, state!.tick);
    checkpoint();
    const started = performance.now();
    const frame = makeDisplayFrame(state!);
    snapshotBuildMs = performance.now() - started;
    if (speed > 8) frames = [frame];
    else {
      frames.push(frame);
      if (frames.length > 128) frames.shift();
    }
  }
  function cycle() {
    if (!state || !playing) return;
    const now = performance.now();
    // Cap wall-clock debt after delays/background suspension; do not accumulate a catch-up queue.
    credit = Math.min(
      12,
      credit +
        (Math.min(250, Math.max(0, now - previousTime)) * BASE_TICKS_PER_SECOND * speed) / 1000,
    );
    previousTime = now;
    try {
      const deadline = now + 6;
      let count = 0;
      while (credit >= 1 && count < 12 && performance.now() < deadline) {
        advance();
        credit -= 1;
        count++;
      }
      const end = performance.now();
      if (end - rateTime >= 500) {
        actualTicksPerSecond = ((state.tick - rateTick) * 1000) / (end - rateTime);
        rateTime = end;
        rateTick = state.tick;
      }
      if (end - lastPublish >= SNAPSHOT_INTERVAL_MS && frames.length) {
        post({ ...identity(), type: 'frames', frames, playing, speed });
        frames = [];
        lastPublish = end;
      }
      if (end - lastInspection >= INSPECTION_INTERVAL_MS) {
        post({ ...identity(), type: 'inspection', inspection: inspection() });
        lastInspection = end;
      }
      timer = setTimeout(cycle, credit >= 1 ? 0 : 8);
    } catch (error) {
      stop();
      post({ ...identity(), type: 'error', error: String(error) });
    }
  }
  async function handle(message: SimulationCommand) {
    if (message.type !== 'init' && (message.revision !== revision || message.requestId < requestId))
      return;
    if (
      message.type === 'init' &&
      (message.revision < revision ||
        (message.revision === revision && message.requestId < requestId))
    )
      return;
    if (message.type === 'details') {
      if (state)
        post({
          ...identity(),
          type: 'details',
          details: {
            tick: state.tick,
            orders: state.orders,
            events: state.events,
            ledger: state.ledger,
            digest: stateDigest(state),
          },
        });
      return;
    }
    const ownGeneration = ++generation;
    requestId = message.requestId;
    try {
      if (message.type === 'init') {
        stop();
        revision = message.revision;
        state = createSimulation(message.scenario, message.config, message.seed);
        maxTick = 0;
        actualTicksPerSecond = 0;
        checkpoints.clear();
        checkpoint();
        boundary('init');
        return;
      }
      if (!state) return;
      if (message.type === 'play' || message.type === 'speed') {
        if (![1, 2, 4, 8, 16, 32, 64].includes(message.speed))
          throw new Error('Invalid playback speed');
        const wasPlaying = playing;
        stop();
        speed = message.speed;
        playing = message.type === 'play' || wasPlaying;
        previousTime = rateTime = performance.now();
        rateTick = state.tick;
        lastPublish = previousTime;
        lastInspection = previousTime;
        boundary(message.type);
        if (playing) timer = setTimeout(cycle, 0);
      } else if (message.type === 'pause') {
        stop();
        boundary('pause');
      } else if (message.type === 'step') {
        stop();
        advance();
        boundary('step');
      } else if (message.type === 'seek') {
        if (!Number.isInteger(message.tick) || message.tick < 0 || message.tick > maxTick)
          throw new Error('Replay target must be a previously executed tick');
        stop();
        const target = message.tick;
        post({ ...identity(), type: 'busy', tick: state.tick, target });
        const startTick = Math.max(...[...checkpoints.keys()].filter((t) => t <= target));
        const replay = structuredClone(checkpoints.get(startTick)!);
        while (replay.tick < target) {
          const deadline = performance.now() + 6;
          let count = 0;
          do {
            step(replay);
            count++;
          } while (replay.tick < target && count < 32 && performance.now() < deadline);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (ownGeneration !== generation) return;
        }
        if (ownGeneration !== generation) return;
        state = replay;
        boundary('seek');
      }
    } catch (error) {
      if (ownGeneration === generation) {
        stop();
        post({ ...identity(), type: 'error', error: String(error) });
      }
    }
  }
  return {
    handle,
    dispose() {
      generation++;
      stop();
      checkpoints.clear();
    },
  };
}
