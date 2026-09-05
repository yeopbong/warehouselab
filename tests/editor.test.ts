import { describe, it, expect } from 'vitest';
import { applyEdit, previewEdit, withRobotCount } from '../src/ui/editor';
import { PRESETS } from '../src/scenarios';
import { contentHash, stableStringify } from '../src/core/model/random';
import { parseBundle } from '../src/core/model/validation';
import { BASELINE } from '../src/core/policies/config';
describe('atomic layout edits', () => {
  it('commits a deduplicated stroke without touching the input scene', () => {
    const scene = structuredClone(PRESETS[0]);
    const action = {
      type: 'paint' as const,
      tool: 'obstacle' as const,
      cells: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 0 },
        { x: 2, y: 0 },
      ],
    };
    const next = applyEdit(scene, action);
    expect(next.obstacles).toHaveLength(3);
    expect(scene.obstacles).toHaveLength(0);
    expect(() =>
      applyEdit(scene, { ...action, cells: [{ x: 0, y: 0 }, scene.stations[0].service] }),
    ).toThrow(/service/);
    expect(scene.obstacles).toHaveLength(0);
  });
  it('moves the station and service together and rejects an obstructed service cell', () => {
    const scene = structuredClone(PRESETS[0]);
    const selection = { kind: 'station' as const, id: 'supply-1' };
    const moved = applyEdit(scene, { type: 'move', selection, point: { x: 3, y: 4 } });
    const station = moved.stations.find((s) => s.id === 'supply-1')!;
    expect(station.position).toEqual({ x: 3, y: 4 });
    expect(station.service).toEqual({ x: 3, y: 5 });
    scene.obstacles.push({ x: 3, y: 5 });
    expect(previewEdit(scene, { type: 'move', selection, point: { x: 3, y: 4 } })).toMatch(
      /service/,
    );
  });
  it('moves stable robot IDs and removes orders when erasing their destination', () => {
    const scene = structuredClone(PRESETS[0]);
    const moved = applyEdit(scene, {
      type: 'move',
      selection: { kind: 'robot', id: 'R1' },
      point: { x: 1, y: 9 },
    });
    expect(moved.robots.find((r) => r.id === 'R1')!.position).toEqual({ x: 1, y: 9 });
    const erased = applyEdit(moved, {
      type: 'paint',
      tool: 'erase',
      cells: [moved.stations.find((s) => s.role === 'delivery')!.service],
    });
    expect(erased.orderStream).toBeUndefined();
    expect(erased.stations.some((s) => s.role === 'delivery')).toBe(false);
  });
  it('validates robot-count bounds while keeping starts distinct', () => {
    expect(() => withRobotCount(PRESETS[0], 1.5)).toThrow();
    expect(() => withRobotCount(PRESETS[0], 25)).toThrow();
    const scene = withRobotCount(PRESETS[0], 12);
    expect(scene.robots).toHaveLength(12);
    expect(new Set(scene.robots.map((r) => `${r.position.x},${r.position.y}`)).size).toBe(12);
  });
  it('canonical hashes survive optional JSON fields in new scenes', () => {
    const scene = { ...structuredClone(PRESETS[0]), orderStream: undefined };
    const parsed = parseBundle(
      JSON.parse(JSON.stringify({ schemaVersion: 1, scenario: scene, config: BASELINE })),
    );
    expect(contentHash(scene)).toBe(contentHash(parsed.scenario));
    expect(stableStringify({ a: undefined, b: [undefined, null] })).toBe('{"b":[null,null]}');
  });
});
