#!/usr/bin/env node
/**
 * Headless Edge + Chrome DevTools Protocol smoke test for GLB Inspector.
 *
 * Usage (with serve.py already running on 127.0.0.1:8123):
 *   node test/smoke.mjs
 *
 * Optional:
 *   EDGE_PATH="C:\path\to\msedge.exe" node test/smoke.mjs
 *   BASE_URL=http://127.0.0.1:8123 node test/smoke.mjs
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8123';
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const EDGE_PATH = EDGE_CANDIDATES.find((candidate) => existsSync(candidate)) || EDGE_CANDIDATES[0];
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');
const PROFILE_DIR = path.join(ROOT, 'test', '.edge-profile');
const REPORT_PATH = path.join(ROOT, 'test', 'smoke-report.json');

/** Report paths relative to the checkout so reports carry no local absolute paths. */
function repoRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

const SAMPLES = [
  {
    id: 'damaged-helmet',
    name: 'Damaged Helmet',
    url: 'samples/DamagedHelmet.glb',
    expect: { triangles: (value) => value > 0, minMeshes: 1, animations: 0 },
  },
  {
    id: 'fox',
    name: 'Fox',
    url: 'samples/Fox.gltf',
    expect: { triangles: (value) => value > 0, minMeshes: 1, animations: 3 },
  },
  {
    id: 'box-textured',
    name: 'Box Textured',
    url: 'samples/BoxTextured.gltf',
    expect: { triangles: (value) => value === 12, minMeshes: 1, animations: 0, textures: 1 },
  },
  {
    id: 'range-arena',
    name: 'Range Arena',
    url: 'samples/neon/range_arena.glb',
    expect: { triangles: (value) => value === 34472, minMeshes: 100, animations: 0, viewHint: true, assetId: 'ENV_RANGE' },
  },
  {
    id: 'weapon-nr01',
    name: 'Weapon NR01',
    url: 'samples/neon/weapon_nr01.glb',
    expect: { triangles: (value) => value === 252, minMeshes: 21, animations: 0, viewHint: false, assetId: 'WPN_NR01' },
  },
  {
    id: 'drone-mk2',
    name: 'Drone Mk2',
    url: 'samples/neon/drone_mk2.glb',
    expect: { triangles: (value) => value === 3888, minMeshes: 6, animations: 0, viewHint: false, assetId: 'PRP_DRONE_MK2' },
  },
  {
    id: 'cover-crate',
    name: 'Cover Crate',
    url: 'samples/neon/cover_crate.glb',
    expect: { triangles: (value) => value === 48, minMeshes: 4, animations: 0, viewHint: false, assetId: 'PRP_COVER_CRATE' },
  },
];

const DRONE_MODEL = 'samples/neon/drone_mk2.glb';
const DRONE_ANIMS = 'samples/neon/drone_mk2.anims.json';
const EXPECTED_DRONE_CLIPS = ['spawn', 'idle', 'destroy'];

class CDP {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleErrors = [];
    this.consoleWarnings = [];
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${pending.method})`));
        else pending.resolve(message.result);
        return;
      }
      const handlers = this.listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
      if (message.method === 'Runtime.consoleAPICalled') {
        const type = message.params.type;
        const text = message.params.args.map(argToString).join(' ');
        if (type === 'error') this.consoleErrors.push({ source: 'console', text });
        else if (type === 'warning') this.consoleWarnings.push({ source: 'console', text });
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const detail = message.params.exceptionDetails;
        const text = detail.exception?.description || detail.text || 'Uncaught exception';
        this.consoleErrors.push({ source: 'exception', text });
      }
      if (message.method === 'Log.entryAdded' && message.params.entry?.level === 'error') {
        this.consoleErrors.push({ source: 'log', text: message.params.entry.text });
      }
    });
  }

  static async connect(wsUrl) {
    const socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('CDP WebSocket failed to open')); };
      const cleanup = () => {
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
    return new CDP(socket);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  waitForEvent(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.set(method, (this.listeners.get(method) || []).filter((entry) => entry !== wrapped));
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const wrapped = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) || []).filter((entry) => entry !== wrapped));
        resolve(params);
      };
      this.on(method, wrapped);
    });
  }

  close() {
    this.socket.close();
  }
}

function argToString(arg) {
  if (arg.value !== undefined) return String(arg.value);
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
  if (arg.description) return arg.description;
  return arg.type || '?';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      const body = await response.arrayBuffer();
      if (response.ok) return { response, body };
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || 'unknown error'}`);
}

async function evaluate(cdp, expression, { awaitPromise = true } = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const message = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Evaluation failed';
    throw new Error(message);
  }
  return result.result?.value;
}

async function waitForViewerReady(cdp, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, 'Boolean(window.__GLB_VIEWER__ && window.__GLB_VIEWER__.ready)', { awaitPromise: false });
    if (ready) return;
    await sleep(150);
  }
  throw new Error('window.__GLB_VIEWER__.ready did not become true');
}

async function waitForIdle(cdp, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, 'window.__GLB_VIEWER__.getState()', { awaitPromise: false });
    if (!state.loading) return state;
    await sleep(150);
  }
  throw new Error('Viewer remained in loading state');
}

async function waitForPaint(cdp) {
  await evaluate(cdp, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await sleep(700);
}

async function screenshot(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const destination = path.join(SCREENSHOT_DIR, filename);
  await fs.writeFile(destination, Buffer.from(result.data, 'base64'));
  return repoRelative(destination);
}

function validateSample(sample, state) {
  const failures = [];
  const expect = sample.expect || {};
  if (!state.modelName) failures.push('modelName is empty');
  if (!expect.triangles(state.triangleCount)) {
    failures.push(`triangleCount ${state.triangleCount} failed expectation`);
  }
  if (state.meshCount < (expect.minMeshes || 1)) failures.push(`meshCount ${state.meshCount} < ${expect.minMeshes}`);
  if (expect.animations !== undefined && state.animations !== expect.animations) {
    failures.push(`animations ${state.animations} !== ${expect.animations}`);
  }
  if (expect.textures !== undefined && state.textureCount !== expect.textures) {
    failures.push(`textureCount ${state.textureCount} !== ${expect.textures}`);
  }
  if (expect.viewHint !== undefined && state.neonRange?.viewHintUsed !== expect.viewHint) {
    failures.push(`viewHintUsed ${state.neonRange?.viewHintUsed} !== ${expect.viewHint}`);
  }
  if (expect.assetId && state.neonRange?.assetId !== expect.assetId) {
    failures.push(`assetId ${state.neonRange?.assetId} !== ${expect.assetId}`);
  }
  if (sample.id === 'fox' && !state.animationClips.includes('Survey')) {
    failures.push('Fox clips did not include Survey');
  }
  if (!Array.isArray(state.errors) || state.errors.length) {
    failures.push(`viewer errors: ${JSON.stringify(state.errors)}`);
  }
  return failures;
}

function arraysClose(a, b, epsilon = 1e-4) {
  return Array.isArray(a)
    && Array.isArray(b)
    && a.length === b.length
    && a.every((value, index) => Math.abs(Number(value) - Number(b[index])) <= epsilon);
}

function transformChanged(target) {
  if (!target?.rest) return false;
  return !arraysClose(target.position, target.rest.position)
    || !arraysClose(target.quaternion, target.rest.quaternion)
    || !arraysClose(target.scale, target.rest.scale);
}

async function main() {
  if (!existsSync(EDGE_PATH)) throw new Error(`Microsoft Edge was not found at ${EDGE_PATH}`);
  try {
    const response = await fetch(BASE_URL, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Local server is not reachable at ${BASE_URL}. Start it with "python serve.py". (${error.message})`);
  }

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.rm(PROFILE_DIR, { recursive: true, force: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const port = await getFreePort();
  const debugBase = `http://127.0.0.1:${port}`;

  const edge = spawn(EDGE_PATH, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--window-size=1600,1000',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let exitCode = 1;
  let cdp = null;
  const summary = {
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
    screenshots: [],
    samples: [],
    emptyState: null,
    queryParam: null,
    responsive: null,
    sidecarAnimations: null,
    localSidecar: null,
    emissive: null,
    mixedAnimations: null,
    validation: null,
    neonDeepLink: null,
    consoleErrors: [],
    consoleWarnings: [],
    pass: false,
  };

  try {
    await waitForHttp(`${debugBase}/json/version`);
    const targets = await (await fetch(`${debugBase}/json/list`)).json();
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('No page target found in Edge');
    cdp = await CDP.connect(page.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });

    const loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
    await loaded;
    await waitForViewerReady(cdp);
    await waitForPaint(cdp);

    const emptyUI = await evaluate(cdp, `(() => ({
      emptyVisible: !document.getElementById('empty-state').hidden,
      sampleCards: document.querySelectorAll('#sample-cards .sample-card').length,
      groups: Array.from(document.querySelectorAll('.sample-group')).map(el => el.textContent.trim()),
      heading: document.querySelector('.empty-intro h1')?.innerText || '',
      canvas: { width: document.getElementById('viewport').clientWidth, height: document.getElementById('viewport').clientHeight },
      viewport: { width: innerWidth, height: innerHeight }
    }))()`, { awaitPromise: false });
    summary.emptyState = emptyUI;
    if (!emptyUI.emptyVisible) throw new Error('Empty state was not visible on boot');
    if (emptyUI.sampleCards < 1) throw new Error('No sample cards were rendered');
    summary.screenshots.push((await screenshot(cdp, 'empty-state.png')).replaceAll('\\', '/'));

    for (const sample of SAMPLES) {
      const state = await evaluate(
        cdp,
        `(async () => { await window.__GLB_VIEWER__.loadModel(${JSON.stringify(sample.url)}); return window.__GLB_VIEWER__.getState(); })()`,
      );
      await waitForPaint(cdp);
      const rendered = await evaluate(cdp, `(() => ({
        loadingHidden: document.getElementById('loading-overlay').hidden,
        errorHidden: document.getElementById('error-state').hidden,
        emptyHidden: document.getElementById('empty-state').hidden,
        hierarchyRows: document.querySelectorAll('#hierarchy-tree .tree-row').length,
        materialRows: document.querySelectorAll('#materials-list .material-row').length,
        animationVisible: !document.getElementById('animation-section').hidden,
        selectedText: document.getElementById('metric-selected').textContent,
        canvasWidth: document.getElementById('viewport').clientWidth
      }))()`, { awaitPromise: false });
      const screenshotPath = await screenshot(cdp, `${sample.id}.png`);
      summary.screenshots.push(screenshotPath.replaceAll('\\', '/'));
      const failures = validateSample(sample, state);
      if (!rendered.loadingHidden) failures.push('loading overlay still visible');
      if (!rendered.errorHidden) failures.push('error overlay visible after success');
      if (rendered.hierarchyRows < 1) failures.push('hierarchy tree is empty');
      if (state.animationClips.length && !rendered.animationVisible) failures.push('animation panel hidden despite clips');
      const entry = { id: sample.id, name: sample.name, url: sample.url, state, rendered, screenshot: screenshotPath.replaceAll('\\', '/'), pass: failures.length === 0, failures };
      summary.samples.push(entry);
      console.log(`[smoke] ${sample.name}: ${state.triangleCount} tris, ${state.meshCount} meshes, ${state.animationClips.length} clips, ${failures.length ? 'FAIL' : 'ok'}`);
      if (failures.length) console.log(`[smoke]   ${failures.join('; ')}`);
    }

    await evaluate(cdp, '(async () => { await window.__GLB_VIEWER__.loadModel("samples/Fox.gltf"); return true; })()');
    const screenshotCheck = await evaluate(cdp, `(() => {
      const data = window.__GLB_VIEWER__.screenshot();
      return { prefix: data.slice(0, 22), length: data.length };
    })()`, { awaitPromise: false });
    summary.screenshotApi = {
      ...screenshotCheck,
      pass: screenshotCheck.prefix === 'data:image/png;base64,' && screenshotCheck.length > 5000,
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await waitForPaint(cdp);
    const responsive1280 = await evaluate(cdp, `(() => ({
      width: innerWidth,
      height: innerHeight,
      panelsDrawerMode: getComputedStyle(document.getElementById('left-panel')).position === 'absolute',
      pageOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      errorHidden: document.getElementById('error-state').hidden
    }))()`, { awaitPromise: false });
    summary.screenshots.push((await screenshot(cdp, 'responsive-1280-fox.png')).replaceAll('\\', '/'));

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 900, height: 800, deviceScaleFactor: 1, mobile: false,
    });
    await waitForPaint(cdp);
    const responsive = await evaluate(cdp, `(() => ({
      width: innerWidth,
      panelsDrawerMode: getComputedStyle(document.getElementById('left-panel')).position === 'absolute',
      leftButtonVisible: getComputedStyle(document.getElementById('btn-panel-left')).display !== 'none',
      sampleOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
      errorHidden: document.getElementById('error-state').hidden
    }))()`, { awaitPromise: false });
    summary.responsive = { at1280: responsive1280, at900: responsive };
    summary.screenshots.push((await screenshot(cdp, 'responsive-900-fox.png')).replaceAll('\\', '/'));
    if (responsive1280.pageOverflow) summary.responsive.failure = 'page overflow at 1280x800';
    if (responsive.sampleOverflow) summary.responsive.failure = 'page overflow at 900x800';

    const queryLoaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?model=samples/DamagedHelmet.glb` });
    await queryLoaded;
    await waitForViewerReady(cdp);
    let queryState = null;
    const queryDeadline = Date.now() + 20000;
    while (Date.now() < queryDeadline) {
      queryState = await evaluate(cdp, 'window.__GLB_VIEWER__.getState()', { awaitPromise: false });
      if (!queryState.loading && queryState.modelName) break;
      await sleep(150);
    }
    await waitForPaint(cdp);
    const queryUI = await evaluate(cdp, `(() => ({
      emptyHidden: document.getElementById('empty-state').hidden,
      errorHidden: document.getElementById('error-state').hidden
    }))()`, { awaitPromise: false });
    summary.queryParam = { state: queryState, ui: queryUI };
    queryUI.emptyHidden ? null : summary.queryParam.failure = 'query-param model did not replace empty state';
    summary.screenshots.push((await screenshot(cdp, 'query-param-helmet.png')).replaceAll('\\', '/'));
    if (!queryState || !queryState.modelName || queryState.loading) throw new Error('?model= query param did not load the model');
    if (queryState.errors.length) throw new Error(`?model= load reported errors: ${queryState.errors.join(' / ')}`);
    if (!queryUI.emptyHidden || !queryUI.errorHidden) throw new Error('?model= UI state is incorrect');

    // Local multi-file path: turn served bytes into File objects and drop them in.
    // This exercises the LoadingManager URL modifier and object-URL mapping used
    // by the real file picker instead of the relative-URL path used by samples.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await waitForPaint(cdp);
    await evaluate(cdp, `(async () => {
      const names = ['samples/Fox.gltf', 'samples/Fox.bin', 'samples/Texture.png'];
      const files = [];
      for (const path of names) {
        const response = await fetch(path);
        const blob = await response.blob();
        files.push(new File([blob], path.split('/').pop()));
      }
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      return true;
    })()`);
    let localState = null;
    const localDeadline = Date.now() + 25000;
    while (Date.now() < localDeadline) {
      localState = await evaluate(cdp, 'window.__GLB_VIEWER__.getState()', { awaitPromise: false });
      if (!localState.loading && localState.modelName === 'Fox.gltf') break;
      await sleep(150);
    }
    await waitForPaint(cdp);
    const localUI = await evaluate(cdp, `(() => ({
      source: document.getElementById('asset-source').textContent,
      errorHidden: document.getElementById('error-state').hidden,
      loadingHidden: document.getElementById('loading-overlay').hidden,
      hierarchyRows: document.querySelectorAll('#hierarchy-tree .tree-row').length
    }))()`, { awaitPromise: false });
    const localFailures = [];
    if (localState?.modelName !== 'Fox.gltf') localFailures.push('local Fox.gltf did not load');
    if (localState?.triangleCount !== 576) localFailures.push(`local triangleCount ${localState?.triangleCount} !== 576`);
    if (localState?.animationClips?.length !== 3) localFailures.push('local animation clips were not resolved');
    if (localState?.textureCount !== 1) localFailures.push(`local textureCount ${localState?.textureCount} !== 1`);
    if (localState?.errors?.length) localFailures.push(`local errors: ${localState.errors.join(' / ')}`);
    if (!localUI.errorHidden || !localUI.loadingHidden) localFailures.push('local load left an overlay visible');
    summary.localFile = { state: localState, ui: localUI, pass: localFailures.length === 0, failures: localFailures };

    const interactions = await evaluate(cdp, `(() => {
      const rows = document.querySelectorAll('#hierarchy-tree .tree-row');
      const target = rows[1] || rows[0];
      target?.click();
      const selected = document.getElementById('metric-selected').textContent;
      const selectionVisible = !document.getElementById('selection-section').hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const cleared = document.getElementById('metric-selected').textContent === '—';
      const wire = document.getElementById('toggle-wireframe');
      wire.click();
      const wireOn = wire.getAttribute('aria-checked') === 'true';
      wire.click();
      const wireOff = wire.getAttribute('aria-checked') === 'false';
      document.getElementById('btn-help').click();
      const helpOpen = document.getElementById('help-dialog').open;
      document.getElementById('btn-help-close').click();
      const helpClosed = !document.getElementById('help-dialog').open;
      return { selected, selectionVisible, cleared, wireOn, wireOff, helpOpen, helpClosed };
    })()`, { awaitPromise: false });
    const interactionFailures = [];
    if (!interactions.selected || interactions.selected === '—') interactionFailures.push('hierarchy selection did not update status bar');
    if (!interactions.selectionVisible) interactionFailures.push('selection inspector did not appear');
    if (!interactions.cleared) interactionFailures.push('Escape did not clear selection');
    if (!interactions.wireOn || !interactions.wireOff) interactionFailures.push('wireframe switch did not toggle');
    if (!interactions.helpOpen || !interactions.helpClosed) interactionFailures.push('help dialog did not open/close');
    summary.interactions = { ...interactions, pass: interactionFailures.length === 0, failures: interactionFailures };

    // NEON RANGE sidecar animation library (spawn / idle / destroy).
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false,
    });
    await waitForPaint(cdp);

    const sidecarLoad = await evaluate(cdp, `(async () => {
      const api = window.__GLB_VIEWER__;
      await api.loadModel(${JSON.stringify(DRONE_MODEL)}, ${JSON.stringify(DRONE_ANIMS)});
      const select = document.getElementById('anim-clip');
      return {
        state: api.getState(),
        anim: api.getAnimationState(),
        ui: {
          animationVisible: !document.getElementById('animation-section').hidden,
          source: document.getElementById('anim-source').textContent,
          fileNote: document.getElementById('anim-file-note').textContent,
          manualButton: Boolean(document.getElementById('btn-load-anims')),
          manualAccept: document.getElementById('anims-input')?.accept || '',
          selectValue: select.value,
          selectText: select.selectedOptions[0]?.textContent || '',
        },
      };
    })()`);
    await waitForPaint(cdp);

    const sidecarFailureList = [];
    const clipNames = sidecarLoad.state.neonAnimationClips || [];
    const clipList = sidecarLoad.anim?.clips || [];
    const missingExpectedClips = EXPECTED_DRONE_CLIPS.filter((name) => !clipNames.includes(name));
    if (!clipNames.length) sidecarFailureList.push('no NEON clips were reported by getState().neonAnimationClips');
    if (!clipNames.includes('destroy')) sidecarFailureList.push('destroy clip is missing');
    if (sidecarLoad.state.animationSource !== 'neon') sidecarFailureList.push('animationSource is not neon');
    if (!sidecarLoad.ui.animationVisible) sidecarFailureList.push('animation panel is hidden after sidecar load');
    if (!sidecarLoad.ui.manualButton) sidecarFailureList.push('manual .anims.json load button is missing');
    if (!/\.json/.test(sidecarLoad.ui.manualAccept)) sidecarFailureList.push('manual .anims.json input does not accept JSON');
    if (!/NEON ANIMS/i.test(sidecarLoad.ui.source)) sidecarFailureList.push('source line does not mention NEON ANIMS');
    if (!/drone_mk2\.anims\.json/i.test(sidecarLoad.ui.source)) sidecarFailureList.push('source line does not name the loaded library');
    if (sidecarLoad.ui.selectValue !== String(sidecarLoad.state.activeClipIndex)) sidecarFailureList.push('clip select does not match activeClipIndex');
    if (missingExpectedClips.length) {
      console.log(`[smoke] drone library note: missing ${missingExpectedClips.join(', ')} (not a failure; the sidecar may still be mid-authoring)`);
    }

    let targetIndex = clipList.findIndex((clip, index) => index > 0 && clip.name === 'destroy');
    if (targetIndex < 0) {
      const last = clipList.length - 1;
      targetIndex = last > 0 ? last : 0;
    }
    const targetClip = clipList[targetIndex] || null;
    const targetName = targetClip?.name || null;

    const selected = await evaluate(cdp, `(() => {
      const api = window.__GLB_VIEWER__;
      api.selectAnimationClip(${targetIndex});
      api.setAnimationPlaying(false);
      api.seekAnimation(0.55);
      const select = document.getElementById('anim-clip');
      return {
        state: api.getState(),
        anim: api.getAnimationState(),
        probe: api.getAnimationProbe(),
        emissive: api.getEmissiveState(),
        ui: {
          selectValue: select.value,
          selectText: select.selectedOptions[0]?.textContent || '',
          playPaused: document.getElementById('anim-play').classList.contains('is-paused'),
          source: document.getElementById('anim-source').textContent,
        },
      };
    })()`, { awaitPromise: false });
    await waitForPaint(cdp);
    const selectedScreenshot = await screenshot(cdp, 'drone-anims-selected.png');
    summary.screenshots.push(selectedScreenshot.replaceAll('\\', '/'));

    if (selected.anim.index !== targetIndex) sidecarFailureList.push(`activeClipIndex ${selected.anim.index} !== selected ${targetIndex}`);
    if (targetName && selected.anim.clips?.[targetIndex]?.name !== targetName) sidecarFailureList.push('selected clip name mismatch');
    if (targetName && selected.state.activeClip !== targetName) sidecarFailureList.push('getState().activeClip does not match selection');
    if (selected.anim.playing !== false) sidecarFailureList.push('clip kept playing after setAnimationPlaying(false)');
    if (!(selected.anim.duration > 0)) sidecarFailureList.push('selected clip duration is not positive');
    if (selected.ui.selectValue !== String(targetIndex)) sidecarFailureList.push('UI clip dropdown did not switch to the selected clip');
    if (targetName && !selected.ui.selectText.includes(targetName)) sidecarFailureList.push('UI option text does not include the selected clip name');
    if (!selected.ui.playPaused) sidecarFailureList.push('play button did not switch to paused state');
    if (!selected.probe?.targets?.length) sidecarFailureList.push('active sidecar clip resolved no targets');
    if (!selected.probe?.targets?.some(transformChanged)) sidecarFailureList.push('sidecar clip did not change any tracked transform');

    if (targetClip && !targetClip.looping) {
      await evaluate(cdp, `(() => {
        const api = window.__GLB_VIEWER__;
        api.seekAnimation(0.999);
        api.setAnimationPlaying(true);
        return true;
      })()`, { awaitPromise: false });
      await sleep(800);
      const clamped = await evaluate(cdp, `(() => {
        const api = window.__GLB_VIEWER__;
        return {
          state: api.getState(),
          anim: api.getAnimationState(),
          probe: api.getAnimationProbe(),
          playPaused: document.getElementById('anim-play').classList.contains('is-paused'),
        };
      })()`, { awaitPromise: false });
      const endScreenshot = await screenshot(cdp, 'drone-anims-end.png');
      summary.screenshots.push(endScreenshot.replaceAll('\\', '/'));
      summary.clampedSidecar = { anim: clamped.anim, playing: clamped.anim.playing, time: clamped.anim.time, duration: clamped.anim.duration };
      if (clamped.anim.playing !== false) sidecarFailureList.push('non-looping sidecar clip did not report playing:false at its end');
      if (clamped.state.animationPlaying !== false) sidecarFailureList.push('getState().animationPlaying stayed true after one-shot end');
      if (!clamped.playPaused) sidecarFailureList.push('play button did not reset after one-shot end');
      if (Math.abs((clamped.anim.duration || 0) - (clamped.anim.time || 0)) > 0.08) {
        sidecarFailureList.push(`clamped time ${clamped.anim.time} is not the clip end (${clamped.anim.duration})`);
      }
    } else {
      console.log('[smoke] drone target clip loops; skipped end-clamp assertion');
    }

    // Synthesized emissive probe: the real library already exercises
    // emissive_scale, but this isolates the restore-on-switch contract.
    const emissive = await evaluate(cdp, `(async () => {
      const api = window.__GLB_VIEWER__;
      const library = {
        schema: 1,
        asset: 'prp.drone.mk2',
        clips: [
          {
            name: 'emissive_probe',
            duration: 1,
            looping: true,
            tracks: [
              { node: 'Core', property: 'emissive_scale', interpolation: 'linear',
                keys: [{ t: 0, value: [1, 1, 1] }, { t: 1, value: [0.25, 0.25, 0.25] }] },
              { node: 'Ring', property: 'emissive_scale', interpolation: 'step',
                keys: [{ t: 0, value: [1, 1, 1] }, { t: 1, value: [0, 0, 0] }] },
            ],
          },
          {
            name: 'emissive_clear',
            duration: 1,
            looping: true,
            tracks: [
              { node: 'Core', property: 'translation', interpolation: 'linear',
                keys: [{ t: 0, value: [0, 0, 0] }, { t: 1, value: [0, 0.2, 0] }] },
            ],
          },
        ],
      };
      await api.loadNeonAnimations(library);
      const names = api.getState().animationClips;
      const probeIndex = names.indexOf('emissive_probe');
      const clearIndex = names.indexOf('emissive_clear');
      api.selectAnimationClip(probeIndex);
      api.setAnimationPlaying(false);
      api.seekAnimation(0);
      const atStart = api.getEmissiveState();
      api.seekAnimation(1);
      const atEnd = api.getEmissiveState();
      api.selectAnimationClip(clearIndex);
      api.setAnimationPlaying(false);
      const afterSwitch = api.getEmissiveState();
      const select = document.getElementById('anim-clip');
      return {
        probeIndex, clearIndex, atStart, atEnd, afterSwitch,
        selectValue: select.value,
        selectText: select.selectedOptions[0]?.textContent || '',
      };
    })()`);

    const emissiveFailures = [];
    const materialByName = (list, name) => (list || []).find((entry) => entry.name === name);
    const coreStart = materialByName(emissive.atStart, 'NR_TargetCore');
    const coreEnd = materialByName(emissive.atEnd, 'NR_TargetCore');
    const ringEnd = materialByName(emissive.atEnd, 'NR_TargetRing');
    const coreRestored = materialByName(emissive.afterSwitch, 'NR_TargetCore');
    const ringRestored = materialByName(emissive.afterSwitch, 'NR_TargetRing');
    if (emissive.probeIndex < 0) emissiveFailures.push('emissive_probe clip was not selectable');
    if (!coreStart || !coreEnd) {
      emissiveFailures.push('NR_TargetCore was not reported by getEmissiveState()');
    } else if (!arraysClose(coreEnd.emissive, coreStart.original.map((value) => value * 0.25), 2e-3)) {
      emissiveFailures.push(`Core emissive_scale did not reach 0.25× (${JSON.stringify(coreEnd.emissive)})`);
    }
    if (!ringEnd || ringEnd.emissive.reduce((sum, value) => sum + value, 0) > 2e-3) {
      emissiveFailures.push('step emissive_scale did not reach zero on Ring');
    }
    if (!coreRestored || !arraysClose(coreRestored.emissive, coreRestored.original, 2e-3)) {
      emissiveFailures.push('Core emissive was not restored after switching to a clip without emissive tracks');
    }
    if (!ringRestored || !arraysClose(ringRestored.emissive, ringRestored.original, 2e-3)) {
      emissiveFailures.push('Ring emissive was not restored after switching to a clip without emissive tracks');
    }
    if (emissive.selectValue !== String(emissive.clearIndex)) emissiveFailures.push('UI select did not follow the emissive clip switch');

    summary.emissive = {
      pass: emissiveFailures.length === 0,
      failures: emissiveFailures,
      probeIndex: emissive.probeIndex,
      clearIndex: emissive.clearIndex,
      coreStart: coreStart?.emissive || null,
      coreEnd: coreEnd?.emissive || null,
      ringEnd: ringEnd?.emissive || null,
      coreRestored: coreRestored?.emissive || null,
      ringRestored: ringRestored?.emissive || null,
    };

    const reloaded = await evaluate(cdp, `(async () => {
      const api = window.__GLB_VIEWER__;
      await api.loadNeonAnimations(${JSON.stringify(DRONE_ANIMS)});
      return { state: api.getState(), anim: api.getAnimationState() };
    })()`);
    if (!reloaded.state.neonAnimationClips.includes('destroy')) sidecarFailureList.push('real drone library did not reload after the probe');

    summary.sidecarAnimations = {
      clips: clipNames,
      missingExpectedClips,
      targetIndex,
      targetName,
      state: sidecarLoad.state,
      ui: sidecarLoad.ui,
      selected: {
        index: selected.anim.index,
        name: selected.anim.clips?.[selected.anim.index]?.name || null,
        playing: selected.anim.playing,
        duration: selected.anim.duration,
        selectValue: selected.ui.selectValue,
        selectText: selected.ui.selectText,
        targets: selected.probe?.targets?.length || 0,
        changed: selected.probe?.targets?.some(transformChanged) || false,
      },
      pass: sidecarFailureList.length === 0,
      failures: sidecarFailureList,
    };

    // Local file path: dropping the GLB and .anims.json together must attach.
    await evaluate(cdp, `(async () => {
      const transfer = new DataTransfer();
      for (const path of [${JSON.stringify(DRONE_MODEL)}, ${JSON.stringify(DRONE_ANIMS)}]) {
        const response = await fetch(path);
        const blob = await response.blob();
        transfer.items.add(new File([blob], path.split('/').pop()));
      }
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      return true;
    })()`);
    let localSidecarState = null;
    const localSidecarDeadline = Date.now() + 25000;
    while (Date.now() < localSidecarDeadline) {
      localSidecarState = await evaluate(cdp, 'window.__GLB_VIEWER__.getState()', { awaitPromise: false });
      if (!localSidecarState.loading
        && localSidecarState.modelName === 'drone_mk2.glb'
        && localSidecarState.neonAnimationClips?.length) break;
      await sleep(150);
    }
    await waitForPaint(cdp);
    const localSidecarFailures = [];
    if (!localSidecarState?.neonAnimationClips?.includes('destroy')) localSidecarFailures.push('dropped .anims.json was not attached');
    if (localSidecarState?.animationSource !== 'neon') localSidecarFailures.push('dropped sidecar source is not neon');
    if (localSidecarState?.errors?.length) localSidecarFailures.push(`errors: ${localSidecarState.errors.join(' / ')}`);
    summary.localSidecar = {
      state: localSidecarState ? {
        modelName: localSidecarState.modelName,
        neonAnimationClips: localSidecarState.neonAnimationClips,
        animationSource: localSidecarState.animationSource,
        errors: localSidecarState.errors,
      } : null,
      pass: localSidecarFailures.length === 0,
      failures: localSidecarFailures,
    };

    // Embedded glTF clips and NEON sidecar clips must share one dropdown.
    const mixed = await evaluate(cdp, `(async () => {
      const api = window.__GLB_VIEWER__;
      await api.loadModel('samples/Fox.gltf');
      await api.loadNeonAnimations({
        schema: 1,
        asset: 'fox.test',
        clips: [{
          name: 'head_nod',
          duration: 1,
          looping: true,
          tracks: [{
            node: 'b_Head_05',
            property: 'rotation_euler_deg',
            interpolation: 'smooth',
            keys: [{ t: 0, value: [0, 0, 0] }, { t: 1, value: [0, 0, 35] }],
          }],
        }],
      });
      const state = api.getState();
      const clips = state.animationClips;
      const gltfIndex = clips.indexOf('Walk');
      const neonIndex = clips.indexOf('head_nod');
      api.selectAnimationClip(gltfIndex);
      const gltfState = api.getState();
      api.selectAnimationClip(neonIndex);
      api.setAnimationPlaying(false);
      api.seekAnimation(1);
      const neonState = api.getState();
      const probe = api.getAnimationProbe();
      const select = document.getElementById('anim-clip');
      return {
        clips,
        gltfIndex,
        neonIndex,
        gltfState,
        neonState,
        probe,
        neonSelectValue: select.value,
        neonSelectText: select.selectedOptions[0]?.textContent || '',
        options: Array.from(select.options).map((option) => option.textContent),
        source: document.getElementById('anim-source').textContent,
      };
    })()`);
    await waitForPaint(cdp);
    summary.screenshots.push((await screenshot(cdp, 'fox-gltf-neon-mixed.png')).replaceAll('\\', '/'));
    const mixedBack = await evaluate(cdp, `(() => {
      const api = window.__GLB_VIEWER__;
      api.selectAnimationClip(${mixed.gltfIndex});
      return api.getState();
    })()`, { awaitPromise: false });

    const mixedFailures = [];
    if (mixed.clips.length !== 4) mixedFailures.push(`expected 4 combined clips, got ${mixed.clips.length}`);
    if (mixed.gltfIndex < 0 || mixed.neonIndex < 0) mixedFailures.push('Walk or head_nod is missing from the combined dropdown');
    if (mixed.gltfState.activeClipSource !== 'gltf') mixedFailures.push('embedded Walk clip was not selectable');
    if (mixed.neonState.activeClipSource !== 'neon') mixedFailures.push('sidecar head_nod clip was not selectable');
    if (mixed.neonState.animationSource !== 'mixed') mixedFailures.push('animationSource is not mixed with both kinds loaded');
    if (mixed.neonState.activeClipIndex !== mixed.neonIndex) mixedFailures.push('activeClipIndex does not point at the sidecar clip');
    if (mixed.neonSelectValue !== String(mixed.neonIndex)) mixedFailures.push('dropdown value does not point at the sidecar clip');
    if (!/head_nod/.test(mixed.neonSelectText) || !/NEON/.test(mixed.neonSelectText)) mixedFailures.push('sidecar option lacks name/source text');
    if (!mixed.options.some((text) => /GLTF/.test(text))) mixedFailures.push('dropdown has no GLTF option labels');
    if (!mixed.options.some((text) => /NEON/.test(text))) mixedFailures.push('dropdown has no NEON option labels');
    if (!/GLTF \+ NEON/i.test(mixed.source)) mixedFailures.push('source line does not show GLTF + NEON');
    if (!mixed.probe?.targets?.some(transformChanged)) mixedFailures.push('sidecar clip did not move the Fox head bone');
    if (mixed.neonState.animationPlaying !== false) mixedFailures.push('mixed sidecar clip did not pause');
    if (mixedBack.activeClipSource !== 'gltf' || mixedBack.activeClip !== 'Walk') mixedFailures.push('could not switch back to the embedded Walk clip');
    summary.mixedAnimations = {
      pass: mixedFailures.length === 0,
      failures: mixedFailures,
      clips: mixed.clips,
      options: mixed.options,
      source: mixed.source,
      gltfIndex: mixed.gltfIndex,
      neonIndex: mixed.neonIndex,
      neonState: mixed.neonState,
      backClip: mixedBack.activeClip,
    };

    // Parser diagnostics: bad libraries must reject with a useful message and
    // must not replace the library that is already loaded.
    const validation = await evaluate(cdp, `(async () => {
      const api = window.__GLB_VIEWER__;
      const before = api.getState().neonAnimationClips;
      const attempt = async (library) => {
        try {
          await api.loadNeonAnimations(library);
          return 'NO ERROR';
        } catch (error) {
          return error?.message || String(error);
        }
      };
      const track = { node: 'Core', property: 'scale', keys: [{ t: 0, value: [1, 1, 1] }] };
      const duplicate = await attempt({ schema: 1, asset: 'x', clips: [
        { name: 'same', duration: 1, tracks: [track] },
        { name: 'same', duration: 1, tracks: [track] },
      ] });
      const unknown = await attempt({ schema: 1, asset: 'x', clips: [
        { name: 'bad', duration: 1, tracks: [{ node: 'Core', property: 'color', keys: [{ t: 0, value: [1, 1, 1] }] }] },
      ] });
      const missing = await attempt({ schema: 1, asset: 'x', clips: [
        { name: 'missing', duration: 1, tracks: [{ node: 'NoSuchNode', property: 'scale', keys: [{ t: 0, value: [1, 1, 1] }] }] },
      ] });
      const late = await attempt({ schema: 1, asset: 'x', clips: [
        { name: 'late', duration: 1, tracks: [{ node: 'Core', property: 'scale', keys: [
          { t: 0, value: [1, 1, 1] }, { t: 2, value: [1, 1, 1] },
        ] }] },
      ] });
      const duration = await attempt({ schema: 1, asset: 'x', clips: [
        { name: 'dur', duration: 0, tracks: [track] },
      ] });
      return { before, after: api.getState().neonAnimationClips, duplicate, unknown, missing, late, duration };
    })()`);

    const validationFailures = [];
    if (!/duplicate clip/i.test(validation.duplicate)) validationFailures.push(`duplicate clip message was: ${validation.duplicate}`);
    if (!/unknown property/i.test(validation.unknown)) validationFailures.push(`unknown property message was: ${validation.unknown}`);
    if (!/NoSuchNode/.test(validation.missing) || !/not found/i.test(validation.missing)) validationFailures.push(`missing node message was: ${validation.missing}`);
    if (!/exceeds the clip duration/i.test(validation.late)) validationFailures.push(`late key message was: ${validation.late}`);
    if (!/positive number/i.test(validation.duration)) validationFailures.push(`duration message was: ${validation.duration}`);
    if (JSON.stringify(validation.before) !== JSON.stringify(validation.after)) validationFailures.push('failed loads replaced the active clip library');
    summary.validation = {
      pass: validationFailures.length === 0,
      failures: validationFailures,
      messages: {
        duplicate: validation.duplicate,
        unknown: validation.unknown,
        missing: validation.missing,
        late: validation.late,
        duration: validation.duration,
      },
    };

    // Deep link: ?model=...&anims=... must attach the sidecar before ready.
    const deepLinkLoaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', {
      url: `${BASE_URL}/?model=${encodeURIComponent(DRONE_MODEL)}&anims=${encodeURIComponent(DRONE_ANIMS)}`,
    });
    await deepLinkLoaded;
    try {
      await waitForViewerReady(cdp, 12000);
    } catch {
      // Chromium occasionally reports ERR_CONNECTION_REFUSED on a navigation
      // while a previous page is still tearing down. One reload is enough.
      console.log('[smoke] deep link boot retry after transient navigation failure');
      const retryLoaded = cdp.waitForEvent('Page.loadEventFired');
      await cdp.send('Page.reload', { ignoreCache: true });
      await retryLoaded;
      await waitForViewerReady(cdp);
    }
    let deepState = null;
    const deepDeadline = Date.now() + 20000;
    while (Date.now() < deepDeadline) {
      deepState = await evaluate(cdp, 'window.__GLB_VIEWER__.getState()', { awaitPromise: false });
      if (!deepState.loading && deepState.modelName) break;
      await sleep(150);
    }
    await waitForPaint(cdp);
    const deepUI = await evaluate(cdp, `(() => ({
      emptyHidden: document.getElementById('empty-state').hidden,
      errorHidden: document.getElementById('error-state').hidden,
      source: document.getElementById('anim-source').textContent,
      animationVisible: !document.getElementById('animation-section').hidden,
    }))()`, { awaitPromise: false });
    const deepFailures = [];
    if (!deepState) deepFailures.push('deep link state was unavailable');
    if (deepState && !deepState.neonAnimationClips?.includes('destroy')) deepFailures.push('?anims= did not attach the drone library');
    if (deepState?.animationSource !== 'neon') deepFailures.push('?anims= animationSource is not neon');
    if (!deepUI.animationVisible) deepFailures.push('?anims= animation panel is hidden');
    if (!/NEON ANIMS/i.test(deepUI.source)) deepFailures.push('?anims= source line does not mention NEON ANIMS');
    if (!deepUI.emptyHidden || !deepUI.errorHidden) deepFailures.push('?anims= left empty/error overlay visible');
    summary.neonDeepLink = {
      state: deepState ? {
        modelName: deepState.modelName,
        neonAnimationClips: deepState.neonAnimationClips,
        animationSource: deepState.animationSource,
        activeClip: deepState.activeClip,
      } : null,
      ui: deepUI,
      pass: deepFailures.length === 0,
      failures: deepFailures,
    };
    summary.screenshots.push((await screenshot(cdp, 'query-param-drone-anims.png')).replaceAll('\\', '/'));

    await waitForPaint(cdp);
    summary.consoleErrors = cdp.consoleErrors;
    summary.consoleWarnings = cdp.consoleWarnings;

    const failedSamples = summary.samples.filter((sample) => !sample.pass);
    const failures = [];
    if (failedSamples.length) failures.push(`${failedSamples.length} sample(s) failed`);
    if (!summary.screenshotApi.pass) failures.push('screenshot API did not return a PNG');
    if (summary.responsive.failure) failures.push(summary.responsive.failure);
    if (!summary.localFile.pass) failures.push(...summary.localFile.failures.map((failure) => `local file: ${failure}`));
    if (!summary.interactions.pass) failures.push(...summary.interactions.failures.map((failure) => `interaction: ${failure}`));
    if (!summary.sidecarAnimations.pass) failures.push(...summary.sidecarAnimations.failures.map((failure) => `sidecar: ${failure}`));
    if (!summary.localSidecar.pass) failures.push(...summary.localSidecar.failures.map((failure) => `local sidecar: ${failure}`));
    if (!summary.emissive.pass) failures.push(...summary.emissive.failures.map((failure) => `emissive: ${failure}`));
    if (!summary.mixedAnimations.pass) failures.push(...summary.mixedAnimations.failures.map((failure) => `mixed: ${failure}`));
    if (!summary.validation.pass) failures.push(...summary.validation.failures.map((failure) => `validation: ${failure}`));
    if (!summary.neonDeepLink.pass) failures.push(...summary.neonDeepLink.failures.map((failure) => `deep link: ${failure}`));
    if (summary.consoleErrors.length) failures.push(`${summary.consoleErrors.length} console/page error(s)`);
    summary.failures = failures;
    summary.pass = failures.length === 0;
    exitCode = summary.pass ? 0 : 1;
  } catch (error) {
    summary.error = error.stack || error.message;
    summary.consoleErrors = cdp?.consoleErrors || [];
    summary.consoleWarnings = cdp?.consoleWarnings || [];
    console.error(`[smoke] FAILED: ${error.message}`);
    exitCode = 1;
  } finally {
    summary.finishedAt = new Date().toISOString();
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    cdp?.close();
    await sleep(300);
    if (!edge.killed) edge.kill();
    console.log(JSON.stringify({
      pass: summary.pass,
      samples: summary.samples.map((sample) => ({
        id: sample.id,
        model: sample.state?.modelName,
        meshes: sample.state?.meshCount,
        triangles: sample.state?.triangleCount,
        animations: sample.state?.animationClips,
        viewHintUsed: sample.state?.neonRange?.viewHintUsed ?? null,
        pass: sample.pass,
        failures: sample.failures,
      })),
      screenshotApi: summary.screenshotApi,
      responsive: summary.responsive,
      queryParam: summary.queryParam ? {
        model: summary.queryParam.state?.modelName,
        loading: summary.queryParam.state?.loading,
        errors: summary.queryParam.state?.errors,
        failure: summary.queryParam.failure || null,
      } : null,
      localFile: summary.localFile ? {
        model: summary.localFile.state?.modelName,
        triangles: summary.localFile.state?.triangleCount,
        textures: summary.localFile.state?.textureCount,
        clips: summary.localFile.state?.animationClips,
        pass: summary.localFile.pass,
        failures: summary.localFile.failures,
      } : null,
      interactions: summary.interactions ? {
        pass: summary.interactions.pass,
        failures: summary.interactions.failures,
        details: summary.interactions,
      } : null,
      sidecarAnimations: summary.sidecarAnimations ? {
        clips: summary.sidecarAnimations.clips,
        missingExpectedClips: summary.sidecarAnimations.missingExpectedClips,
        target: summary.sidecarAnimations.targetName,
        selected: summary.sidecarAnimations.selected,
        pass: summary.sidecarAnimations.pass,
        failures: summary.sidecarAnimations.failures,
      } : null,
      clampedSidecar: summary.clampedSidecar || null,
      localSidecar: summary.localSidecar ? {
        pass: summary.localSidecar.pass,
        failures: summary.localSidecar.failures,
        state: summary.localSidecar.state,
      } : null,
      emissive: summary.emissive ? {
        pass: summary.emissive.pass,
        failures: summary.emissive.failures,
        coreStart: summary.emissive.coreStart,
        coreEnd: summary.emissive.coreEnd,
        ringEnd: summary.emissive.ringEnd,
        coreRestored: summary.emissive.coreRestored,
      } : null,
      mixedAnimations: summary.mixedAnimations ? {
        pass: summary.mixedAnimations.pass,
        failures: summary.mixedAnimations.failures,
        clips: summary.mixedAnimations.clips,
        source: summary.mixedAnimations.source,
        backClip: summary.mixedAnimations.backClip,
      } : null,
      validation: summary.validation ? {
        pass: summary.validation.pass,
        failures: summary.validation.failures,
        messages: summary.validation.messages,
      } : null,
      neonDeepLink: summary.neonDeepLink ? {
        state: summary.neonDeepLink.state,
        pass: summary.neonDeepLink.pass,
        failures: summary.neonDeepLink.failures,
      } : null,
      consoleErrors: summary.consoleErrors,
      consoleWarnings: summary.consoleWarnings,
      screenshots: summary.screenshots,
      report: REPORT_PATH,
      passOverall: summary.pass,
      error: summary.error,
    }, null, 2));
  }
  return exitCode;
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
