/** Production browser measurements; rAF cadence is NOT a screen-presented FPS measurement. */
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import os from 'node:os';

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i + 1]) throw new Error(`Missing value for ${process.argv[i]}`);
  flags.set(process.argv[i], process.argv[i + 1]);
}
const mode = flags.get('--mode') ?? 'after';
const onlyInteractions = flags.get('--only-interactions') === 'true';
const captureScreenshots = flags.get('--capture-screenshots') !== 'false';
const allPaths = flags.get('--all-paths');
if (!['before', 'after'].includes(mode)) throw new Error('--mode must be before or after');
const url = flags.get('--url') ?? 'http://127.0.0.1:4174';
const seconds = Number(flags.get('--seconds') ?? 30);
const highSeconds = Number(flags.get('--high-seconds') ?? 10);
if (![seconds, highSeconds].every((n) => Number.isFinite(n) && n > 0 && n <= 120))
  throw new Error('Measurement durations must be greater than zero and at most 120 seconds');
const output = resolve(flags.get('--out') ?? `results/performance/${mode}.json`);
const sourceDir = resolve(flags.get('--source-dir') ?? '.');
const screenshotDir = resolve(flags.get('--screenshots') ?? 'docs');
const sustainedPath = resolve('scenarios/sustained-production.json');
const sceneBytes = await readFile(sustainedPath);
const sustained = JSON.parse(sceneBytes.toString());
const baselineConfig = JSON.parse(await readFile('configs/baseline.json', 'utf8'));
const sourceFiles = [
  'src/ui/App.tsx',
  'src/ui/CanvasMap.tsx',
  'src/ui/styles.css',
  'src/workers/simulation.worker.ts',
  'src/workers/search.worker.ts',
  'src/core/sim/engine.ts',
  'src/core/planning/search.ts',
];
const sourceHash = createHash('sha256');
for (const path of sourceFiles)
  sourceHash.update(path).update(await readFile(resolve(sourceDir, path)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const consoleErrors = [];
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

await page.addInitScript(() => {
  const limit = 12_000;
  const keep = (array, value) => {
    if (array.length < limit) array.push(value);
  };
  const fresh = () => ({
    active: false,
    startAt: 0,
    endAt: 0,
    rafIntervals: [],
    paintFrameIntervals: [],
    longTasks: [],
    bitmapResets: 0,
    canvasCalls: 0,
    canvasApiMs: 0,
    workerMessages: {},
    workerJsonSamples: {},
    workerEstimateBytes: 0,
    workerMeasureMs: 0,
    firstWorkerTick: null,
    lastWorkerTick: null,
    startUiTick: 0,
    endUiTick: 0,
  });
  let sample = fresh(),
    lastRaf = null,
    lastPaintFrame = null,
    drew = false;
  let armed = null;
  const actions = [];
  const workerUrls = [];
  let activeAction = null;
  const targetCanvas = (canvas) =>
    canvas instanceof HTMLCanvasElement && canvas.dataset.testid === 'factory-map';
  for (const name of ['fillRect', 'clearRect', 'drawImage', 'stroke', 'fill', 'fillText']) {
    const original = CanvasRenderingContext2D.prototype[name];
    CanvasRenderingContext2D.prototype[name] = function (...args) {
      if (!targetCanvas(this.canvas)) return original.apply(this, args);
      drew = true;
      if (!sample.active) return original.apply(this, args);
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        sample.canvasCalls++;
        sample.canvasApiMs += performance.now() - started;
      }
    };
  }
  for (const property of ['width', 'height']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, property);
    Object.defineProperty(HTMLCanvasElement.prototype, property, {
      ...descriptor,
      set(value) {
        if (sample.active && targetCanvas(this)) sample.bitmapResets++;
        descriptor.set.call(this, value);
      },
    });
  }
  const raf = (now) => {
    if (sample.active) {
      if (lastRaf !== null) keep(sample.rafIntervals, now - lastRaf);
      if (drew && lastPaintFrame !== null) keep(sample.paintFrameIntervals, now - lastPaintFrame);
      if (drew) lastPaintFrame = now;
      lastRaf = now;
    }
    drew = false;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  new PerformanceObserver((list) => {
    if (sample.active)
      for (const item of list.getEntries())
        keep(sample.longTasks, {
          startTime: item.startTime,
          duration: item.duration,
          name: item.name,
        });
  }).observe({ type: 'longtask', buffered: false });
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(workerUrl, options) {
      super(workerUrl, options);
      workerUrls.push(String(workerUrl));
      const role = String(workerUrl).includes('search') ? 'search' : 'simulation';
      this.addEventListener('message', ({ data }) => {
        if (sample.active) {
          const key = `${role}:${data.type}`;
          const count = (sample.workerMessages[key] ?? 0) + 1;
          sample.workerMessages[key] = count;
          // Sample one in 20 JSON encodings. This estimates payload volume; it is not a
          // measurement of the structured-clone wire representation or its full cost.
          if (count === 1 || count % 20 === 0) {
            const start = performance.now();
            const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
            sample.workerMeasureMs += performance.now() - start;
            const stats = sample.workerJsonSamples[key] ?? { samples: 0, bytes: 0 };
            stats.samples++;
            stats.bytes += bytes;
            sample.workerJsonSamples[key] = stats;
          }
          const tick =
            data.state?.tick ?? data.tick ?? data.frame?.tick ?? data.frames?.at(-1)?.tick;
          if (role === 'simulation' && typeof tick === 'number') {
            sample.firstWorkerTick ??= tick;
            sample.lastWorkerTick = tick;
          }
        }
        if (activeAction && activeAction.workerAckMs == null) {
          const cancelled =
            data.type === 'cancelled' ||
            data.result?.status === 'cancelled' ||
            data.comparison?.status === 'cancelled';
          const stopped = data.playing === false && data.busy !== true;
          const tick =
            data.state?.tick ?? data.tick ?? data.frame?.tick ?? data.frames?.at(-1)?.tick;
          if (
            (activeAction.name.includes('cancel') && role === 'search' && cancelled) ||
            (activeAction.name === 'pause' && role === 'simulation' && stopped) ||
            (activeAction.name.startsWith('seek') &&
              role === 'simulation' &&
              tick === activeAction.targetTick &&
              data.busy !== true)
          )
            activeAction.workerAckMs = performance.now() - activeAction.inputAt;
        }
      });
    }
  };
  const tick = () =>
    Number(document.querySelector('[data-testid="tick"]')?.textContent?.replaceAll(',', '') ?? 0);
  const captureInput = (event) => {
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    if (!armed) return;
    const action = {
      ...armed,
      inputAt: performance.now(),
      eventType: event.type,
      workerAckMs: null,
      visibleFeedbackMs: null,
    };
    armed = null;
    activeAction = action;
    actions.push(action);
    const beforeZoom =
      action.name === 'zoom'
        ? document.querySelector('[data-testid="factory-map"]')?.toDataURL()
        : null;
    const check = () => {
      let matched = false;
      if (action.name === 'pause') {
        const workbench = document.querySelector('[data-testid="workbench"]');
        matched = workbench
          ? workbench.dataset.playing === 'false' && workbench.dataset.busy === 'false'
          : !/Pause/i.test(
              document.querySelector('[data-testid="play-pause"]')?.textContent ?? 'Pause',
            );
      } else if (action.name.startsWith('tab-'))
        matched = [...document.querySelectorAll('[role="tab"]')].some(
          (e) =>
            e.textContent.trim().startsWith(action.expected) &&
            e.getAttribute('aria-selected') === 'true',
        );
      else if (action.name === 'select-robot')
        matched = !!document.querySelector('[data-testid="robot-inspector"]');
      else if (action.name.includes('cancel'))
        matched = /cancel/i.test(
          document.querySelector('[data-testid="notice"]')?.textContent ?? '',
        );
      else if (action.name.startsWith('seek')) matched = tick() === action.targetTick;
      else if (action.name === 'zoom')
        matched = document.querySelector('[data-testid="factory-map"]')?.toDataURL() !== beforeZoom;
      if (matched && action.visibleFeedbackMs === null)
        action.visibleFeedbackMs = performance.now() - action.inputAt;
      if (action.visibleFeedbackMs === null && performance.now() - action.inputAt < 15_000)
        requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };
  for (const type of ['click', 'change', 'wheel', 'keydown'])
    document.addEventListener(type, captureInput, true);
  window.__wlPerf = {
    begin() {
      sample = fresh();
      sample.active = true;
      sample.startAt = performance.now();
      sample.startUiTick = tick();
      lastRaf = null;
      lastPaintFrame = null;
      drew = false;
    },
    finish() {
      sample.active = false;
      sample.endAt = performance.now();
      sample.endUiTick = tick();
      for (const [key, count] of Object.entries(sample.workerMessages)) {
        const stats = sample.workerJsonSamples[key];
        if (stats) sample.workerEstimateBytes += (count * stats.bytes) / stats.samples;
      }
      return structuredClone(sample);
    },
    arm(name, expected = null, targetTick = null) {
      armed = { name, expected, targetTick };
    },
    actions() {
      return structuredClone(actions);
    },
    assetUrls() {
      return [...workerUrls];
    },
  };
});

const result = {
  formatVersion: 1,
  mode,
  timestamp: new Date().toISOString(),
  url,
  sourceVersion: flags.get('--source-version') ?? 'working-tree',
  selectedSourceSha256: sourceHash.digest('hex'),
  sourceFingerprintMeaning:
    'Source directory snapshot at harness startup, not a verified build manifest. Served asset SHA256 values identify the software actually measured.',
  environment: {
    platform: os.platform(),
    architecture: os.arch(),
    cpu: os.cpus()[0]?.model,
    logicalCores: os.cpus().length,
    memoryGiB: +(os.totalmem() / 2 ** 30).toFixed(2),
    chrome: browser.version(),
    headless: true,
    viewport: { width: 1440, height: 900 },
    dpr: 1,
  },
  conditions: {
    normalSeconds: seconds,
    highSeconds,
    normalSpeedOption: '1',
    highSpeedOption: '64',
    sustainedSceneSha256: createHash('sha256').update(sceneBytes).digest('hex'),
    baselineConfig,
  },
  notes: [
    'rAF intervals describe callback scheduling, not screen-presented FPS. Headless Chrome has no physical display presentation measurement.',
    'Canvas paint-frame intervals count animation frames containing a main map drawing call; canvas API time excludes JS preparation and browser compositor work.',
    'Worker bytes are sampled JSON-size estimates (one in 20 per message type), not exact structured-clone transfer bytes. Encoding instrumentation duration is reported.',
    'Input feedback begins at captured click/change/wheel dispatch and ends at a subsequent rAF observing the visible UI condition; worker acknowledgement is separate.',
    '1× uses each version’s explicitly implemented clock; actual ticks/s is reported. The revised app changes 1× from the old ~12.5 tick/s target to 6 tick/s.',
  ],
  samples: [],
  interactions: [],
  consoleErrors,
  failures: [],
  screenshots: [],
};
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))].toFixed(3);
};
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () =>
  Object.fromEntries(
    (await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]),
  );
async function sampleRun(name, duration) {
  const initial = await metrics();
  await page.evaluate(() => window.__wlPerf.begin());
  await page.waitForTimeout(duration * 1000);
  const sample = await page.evaluate(() => window.__wlPerf.finish());
  const final = await metrics();
  const durationSeconds = (sample.endAt - sample.startAt) / 1000;
  result.samples.push({
    name,
    durationSeconds,
    ticks: sample.endUiTick - sample.startUiTick,
    actualUiTicksPerSecond: (sample.endUiTick - sample.startUiTick) / durationSeconds,
    firstWorkerTick: sample.firstWorkerTick,
    lastWorkerTick: sample.lastWorkerTick,
    raf: {
      count: sample.rafIntervals.length,
      medianMs: percentile(sample.rafIntervals, 0.5),
      p95Ms: percentile(sample.rafIntervals, 0.95),
      maxMs: Math.max(0, ...sample.rafIntervals),
      intervalsMs: sample.rafIntervals,
    },
    canvasPaintFrames: {
      count: sample.paintFrameIntervals.length + 1,
      medianMs: percentile(sample.paintFrameIntervals, 0.5),
      p95Ms: percentile(sample.paintFrameIntervals, 0.95),
      intervalsMs: sample.paintFrameIntervals,
    },
    mainThreadLongTasks: {
      count: sample.longTasks.length,
      totalMs: sample.longTasks.reduce((n, t) => n + t.duration, 0),
      entries: sample.longTasks,
    },
    bitmapResets: sample.bitmapResets,
    canvasApiCalls: sample.canvasCalls,
    canvasApiMs: sample.canvasApiMs,
    workerMessages: sample.workerMessages,
    workerJsonSamples: sample.workerJsonSamples,
    estimatedWorkerJsonBytes: Math.round(sample.workerEstimateBytes),
    workerMeasurementMs: sample.workerMeasureMs,
    cdp: Object.fromEntries(
      ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((key) => [
        key,
        final[key] - initial[key],
      ]),
    ),
    jsHeapBytes: final.JSHeapUsedSize,
  });
  console.log(
    `${mode} ${name}: tick/s=${result.samples.at(-1).actualUiTicksPerSecond.toFixed(2)} rAF P95=${result.samples.at(-1).raf.p95Ms}ms paints=${result.samples.at(-1).canvasPaintFrames.count} bitmapResets=${sample.bitmapResets}`,
  );
}
async function pause() {
  const control = page.getByTestId('play-pause');
  if (/Pause/i.test(await control.innerText())) {
    await page.evaluate(() => window.__wlPerf.arm('pause'));
    await control.click();
    await page.waitForFunction(() => {
      const workbench = document.querySelector('[data-testid="workbench"]');
      return workbench
        ? workbench.dataset.playing === 'false' && workbench.dataset.busy === 'false'
        : !/Pause/i.test(
            document.querySelector('[data-testid="play-pause"]')?.textContent ?? 'Pause',
          );
    });
    await page.waitForTimeout(50);
  }
}
async function reset() {
  await pause();
  await page.getByRole('button', { name: /Reset/ }).first().click();
  await page.waitForFunction(
    () => Number(document.querySelector('[data-testid="tick"]')?.textContent) === 0,
  );
}
async function screenshot(name, width = 1440, height = 900) {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(120);
  const path = resolve(screenshotDir, name);
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path });
  result.screenshots.push(name);
}
async function armTab(name) {
  await page.evaluate((expected) => window.__wlPerf.arm(`tab-${expected}`, expected), name);
  await page
    .getByRole('tab')
    .filter({ hasText: new RegExp(`^${name}`) })
    .click();
  await page.waitForTimeout(50);
}
async function runPhase(name, work) {
  try {
    await work();
  } catch (error) {
    result.failures.push({ phase: name, error: String(error) });
    console.error(name, String(error));
  }
}
try {
  await page.goto(url);
  await page.getByTestId('factory-map').waitFor();
  const pathsToggle = page.getByRole('checkbox', {
    name: mode === 'before' ? 'Paths' : 'All paths',
    exact: true,
  });
  if (allPaths !== undefined) await pathsToggle.setChecked(allPaths === 'true');
  result.conditions.rendering = { showAllPaths: await pathsToggle.isChecked(), heatmap: false };
  const assetUrls = await page.evaluate(() => [
    ...[...document.querySelectorAll('script[src]')].map((script) => script.src),
    ...[...document.querySelectorAll('link[rel="stylesheet"]')].map((link) => link.href),
    ...window.__wlPerf.assetUrls(),
  ]);
  result.servedAssets = [];
  for (const assetUrl of new Set(assetUrls)) {
    const response = await page.request.get(assetUrl);
    const bytes = await response.body();
    result.servedAssets.push({
      path: new URL(assetUrl).pathname,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      status: response.status(),
    });
  }
  result.environment.browser = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    devicePixelRatio,
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
  }));
  if (!onlyInteractions)
    await runPhase('default-normal', async () => {
      await page.getByLabel('Simulation speed', { exact: true }).selectOption('1');
      await page.getByTestId('play-pause').click();
      await sampleRun('default-normal-1x', seconds);
      if (captureScreenshots) {
        await screenshot(`${mode}-1440.png`);
        await screenshot(`${mode}-1280.png`, 1280, 800);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await pause();
    });
  if (!onlyInteractions)
    await runPhase('medium-normal', async () => {
      await pause();
      await page.getByLabel('Import scene file', { exact: true }).setInputFiles(sustainedPath);
      await page.waitForTimeout(250);
      await page.getByTestId('play-pause').click();
      await sampleRun('sustained-12-robots-normal-1x', seconds);
      await pause();
    });
  if (!onlyInteractions)
    await runPhase('default-high-speed', async () => {
      await page
        .getByLabel(mode === 'before' ? 'Scene preset' : 'Factory preset', { exact: true })
        .selectOption('open-floor');
      await page.waitForTimeout(200);
      await page.getByLabel('Simulation speed', { exact: true }).selectOption('64');
      await page.getByTestId('play-pause').click();
      await sampleRun('default-high-64x', highSeconds);
      await pause();
    });
  if (!onlyInteractions)
    await runPhase('long-replay', async () => {
      const maxTick = Number((await page.getByTestId('tick').textContent()).replaceAll(',', ''));
      const targets = [Math.min(1800, maxTick), Math.min(2200, maxTick), Math.min(1600, maxTick)];
      result.replay = {
        maxRecordedTick: maxTick,
        targets,
        scheduling:
          mode === 'before'
            ? 'Original controls disable seek while busy; three sequential requests through visible controls.'
            : 'Latest-target seek; controlled numeric requests through visible controls.',
      };
      for (const [index, target] of targets.entries()) {
        await page.getByLabel('Replay tick', { exact: true }).fill(String(target));
        await page.evaluate(
          ({ index, target }) => window.__wlPerf.arm(`seek-${index}`, null, target),
          { index, target },
        );
        const button = page.getByRole('button', { name: /Go to tick|Seek/, exact: false }).first();
        if (await button.count()) await button.click();
        else await page.getByLabel('Replay tick', { exact: true }).press('Enter');
        await page.waitForFunction(
          (target) =>
            Number(
              document.querySelector('[data-testid="tick"]')?.textContent?.replaceAll(',', ''),
            ) === target,
          target,
        );
        await page.waitForTimeout(50);
      }
    });
  await runPhase('search-interactions', async () => {
    await reset();
    await armTab('Optimize');
    const scope = page.getByLabel('Search scope', { exact: true });
    if (await scope.count()) await scope.selectOption('benchmark-set');
    await page.getByLabel('Evaluation horizon', { exact: true }).fill('5000');
    await page.getByLabel('Simulation budget', { exact: true }).fill('600');
    await page.evaluate(() => window.__wlPerf.begin());
    await page.getByTestId('start-search').click();
    await page.waitForTimeout(150);
    await armTab('Inspector');
    if (await page.getByLabel('Inspect object', { exact: true }).count()) {
      await page.evaluate(() => window.__wlPerf.arm('select-robot'));
      await page.getByLabel('Inspect object', { exact: true }).selectOption('robot:R1');
      await page.getByTestId('robot-inspector').waitFor();
    } else
      result.failures.push({
        phase: 'select-robot',
        error: 'No stable inspector selector available.',
      });
    await armTab('Policy');
    await armTab('Optimize');
    result.zoomDuringSearch =
      mode === 'before'
        ? { available: false, reason: 'Original canvas does not implement zoom/pan.' }
        : { available: true };
    if (mode === 'after') {
      const box = await page.getByTestId('factory-map').boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.evaluate(() => window.__wlPerf.arm('zoom'));
      await page.mouse.wheel(0, -200);
      await page.waitForTimeout(80);
    }
    await page.evaluate(() => window.__wlPerf.arm('search-cancel'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="start-search"]')?.disabled,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(50);
    result.optimizationInteractionSample = await page.evaluate(() => window.__wlPerf.finish());
  });
  await runPhase('comparison-cancel', async () => {
    await page.getByLabel('Import candidate file', { exact: true }).setInputFiles({
      name: 'baseline.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(baselineConfig)),
    });
    await page
      .getByRole('button', { name: /Compare baseline vs candidate|Compare candidate|Compare/ })
      .first()
      .click();
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__wlPerf.arm('comparison-cancel'));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="start-search"]')?.disabled,
      null,
      { timeout: 30_000 },
    );
    await page.waitForTimeout(50);
  });
  result.interactions = await page.evaluate(() => window.__wlPerf.actions());
  result.pageGeometry = await page.evaluate(() => ({
    viewportHeight: innerHeight,
    scrollHeight: document.documentElement.scrollHeight,
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: innerWidth,
  }));
} finally {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await browser.close();
  console.log(`Saved ${output}`);
}
if (result.failures.length || consoleErrors.length) process.exitCode = 1;
