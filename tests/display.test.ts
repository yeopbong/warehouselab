import { describe, expect, it } from 'vitest';
import {
  DisplayStore,
  MAX_DISPLAY_FRAMES,
  frameForScenario,
  makeDisplayFrame,
  type DisplayFrame,
} from '../src/ui/display';
import {
  fitViewport,
  rasterizeStroke,
  screenToCell,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '../src/ui/viewport';
import { createSimulation } from '../src/core/sim/engine';
import { BASELINE } from '../src/core/policies/config';
import { PRESETS } from '../src/scenarios';

function frame(tick: number, x = tick, y = 0): DisplayFrame {
  return {
    tick,
    robots: [{ id: 'R1', position: { x, y }, status: 'to-dropoff', load: null, waitReason: '' }],
    stations: [
      {
        id: 'press',
        status: 'Processing',
        input: { raw: 1 },
        output: {},
        processing: { recipeId: 'press', remaining: 5 - tick },
      },
    ],
  };
}

describe('executed-frame presentation', () => {
  it('follows each turn and wait, keeping loading and processing markers on their executed tick', () => {
    const frames = [frame(0, 0, 0), frame(1, 1, 0), frame(2, 1, 1), frame(3, 1, 1), frame(4, 1, 1)];
    frames[2].robots[0].status = 'waiting';
    frames[3].robots[0].status = 'loading';
    frames[4].robots[0].load = { item: 'product', quantity: 1 };
    const store = new DisplayStore(frames[0], 1);
    store.push(frames.slice(1), { playing: true, speed: 1, revision: 1, now: 0 });
    const first = store.sample(1000 / 12)!;
    expect(first.tick).toBeCloseTo(0.5);
    expect(first.robots[0].position).toEqual({ x: 0.5, y: 0 });
    expect(first.frame.stations[0].processing?.remaining).toBe(5);
    const turn = store.sample(250)!;
    expect(turn.tick).toBeCloseTo(1.5);
    expect(turn.robots[0].position.x).toBe(1);
    expect(turn.robots[0].position.y).toBeCloseTo(0.5);
    const wait = store.sample((1000 * 2.5) / 6)!;
    expect(wait.robots[0].position).toEqual({ x: 1, y: 1 });
    expect(wait.robots[0].status).toBe('waiting');
    const loading = store.sample((1000 * 3.5) / 6)!;
    expect(loading.robots[0].status).toBe('loading');
    expect(loading.robots[0].load).toBeNull();
    expect(store.sample((1000 * 4) / 6 + 0.001)!.robots[0].load?.item).toBe('product');
  });

  it('uses one presentation time for every robot and never invents a route across missing ticks', () => {
    const a = frame(0),
      b = frame(1);
    a.robots.push({ ...a.robots[0], id: 'R2', position: { x: 3, y: 0 } });
    b.robots.push({ ...b.robots[0], id: 'R2', position: { x: 3, y: 1 } });
    const together = new DisplayStore(a, 1);
    together.push([b], { playing: true, speed: 1, revision: 1, now: 0 });
    const sample = together.sample(1000 / 12)!;
    expect(sample.robots.map((robot) => robot.position)).toEqual([
      { x: 0.5, y: 0 },
      { x: 3, y: 0.5 },
    ]);
    const gap = new DisplayStore(frame(0, 0, 0), 1);
    gap.push([frame(4, 2, 2)], { playing: true, speed: 1, revision: 1, now: 0 });
    expect(gap.sample(250)!.robots[0].position).toEqual({ x: 0, y: 0 });
    expect(gap.sample(500)!.robots[0].position).toEqual({ x: 0, y: 0 });
    expect(gap.sample(750)!.robots[0].position).toEqual({ x: 2, y: 2 });
    const corrupt = new DisplayStore(frame(0), 1);
    corrupt.push([frame(1, 2)], { playing: true, speed: 1, revision: 1, now: 0 });
    expect(corrupt.sample(1000 / 12)!.robots[0].position).toEqual({ x: 0, y: 0 });
    expect(corrupt.diagnostics.invalidSegments).toBe(1);
  });

  it('bounds backlog, samples high speed, and prevents unbounded background catch-up', () => {
    const store = new DisplayStore(frame(0), 1);
    store.push(
      Array.from({ length: 200 }, (_, index) => frame(index + 1)),
      { playing: true, speed: 1, revision: 1, now: 0 },
    );
    expect(store.buffered).toBe(MAX_DISPLAY_FRAMES);
    store.sample(0);
    // Background restoration shows a real discrete snapshot instead of replaying a stale queue.
    expect(store.sample(60_000)).toMatchObject({ tick: 200, sampled: true });
    expect(store.buffered).toBe(1);
    store.push([frame(201), frame(202)], { playing: true, speed: 32, revision: 1 });
    expect(store.buffered).toBe(1);
    expect(store.sample(60_100)).toMatchObject({ tick: 202, sampled: true });
    expect(store.sample(60_150)!.robots[0].position.x).toBe(202);
  });

  it('pauses exactly and clears old revisions, plans, trajectories and clocks at control boundaries', () => {
    const store = new DisplayStore(frame(0), 1);
    store.push([frame(1), frame(2)], { playing: true, speed: 1, revision: 1, now: 0 });
    expect(store.sample(50)!.tick).toBeCloseTo(0.3);
    store.setPlaying(false, 50);
    expect(store.sample(1000)!.tick).toBe(2);
    expect(store.buffered).toBe(1);
    store.setDetails({ tick: 2, paths: { R1: [{ x: 3, y: 0 }] }, heatmap: { '1,1': 4 } });
    store.reset(frame(0, 9, 9), 2);
    expect(store.push([frame(3)], { playing: true, speed: 1, revision: 1 })).toBe(false);
    expect(store.latest?.robots[0].position).toEqual({ x: 9, y: 9 });
    expect(store.details).toEqual({ tick: 0, paths: {}, heatmap: {} });
    expect(store.sample(10_000)!.tick).toBe(0);
    expect(store.playing).toBe(false);
    store.reset(frame(100, 5, 5), 3);
    store.push([], { playing: false, speed: 8, revision: 3 });
    expect(store.sample(10_100)!.tick).toBe(100);
    expect(store.buffered).toBe(1);
  });

  it('respects reduced motion and produces detached minimal snapshots matching initial layout', () => {
    const state = createSimulation(PRESETS[0], BASELINE);
    const snapshot = makeDisplayFrame(state);
    expect(frameForScenario(PRESETS[0])).toEqual(snapshot);
    expect(snapshot).not.toHaveProperty('scenario');
    expect(snapshot).not.toHaveProperty('orders');
    state.robots[0].position.x++;
    expect(snapshot.robots[0].position).not.toEqual(state.robots[0].position);
    const store = new DisplayStore(frame(0), 1);
    store.push([frame(1)], { playing: true, speed: 1, revision: 1, now: 0 });
    expect(store.sample(20, true)).toMatchObject({ tick: 1, sampled: true });
  });
});

describe('shared viewport transforms and stroke geometry', () => {
  it('preserves pointer anchoring through zoom and hits the same cell after panning', () => {
    const fitted = fitViewport(1000, 600, 20, 12);
    const target = { x: 6, y: 4 },
      screen = worldToScreen(target, fitted);
    expect(screenToCell(screen, fitted)).toEqual(target);
    const zoomed = zoomAt(fitted, screen, 2.4);
    expect(screenToWorld(screen, zoomed)).toEqual(screenToWorld(screen, fitted));
    expect(screenToCell(screen, zoomed)).toEqual(target);
    const panned = { ...zoomed, x: zoomed.x - 127, y: zoomed.y + 63 };
    expect(screenToCell(worldToScreen(target, panned), panned)).toEqual(target);
    expect(zoomAt(zoomed, screen, 1e9).cell).toBe(160);
    expect(zoomAt(zoomed, screen, 1e-9).cell).toBe(5);
  });

  it('fills skipped pointer cells and diagonal corner crossings in one complete stroke', () => {
    expect(rasterizeStroke({ x: 2, y: 4 }, { x: 8, y: 4 })).toEqual(
      Array.from({ length: 7 }, (_, index) => ({ x: index + 2, y: 4 })),
    );
    const diagonal = rasterizeStroke({ x: 0, y: 0 }, { x: 3, y: 3 });
    for (let index = 0; index < 3; index++) {
      expect(diagonal).toContainEqual({ x: index + 1, y: index });
      expect(diagonal).toContainEqual({ x: index, y: index + 1 });
    }
    expect(diagonal.at(-1)).toEqual({ x: 3, y: 3 });
    expect(new Set(diagonal.map(({ x, y }) => `${x},${y}`)).size).toBe(diagonal.length);
    expect(rasterizeStroke({ x: 8, y: 4 }, { x: 2, y: 4 })).toEqual(
      rasterizeStroke({ x: 2, y: 4 }, { x: 8, y: 4 }).reverse(),
    );
  });
});
