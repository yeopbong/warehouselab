import {
  distance,
  type Inventory,
  type Point,
  type RobotStatus,
  type Scenario,
  type SimState,
} from '../core/model/types';

export const BASE_TICKS_PER_SECOND = 6;
export const MAX_DISPLAY_FRAMES = 96;
export const MAX_INTERPOLATED_SPEED = 8;

export interface DisplayRobot {
  id: string;
  position: Point;
  status: RobotStatus;
  load: { item: string; quantity: number } | null;
  waitReason: string;
}
export interface DisplayStation {
  id: string;
  status: string;
  input: Inventory;
  output: Inventory;
  processing: { recipeId: string; remaining: number } | null;
}
export interface DisplayFrame {
  tick: number;
  robots: DisplayRobot[];
  stations: DisplayStation[];
}
export interface DisplaySample {
  /** State at the floor of the shared presentation tick; business markers never lead motion. */
  frame: DisplayFrame;
  tick: number;
  robots: (DisplayRobot & { direction?: Point })[];
  sampled: boolean;
}
export interface DisplayDetails {
  tick: number;
  paths: Record<string, Point[]>;
  heatmap: Record<string, number>;
}

/** Capture only executed state. Planned routes are never used to infer motion. */
export function makeDisplayFrame(state: SimState): DisplayFrame {
  return {
    tick: state.tick,
    robots: state.robots.map(({ id, position, status, load, waitReason }) => ({
      id,
      position: { ...position },
      status,
      load: load ? { ...load } : null,
      waitReason,
    })),
    stations: state.stations.map(({ id, status, input, output, processing }) => ({
      id,
      status,
      input: { ...input },
      output: { ...output },
      processing: processing
        ? { recipeId: processing.recipeId, remaining: processing.remaining }
        : null,
    })),
  };
}

/** Initial editing frame without constructing or stepping a second simulation. */
export function frameForScenario(scenario: Scenario): DisplayFrame {
  return {
    tick: 0,
    robots: scenario.robots
      .map(({ id, position }) => ({
        id,
        position: { ...position },
        status: 'idle' as const,
        load: null,
        waitReason: 'No available transport',
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    stations: scenario.stations
      .map(({ id, role }) => ({
        id,
        status: role === 'delivery' ? 'Ready' : 'Starved',
        input: {},
        output: {},
        processing: null,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** A bounded one-tick-lag presentation clock. The simulation clock is owned by the worker. */
export class DisplayStore {
  private frames: DisplayFrame[] = [];
  private revision = 0;
  private lastNow: number | null = null;
  private cursor = 0;
  private running = false;
  private speed = 1;
  private epoch = 0;
  details: DisplayDetails = { tick: 0, paths: {}, heatmap: {} };
  readonly diagnostics = { accepted: 0, dropped: 0, stale: 0, maxBuffered: 0, invalidSegments: 0 };

  constructor(frame?: DisplayFrame, revision = 0) {
    if (frame) this.reset(frame, revision);
    else this.revision = revision;
  }

  get latest(): DisplayFrame | null {
    return this.frames.at(-1) ?? null;
  }
  get buffered(): number {
    return this.frames.length;
  }
  get playing(): boolean {
    return this.running;
  }
  get playbackSpeed(): number {
    return this.speed;
  }
  get generation(): number {
    return this.epoch;
  }

  reset(frame: DisplayFrame, revision: number): void {
    this.epoch++;
    this.revision = revision;
    this.frames = [frame];
    this.cursor = frame.tick;
    this.lastNow = null;
    this.running = false;
    this.details = { tick: frame.tick, paths: {}, heatmap: {} };
  }

  setPlaying(playing: boolean, now?: number): void {
    this.running = playing;
    this.lastNow = now ?? null;
    if (!playing && this.latest) {
      const frame = this.latest;
      this.frames = [frame];
      this.cursor = frame.tick;
    }
  }

  setDetails(details: DisplayDetails): void {
    this.details = {
      tick: details.tick,
      paths: Object.fromEntries(
        Object.entries(details.paths)
          .slice(0, 24)
          .map(([id, path]) => [id, path.slice(0, 32)]),
      ),
      heatmap: Object.fromEntries(Object.entries(details.heatmap).slice(0, 1600)),
    };
  }

  push(
    frames: DisplayFrame[],
    options: { playing: boolean; speed: number; revision: number; now?: number },
  ): boolean {
    if (options.revision !== this.revision) {
      this.diagnostics.stale += frames.length;
      return false;
    }
    if (this.running !== options.playing) this.setPlaying(options.playing, options.now);
    this.speed = Number.isFinite(options.speed) ? Math.max(0.01, options.speed) : 1;
    for (const frame of frames) {
      if (this.latest && frame.tick <= this.latest.tick) continue;
      if (!this.latest) this.cursor = frame.tick;
      this.frames.push(frame);
      this.diagnostics.accepted++;
    }
    if (!this.running || this.speed > MAX_INTERPOLATED_SPEED) {
      if (this.latest) {
        const frame = this.latest;
        this.diagnostics.dropped += Math.max(0, this.frames.length - 1);
        this.frames = [frame];
        this.cursor = frame.tick;
      }
    } else if (this.frames.length > MAX_DISPLAY_FRAMES) {
      this.diagnostics.dropped += this.frames.length - MAX_DISPLAY_FRAMES;
      this.frames.splice(0, this.frames.length - MAX_DISPLAY_FRAMES);
      this.cursor = Math.max(this.cursor, this.frames[0].tick);
      this.lastNow = options.now ?? null;
    }
    this.diagnostics.maxBuffered = Math.max(this.diagnostics.maxBuffered, this.frames.length);
    return true;
  }

  sample(now = performance.now(), reducedMotion = false): DisplaySample | null {
    if (!this.latest) return null;
    const resumed = this.lastNow !== null && now - this.lastNow > 500;
    const elapsed = this.lastNow === null ? 0 : Math.max(0, Math.min(250, now - this.lastNow));
    this.lastNow = now;
    const sampled = this.speed > MAX_INTERPOLATED_SPEED || reducedMotion || resumed;
    if (resumed) this.diagnostics.dropped += Math.max(0, this.frames.length - 1);
    if (this.running && !sampled)
      this.cursor = Math.min(
        this.latest.tick,
        this.cursor + (elapsed * BASE_TICKS_PER_SECOND * this.speed) / 1000,
      );
    else this.cursor = this.latest.tick;
    // Keep the left endpoint and only the as-yet-unpresented suffix.
    while (this.frames.length > 1 && this.frames[1].tick <= this.cursor) this.frames.shift();
    const from = this.frames[0],
      to = this.frames[1];
    const alpha =
      !sampled && to && to.tick === from.tick + 1 ? Math.min(1, this.cursor - from.tick) : 0;
    const byId = new Map(to?.robots.map((robot) => [robot.id, robot]));
    const legal =
      !!to &&
      to.robots.length === from.robots.length &&
      from.robots.every((robot) => {
        const next = byId.get(robot.id);
        return !!next && distance(robot.position, next.position) <= 1;
      });
    if (alpha > 0 && !legal) this.diagnostics.invalidSegments++;
    const interpolation = legal ? alpha : 0;
    return {
      frame: from,
      tick: from.tick + interpolation,
      sampled,
      robots: from.robots.map((robot) => {
        const next = byId.get(robot.id);
        const direction =
          legal && next
            ? {
                x: next.position.x - robot.position.x,
                y: next.position.y - robot.position.y,
              }
            : undefined;
        return {
          ...robot,
          position:
            next && direction
              ? {
                  x: robot.position.x + direction.x * interpolation,
                  y: robot.position.y + direction.y * interpolation,
                }
              : robot.position,
          direction,
        };
      }),
    };
  }
}
