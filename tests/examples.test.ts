import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PRESETS } from '../src/scenarios';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
import { validateScenario } from '../src/core/model/validation';
it('exported scenario and policy examples match the runnable built-ins', () => {
  for (const scenario of PRESETS)
    expect(
      validateScenario(JSON.parse(readFileSync(`scenarios/${scenario.id}.json`, 'utf8'))),
    ).toEqual(scenario);
  expect(JSON.parse(readFileSync('configs/baseline.json', 'utf8'))).toEqual(BASELINE);
  expect(JSON.parse(readFileSync('configs/queue-aware.json', 'utf8'))).toEqual(QUEUE_AWARE);
});
