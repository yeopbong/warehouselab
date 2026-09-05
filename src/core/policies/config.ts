import type { PolicyConfig } from '../model/types';
export const BASELINE: PolicyConfig = {
  assignment: 'nearest',
  priority: 'fixed',
  routing: 'distance',
  congestionWeight: 0,
  planningWindow: 12,
  replanInterval: 3,
};
export const QUEUE_AWARE: PolicyConfig = {
  assignment: 'earliest',
  priority: 'waiting',
  routing: 'congestion',
  congestionWeight: 1.5,
  planningWindow: 16,
  replanInterval: 2,
};
export function normalizeConfig(value: unknown): PolicyConfig {
  if (!value || typeof value !== 'object') throw new Error('Configuration must be an object');
  const c = value as PolicyConfig;
  if (
    !['nearest', 'earliest'].includes(c.assignment) ||
    !['fixed', 'waiting'].includes(c.priority) ||
    !['distance', 'congestion'].includes(c.routing)
  )
    throw new Error('Unknown policy category');
  if (!Number.isFinite(c.congestionWeight) || c.congestionWeight < 0 || c.congestionWeight > 5)
    throw new Error('Congestion weight must be 0–5');
  if (!Number.isInteger(c.planningWindow) || c.planningWindow < 4 || c.planningWindow > 32)
    throw new Error('Planning window must be an integer, 4–32');
  if (!Number.isInteger(c.replanInterval) || c.replanInterval < 1 || c.replanInterval > 8)
    throw new Error('Replan interval must be an integer, 1–8');
  return {
    assignment: c.assignment,
    priority: c.priority,
    routing: c.routing,
    congestionWeight: c.routing === 'distance' ? 0 : c.congestionWeight,
    planningWindow: c.planningWindow,
    replanInterval: c.replanInterval,
  };
}
