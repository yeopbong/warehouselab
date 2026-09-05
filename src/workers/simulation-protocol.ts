import type {
  Metrics,
  Robot,
  Station,
  Scenario,
  PolicyConfig,
  Order,
  SimEvent,
  Ledger,
} from '../core/model/types';
import type { DisplayFrame } from '../ui/display';
export const BASE_TICKS_PER_SECOND = 6;
export const SNAPSHOT_INTERVAL_MS = 50;
export const INSPECTION_INTERVAL_MS = 200;
export const CHECKPOINT_INTERVAL = 120;
export const CHECKPOINT_CAPACITY = 24;
export interface RuntimeIdentity {
  revision: number;
  requestId: number;
}
export type SimulationCommand = RuntimeIdentity &
  (
    | { type: 'init'; scenario: Scenario; config: PolicyConfig; seed: number }
    | { type: 'play' | 'speed'; speed: number }
    | { type: 'pause' | 'step' | 'details' }
    | { type: 'seek'; tick: number }
  );
export interface Inspection {
  tick: number;
  maxTick: number;
  robots: Robot[];
  stations: Station[];
  metrics: Metrics;
  warning: string | null;
  heatmap: Record<string, number>;
  actualTicksPerSecond: number;
  checkpoints: number;
  snapshotBuildMs: number;
}
export interface RunDetails {
  tick: number;
  orders: Order[];
  events: SimEvent[];
  ledger: Ledger;
  digest: string;
}
export type SimulationResponse = RuntimeIdentity &
  (
    | { type: 'frames'; frames: DisplayFrame[]; playing: boolean; speed: number }
    | { type: 'inspection'; inspection: Inspection }
    | {
        type: 'boundary';
        frame: DisplayFrame;
        inspection: Inspection;
        playing: boolean;
        speed: number;
        digest: string;
        reason: string;
      }
    | { type: 'busy'; tick: number; target: number }
    | { type: 'details'; details: RunDetails }
    | { type: 'error'; error: string }
  );
