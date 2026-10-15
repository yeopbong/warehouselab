import type {
  Catalog,
  EvaluationRequest,
  Job,
  JobReceipt,
  SearchRequest,
  ServiceStatus,
  Study,
} from './types';

const base = import.meta.env.BASE_URL;

async function readJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try {
      const data = await response.json();
      if (typeof data.detail === 'string') message = data.detail;
      else if (typeof data.error === 'string') message = data.error;
    } catch {
      /* A server error may not include a JSON body. */
    }
    throw new Error(message);
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('The service did not return a data record.');
  }
  const data = await response.json();
  return data as T;
}

function api(path: string): string {
  return `${base}api/sorting/${path}`;
}
function saved(path: string): string {
  return `${base}sorting/${path}`;
}

export async function serviceStatus(): Promise<ServiceStatus | null> {
  // The local simulation service is mounted at the origin root; subpath builds are static.
  if (base !== '/' || location.hostname.endsWith('.github.io')) return null;
  try {
    const result = await readJSON<ServiceStatus>(api('status'), {
      signal: AbortSignal.timeout(2500),
    });
    return result.available === true && result.simulator ? result : null;
  } catch {
    return null;
  }
}

export function getCatalog(live: boolean): Promise<Catalog> {
  return readJSON(live ? api('catalog') : saved('catalog.json'));
}
export function getStudy(id: string, live: boolean): Promise<Study> {
  return readJSON(
    live
      ? api(`studies/${encodeURIComponent(id)}`)
      : saved(`studies/${encodeURIComponent(id)}.json`),
  );
}
export function getJob(id: string): Promise<Job> {
  return readJSON(api(`jobs/${encodeURIComponent(id)}`));
}
export function cancelJob(id: string): Promise<Job> {
  return readJSON(api(`jobs/${encodeURIComponent(id)}/cancel`), { method: 'POST' });
}
function post<T>(path: string, data: T): Promise<JobReceipt> {
  return readJSON(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}
export const evaluateMapping = (request: EvaluationRequest) => post('evaluate', request);
export const startSearch = (request: SearchRequest) => post('search', request);
export async function getTrace<T>(
  evaluationId: string,
  traceUrl: string | null,
  live: boolean,
): Promise<T> {
  const useAPI = live && (!traceUrl || traceUrl.startsWith('/api/'));
  const url = useAPI
    ? api(`evaluations/${encodeURIComponent(evaluationId)}/trace`)
    : traceUrl
      ? new URL(traceUrl.replace(/^\//, ''), new URL(base, location.origin)).href
      : saved(`traces/${encodeURIComponent(evaluationId)}.json`);
  if (new URL(url, location.href).origin !== location.origin)
    throw new Error('Replay files must belong to this application.');
  if (!useAPI && new URL(url, location.href).pathname.endsWith('.gz')) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Replay request failed (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const stream =
      bytes[0] === 0x1f && bytes[1] === 0x8b
        ? new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
        : new Blob([bytes]).stream();
    return JSON.parse(await new Response(stream).text()) as T;
  }
  return readJSON<T>(url);
}
