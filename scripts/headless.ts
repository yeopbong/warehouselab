import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PRESETS } from '../src/scenarios';
import { BASELINE, QUEUE_AWARE, normalizeConfig } from '../src/core/policies/config';
import { parseBundle } from '../src/core/model/validation';
import { runSimulation } from '../src/core/sim/engine';
import { codeVersion } from './version';

const options = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (
    !['--scenario', '--input', '--config', '--policy', '--seed', '--ticks', '--out'].includes(key)
  )
    throw new Error(`Unknown option ${key}`);
  const value = args[++i];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
  options.set(key, value);
}
let scenario = PRESETS.find((s) => s.id === (options.get('--scenario') ?? 'open-floor'));
if (!scenario)
  throw new Error(
    'Unknown scenario. Use open-floor, crossroads, hotspot, heldout-offset, or --input FILE.json.',
  );
let config = BASELINE;
if (options.has('--input')) {
  const bundle = parseBundle(JSON.parse(readFileSync(options.get('--input')!, 'utf8')));
  scenario = bundle.scenario;
  config = bundle.config;
}
if (options.has('--policy')) {
  const policy = options.get('--policy');
  if (policy !== 'baseline' && policy !== 'queue')
    throw new Error('Policy must be baseline or queue');
  config = policy === 'queue' ? QUEUE_AWARE : BASELINE;
}
if (options.has('--config')) {
  const value = JSON.parse(readFileSync(options.get('--config')!, 'utf8'));
  config = normalizeConfig(value.best?.config ?? value.config ?? value);
}
const result = runSimulation(
  scenario,
  config,
  Number(options.get('--seed') ?? scenario.seed),
  Number(options.get('--ticks') ?? 600),
  codeVersion(),
);
console.log(JSON.stringify(result, null, 2));
if (result.status === 'failed') process.exitCode = 1;
if (options.has('--out')) {
  const path = options.get('--out')!;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n');
}
