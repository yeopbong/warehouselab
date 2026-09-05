import { writeFileSync, mkdirSync } from 'node:fs';
import { PRESETS } from '../src/scenarios';
import { BASELINE, QUEUE_AWARE } from '../src/core/policies/config';
mkdirSync('scenarios', { recursive: true });
mkdirSync('configs', { recursive: true });
for (const scenario of PRESETS)
  writeFileSync(`scenarios/${scenario.id}.json`, JSON.stringify(scenario, null, 2) + '\n');
for (const [name, config] of Object.entries({ baseline: BASELINE, 'queue-aware': QUEUE_AWARE }))
  writeFileSync(`configs/${name}.json`, JSON.stringify(config, null, 2) + '\n');
