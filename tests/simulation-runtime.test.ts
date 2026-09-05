import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulationRuntime } from '../src/workers/simulation-runtime';
import { CHECKPOINT_CAPACITY, type SimulationResponse } from '../src/workers/simulation-protocol';
import { BASELINE } from '../src/core/policies/config';
import { createSimulation, stateDigest, step } from '../src/core/sim/engine';
import { PRESETS } from '../src/scenarios';

type Runtime = ReturnType<typeof createSimulationRuntime>;
const runtimes: Runtime[] = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.useRealTimers();
});

function setup() {
  const messages: SimulationResponse[] = [];
  // A real Worker structured-clones each postMessage before the mutable kernel advances.
  const runtime = createSimulationRuntime((m) => messages.push(structuredClone(m)));
  runtimes.push(runtime);
  let requestId = 0;
  const init = () =>
    runtime.handle({
      type: 'init',
      revision: 0,
      requestId,
      scenario: PRESETS[0]!,
      config: BASELINE,
      seed: 17,
    });
  const send = (
    command:
      | { type: 'play' | 'speed'; speed: number }
      | { type: 'pause' | 'step' | 'details' }
      | { type: 'seek'; tick: number },
  ) => runtime.handle({ ...command, revision: 0, requestId: ++requestId });
  const lastBoundary = () => {
    const boundary = messages.filter((m) => m.type === 'boundary').at(-1);
    if (!boundary || boundary.type !== 'boundary') throw new Error('Missing boundary');
    return boundary;
  };
  return { runtime, messages, init, send, lastBoundary, nextId: () => requestId + 1 };
}
function directDigest(tick: number, scene = PRESETS[0]!, seed = 17): string {
  const state = createSimulation(scene, BASELINE, seed);
  while (state.tick < tick) step(state);
  return stateDigest(state);
}
async function advanceRecorded(runtime: ReturnType<typeof setup>, atLeast: number) {
  await runtime.send({ type: 'play', speed: 64 });
  await vi.advanceTimersByTimeAsync(Math.ceil((atLeast / (6 * 64)) * 1000) + 24);
  await runtime.send({ type: 'pause' });
  expect(runtime.lastBoundary().frame.tick).toBeGreaterThanOrEqual(atLeast);
}

describe('integer playback and compact publication', () => {
  it('plays at the elapsed-time clock, pauses at one exact kernel tick, and steps without resuming', async () => {
    const r = setup();
    await r.init();
    await r.send({ type: 'play', speed: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    await r.send({ type: 'pause' });
    const paused = r.lastBoundary();
    expect(paused.frame.tick).toBeGreaterThanOrEqual(11);
    expect(paused.frame.tick).toBeLessThanOrEqual(12);
    expect(paused.playing).toBe(false);
    expect(paused.digest).toBe(directDigest(paused.frame.tick));
    const messageCount = r.messages.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.messages).toHaveLength(messageCount);
    await r.send({ type: 'step' });
    expect(r.lastBoundary().frame.tick).toBe(paused.frame.tick + 1);
    expect(r.lastBoundary().playing).toBe(false);
    expect(r.lastBoundary().digest).toBe(directDigest(paused.frame.tick + 1));
  });
  it('changes speed through an exact boundary, while every normal frame is a real adjacent tick', async () => {
    const r = setup();
    await r.init();
    await r.send({ type: 'play', speed: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    await r.send({ type: 'speed', speed: 8 });
    const changed = r.lastBoundary();
    expect(changed.reason).toBe('speed');
    expect(changed.playing).toBe(true);
    expect(changed.digest).toBe(directDigest(changed.frame.tick));
    r.messages.length = 0;
    await vi.advanceTimersByTimeAsync(1000);
    await r.send({ type: 'pause' });
    const frames = r.messages.flatMap((m) => (m.type === 'frames' ? m.frames : []));
    expect(frames.length).toBeGreaterThan(40);
    expect(frames[0]?.tick).toBe(changed.frame.tick + 1);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.tick).toBe(frames[i - 1]!.tick + 1);
    expect(r.lastBoundary().digest).toBe(directDigest(r.lastBoundary().frame.tick));
  });
  it('publishes compact frames without static maps, orders, full robot plans or per-frame digest', async () => {
    const r = setup();
    await r.init();
    await r.send({ type: 'play', speed: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    const packets = r.messages.filter((m) => m.type === 'frames');
    expect(packets.length).toBeGreaterThan(0);
    for (const packet of packets) {
      expect(packet).not.toHaveProperty('state');
      expect(packet).not.toHaveProperty('digest');
      expect(packet).not.toHaveProperty('scenario');
      for (const frame of packet.frames) {
        expect(frame).not.toHaveProperty('orders');
        expect(frame).not.toHaveProperty('events');
        expect(frame).not.toHaveProperty('scenario');
        expect(frame.robots[0]).not.toHaveProperty('path');
        expect(frame.robots[0]).not.toHaveProperty('tasks');
      }
    }
  });
  it('samples discrete high-speed output without skipping kernel steps and rejects unexecuted seek targets', async () => {
    const r = setup();
    await r.init();
    await advanceRecorded(r, 300);
    for (const packet of r.messages)
      if (packet.type === 'frames') expect(packet.frames).toHaveLength(1);
    const paused = r.lastBoundary();
    expect(paused.digest).toBe(directDigest(paused.frame.tick));
    await r.send({ type: 'seek', tick: paused.frame.tick + 1 });
    expect(r.messages.at(-1)?.type).toBe('error');
    await r.send({ type: 'pause' });
    expect(r.lastBoundary().frame.tick).toBe(paused.frame.tick);
  });
  it('caps a suspended-browser wall-clock jump and does not queue unbounded catch-up ticks', async () => {
    const r = setup();
    await r.init();
    await r.send({ type: 'play', speed: 64 });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(3_600_000);
    await vi.runOnlyPendingTimersAsync();
    await r.send({ type: 'pause' });
    clock.mockRestore();
    const tick = r.lastBoundary().frame.tick;
    expect(tick).toBeLessThanOrEqual(12);
    expect(r.lastBoundary().digest).toBe(directDigest(tick));
    const count = r.messages.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.messages).toHaveLength(count);
  });
});

describe('bounded checkpoints and latest request wins', () => {
  it('restores varied old and recent checkpoints to the direct kernel digest, including retained tick zero', async () => {
    const r = setup();
    await r.init();
    await advanceRecorded(r, 3500);
    expect(r.lastBoundary().inspection.checkpoints).toBeLessThanOrEqual(CHECKPOINT_CAPACITY);
    expect(r.lastBoundary().inspection.checkpoints).toBeGreaterThan(1);
    for (const target of [3299, 17, 1800, 0, 2399]) {
      const pending = r.send({ type: 'seek', tick: target });
      await vi.runAllTimersAsync();
      await pending;
      const restored = r.lastBoundary();
      expect(restored.reason).toBe('seek');
      expect(restored.frame.tick).toBe(target);
      expect(restored.digest).toBe(directDigest(target));
      expect(restored.inspection.maxTick).toBeGreaterThanOrEqual(3500);
      expect(restored.playing).toBe(false);
    }
  });
  it('abandons an in-progress seek when a newer target arrives and never publishes its stale boundary', async () => {
    const r = setup();
    await r.init();
    await advanceRecorded(r, 900);
    r.messages.length = 0;
    const oldId = r.nextId();
    const old = r.send({ type: 'seek', tick: 899 });
    const currentId = r.nextId();
    const latest = r.send({ type: 'seek', tick: 181 });
    await vi.runAllTimersAsync();
    await Promise.all([old, latest]);
    const boundaries = r.messages.filter((m) => m.type === 'boundary');
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]?.requestId).toBe(currentId);
    expect(boundaries[0]?.requestId).not.toBe(oldId);
    expect(r.lastBoundary().frame.tick).toBe(181);
    expect(r.lastBoundary().digest).toBe(directDigest(181));
  });
  it('replaces a scene during a seek and rejects both old revision commands and late same-revision init', async () => {
    const r = setup();
    await r.init();
    await advanceRecorded(r, 900);
    const seeking = r.send({ type: 'seek', tick: 899 });
    const scene = PRESETS[2]!;
    await r.runtime.handle({
      type: 'init',
      revision: 1,
      requestId: 8,
      scenario: scene,
      config: BASELINE,
      seed: 29,
    });
    r.messages.length = 0;
    await r.runtime.handle({ type: 'step', revision: 0, requestId: 999 });
    await r.runtime.handle({
      type: 'init',
      revision: 1,
      requestId: 7,
      scenario: PRESETS[0]!,
      config: BASELINE,
      seed: 17,
    });
    await vi.runAllTimersAsync();
    await seeking;
    expect(r.messages).toEqual([]);
    await r.runtime.handle({ type: 'pause', revision: 1, requestId: 9 });
    const boundary = r.lastBoundary();
    expect(boundary.revision).toBe(1);
    expect(boundary.requestId).toBe(9);
    expect(boundary.digest).toBe(directDigest(0, scene, 29));
    expect(boundary.frame.robots).toHaveLength(scene.robots.length);
  });
  it('pauses a seek at the last committed state and ignores an older play command', async () => {
    const r = setup();
    await r.init();
    await advanceRecorded(r, 900);
    const committed = r.lastBoundary();
    const oldId = r.nextId();
    const seeking = r.send({ type: 'seek', tick: 899 });
    await r.send({ type: 'pause' });
    const paused = r.lastBoundary();
    await r.runtime.handle({ type: 'play', speed: 64, revision: 0, requestId: oldId });
    await vi.runAllTimersAsync();
    await seeking;
    expect(r.lastBoundary()).toEqual(paused);
    expect(paused.digest).toBe(committed.digest);
    expect(paused.reason).toBe('pause');
  });
});
