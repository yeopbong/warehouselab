import { distance, type Robot, type SimState, type Task } from '../model/types';
export function estimatedFinish(
  state: SimState,
  r: Robot,
  task: Pick<Task, 'source' | 'destination'>,
): number {
  let elapsed = 0,
    position = r.position;
  for (let i = 0; i < r.tasks.length; i++) {
    const q = r.tasks[i],
      source = state.stations.find((s) => s.id === q.source)!,
      dest = state.stations.find((s) => s.id === q.destination)!;
    const service = i === 0 && r.serviceUntil > state.tick ? r.serviceUntil - state.tick : 1;
    if (i === 0 && r.status === 'unloading') {
      elapsed += service;
    } else if (i === 0 && q.phase === 'carrying') {
      elapsed += distance(position, dest.service) + 1;
    } else {
      elapsed +=
        distance(position, source.service) + service + distance(source.service, dest.service) + 1;
    }
    position = dest.service;
  }
  const from = state.stations.find((s) => s.id === task.source)!,
    to = state.stations.find((s) => s.id === task.destination)!;
  return elapsed + distance(position, from.service) + 1 + distance(from.service, to.service) + 1;
}
export function chooseRobot(
  state: SimState,
  task: Pick<Task, 'source' | 'destination'>,
): Robot | undefined {
  const source = state.stations.find((s) => s.id === task.source)!;
  const eligible = state.robots.filter(
    (r) => r.tasks.length < (state.config.assignment === 'nearest' ? 1 : 3),
  );
  return eligible.sort((a, b) => {
    const cost = (r: Robot) =>
      state.config.assignment === 'nearest'
        ? distance(r.position, source.service)
        : estimatedFinish(state, r, task);
    return cost(a) - cost(b) || a.id.localeCompare(b.id);
  })[0];
}
