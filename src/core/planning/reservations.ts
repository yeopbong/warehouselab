import { pointKey, type Point } from '../model/types';
import type { MotionReservations } from './search';

const vertexKey = (point: Point, tick: number): string => `${pointKey(point)}@${tick}`;
const edgeKey = (from: Point, to: Point, arrival: number): string =>
  `${pointKey(from)}>${pointKey(to)}@${arrival}`;
interface Reservation {
  owner: string;
  tick: number;
}

/** Owner-scoped reservations. A path's endpoint remains occupied through the horizon. */
export class ReservationTable implements MotionReservations {
  private vertices = new Map<string, Reservation>();
  private edges = new Map<string, Reservation>();

  vertexOwner(point: Point, tick: number): string | undefined {
    return this.vertices.get(vertexKey(point, tick))?.owner;
  }
  edgeOwner(from: Point, to: Point, arrival: number): string | undefined {
    return this.edges.get(edgeKey(from, to, arrival))?.owner;
  }

  canMove(owner: string, from: Point, to: Point, arrival: number): boolean {
    const occupant = this.vertexOwner(to, arrival);
    const reverse = this.edgeOwner(to, from, arrival);
    return (!occupant || occupant === owner) && (!reverse || reverse === owner);
  }

  /** Atomic insertion: failed replacements cannot overwrite another robot's reservation. */
  reservePath(owner: string, start: Point, path: readonly Point[], horizon: number): boolean {
    if (!Number.isInteger(horizon) || horizon < 0)
      throw new Error('Reservation horizon must be nonnegative');
    const cells = [start];
    for (let tick = 1; tick <= horizon; tick += 1) cells.push(path[tick - 1] ?? cells[tick - 1]);
    const initialOwner = this.vertexOwner(start, 0);
    if (initialOwner && initialOwner !== owner) return false;
    for (let tick = 1; tick <= horizon; tick += 1) {
      if (!this.canMove(owner, cells[tick - 1], cells[tick], tick)) return false;
    }
    for (let tick = 0; tick <= horizon; tick += 1) {
      this.vertices.set(vertexKey(cells[tick], tick), { owner, tick });
      if (tick > 0) this.edges.set(edgeKey(cells[tick - 1], cells[tick], tick), { owner, tick });
    }
    return true;
  }

  release(owner: string, fromTick = 0): void {
    for (const [key, reservation] of this.vertices) {
      if (reservation.owner === owner && reservation.tick >= fromTick) this.vertices.delete(key);
    }
    for (const [key, reservation] of this.edges) {
      if (reservation.owner === owner && reservation.tick >= fromTick) this.edges.delete(key);
    }
  }
}
