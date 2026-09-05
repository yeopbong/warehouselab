import { useEffect, useRef, useState } from 'react';
import type { Scenario, PolicyConfig } from '../core/model/types';
import { DisplayStore, frameForScenario, type DisplayFrame } from './display';
import type {
  Inspection,
  RunDetails,
  SimulationCommand,
  SimulationResponse,
  RuntimeIdentity,
} from '../workers/simulation-protocol';
export const initialFrame = frameForScenario;
type CommandWithoutIdentity<T> = T extends unknown ? Omit<T, keyof RuntimeIdentity> : never;
export type Control = CommandWithoutIdentity<SimulationCommand>;
export function useSimulation(initialScenario: Scenario, initialConfig: PolicyConfig) {
  const [store] = useState(() => new DisplayStore(initialFrame(initialScenario), 0));
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [details, setDetails] = useState<RunDetails | null>(null);
  const [digest, setDigest] = useState('');
  const [playing, setPlaying] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const [speed, setSpeed] = useState(1);
  const worker = useRef<Worker | null>(null),
    revisionRef = useRef(0),
    requestRef = useRef(0);
  const applyInspection = (value: Inspection) => {
    setInspection(value);
    store.setDetails({
      tick: value.tick,
      paths: Object.fromEntries(value.robots.map((r) => [r.id, r.path])),
      heatmap: value.heatmap,
    });
  };
  useEffect(() => {
    const runtime = new Worker(new URL('../workers/simulation.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.current = runtime;
    runtime.onmessage = (event: MessageEvent<SimulationResponse>) => {
      const m = event.data;
      if (m.revision !== revisionRef.current || m.requestId !== requestRef.current) return;
      if (m.type === 'frames')
        store.push(m.frames, { playing: m.playing, speed: m.speed, revision: m.revision });
      else if (m.type === 'inspection') applyInspection(m.inspection);
      else if (m.type === 'boundary') {
        store.reset(m.frame, m.revision);
        store.push([], { playing: m.playing, speed: m.speed, revision: m.revision });
        applyInspection(m.inspection);
        setPlaying(m.playing);
        setSpeed(m.speed);
        setBusy(false);
        setDigest(m.digest);
      } else if (m.type === 'busy') {
        setBusy(true);
        setPlaying(false);
        store.setPlaying(false);
      } else if (m.type === 'details') setDetails(m.details);
      else if (m.type === 'error') {
        setError(m.error);
        setBusy(false);
        setPlaying(false);
        store.setPlaying(false);
      }
    };
    runtime.onerror = (e) => {
      setError(e.message);
      setBusy(false);
      setPlaying(false);
      store.setPlaying(false);
    };
    runtime.postMessage({
      type: 'init',
      scenario: initialScenario,
      config: initialConfig,
      seed: initialScenario.seed,
      revision: 0,
      requestId: 0,
    } satisfies SimulationCommand);
    return () => {
      runtime.terminate();
      worker.current = null;
    };
  }, []);
  function send(command: Control) {
    if (command.type !== 'details') requestRef.current++;
    if (command.type === 'speed') setSpeed(command.speed);
    if (command.type === 'play') setBusy(true);
    if (command.type === 'pause' || command.type === 'step' || command.type === 'seek') {
      store.setPlaying(false);
      setBusy(true);
    }
    worker.current?.postMessage({
      ...command,
      revision: revisionRef.current,
      requestId: requestRef.current,
    } as SimulationCommand);
  }
  function reset(scene: Scenario, config: PolicyConfig) {
    revisionRef.current++;
    requestRef.current++;
    setRevision(revisionRef.current);
    setPlaying(false);
    setBusy(true);
    setError('');
    setDetails(null);
    setDigest('');
    setInspection(null);
    store.reset(initialFrame(scene), revisionRef.current);
    worker.current?.postMessage({
      type: 'init',
      scenario: scene,
      config,
      seed: scene.seed,
      revision: revisionRef.current,
      requestId: requestRef.current,
    } satisfies SimulationCommand);
  }
  return {
    store,
    inspection,
    details,
    digest,
    playing,
    busy,
    error,
    revision,
    revisionRef,
    speed,
    send,
    reset,
  };
}
