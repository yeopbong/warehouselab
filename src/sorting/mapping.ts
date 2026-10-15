import type { SortingScenario } from './types';

export function mappingCounts(scenario: SortingScenario, mapping: string[]): Map<string, number> {
  const counts = new Map(scenario.destinations.map((destination) => [destination.id, 0]));
  for (const id of mapping) counts.set(id, (counts.get(id) ?? 0) + 1);
  return counts;
}

export function mappingErrors(scenario: SortingScenario, mapping: string[]): string[] {
  if (mapping.length !== scenario.map.chutes.length) return ['Every chute needs one destination.'];
  const counts = mappingCounts(scenario, mapping);
  const ids = new Set(scenario.destinations.map((destination) => destination.id));
  const errors: string[] = [];
  if (mapping.some((id) => !ids.has(id)))
    errors.push('The mapping contains an unknown destination.');
  for (const destination of scenario.destinations) {
    const count = counts.get(destination.id) ?? 0;
    if (count < destination.minChutes || count > destination.maxChutes) {
      errors.push(
        `${destination.label}: ${count} chutes; requires ${destination.minChutes}–${destination.maxChutes}.`,
      );
    }
  }
  return errors;
}

export function changedChutes(from: string[], to: string[]): number[] {
  return to.flatMap((id, index) => (id !== from[index] ? [index] : []));
}

export function parseSeeds(text: string): number[] {
  const parts = text.split(',').map((part) => part.trim());
  if (!parts.length || parts.some((part) => !/^\d+$/.test(part)))
    throw new Error('Use comma-separated simulation seeds.');
  const seeds = parts.map(Number);
  if (seeds.length > 10) throw new Error('Use at most 10 simulation seeds per candidate.');
  if (seeds.some((seed) => !Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295))
    throw new Error('Simulation seeds must be integers from 0 to 4294967295.');
  if (new Set(seeds).size !== seeds.length) throw new Error('Simulation seeds must be distinct.');
  return seeds;
}
