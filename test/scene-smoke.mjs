#!/usr/bin/env node
/**
 * Headless Edge + CDP smoke test for the read-only NEON RANGE scene/UI inspector.
 *
 * Usage (with serve.py already running, e.g. on 127.0.0.1:8126):
 *   node test/scene-smoke.mjs
 *
 * Optional:
 *   BASE_URL=http://127.0.0.1:8126
 *   EDGE_PATH="C:\path\to\msedge.exe"
 *
 * The test prefers the real pack at /project-assets/scenes/range.scene.json and
 * falls back to samples/neon/scenes/range.scene.json when it is not available.
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8126';
const SCENE_SOURCE = process.env.SCENE_SOURCE || 'auto';
const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
const EDGE_PATH = EDGE_CANDIDATES.find((candidate) => existsSync(candidate)) || EDGE_CANDIDATES[0];
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SCREENSHOT_DIR = path.join(ROOT, 'screenshots');
const PROFILE_DIR = path.join(ROOT, 'test', '.edge-scene-profile');
const REPORT_PATH = path.join(ROOT, 'test', 'scene-smoke-report.json');

/** Report paths relative to the checkout so reports carry no local absolute paths. */
function repoRelative(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  waitForEvent(method, timeout = 30000) {
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

async function waitForHttp(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      await response.arrayBuffer();
      if (response.ok) return response;
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

async function waitForViewerReady(cdp, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ready = await evaluate(cdp, 'Boolean(window.__GLB_VIEWER__ && window.__GLB_VIEWER__.ready)', { awaitPromise: false });
    if (ready) return;
    await sleep(150);
  }
  throw new Error('window.__GLB_VIEWER__.ready did not become true');
}

async function waitForScene(cdp, timeout = 150000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, 'window.__GLB_VIEWER__ ? window.__GLB_VIEWER__.getState() : null', { awaitPromise: false });
    if (state) {
      last = state;
      if (state.scene && !state.scene.loading) {
        if (state.scene.ready || state.scene.errors.length) return state;
      }
    }
    await sleep(300);
  }
  throw new Error(`Scene did not become ready: ${JSON.stringify(last?.scene?.errors || last?.errors || null)}`);
}

async function waitForUi(cdp, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let last = null;
  while (Date.now() < deadline) {
    const state = await evaluate(cdp, 'window.__GLB_UI_PREVIEW__ ? window.__GLB_UI_PREVIEW__.getState() : null', { awaitPromise: false });
    if (state) {
      last = state;
      if (!state.loading && (state.ready || state.errors.length)) return state;
    }
    await sleep(200);
  }
  throw new Error(`UI preview did not become ready: ${JSON.stringify(last?.errors || null)}`);
}

async function waitForPaint(cdp, delay = 900) {
  await evaluate(cdp, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await sleep(delay);
}

async function screenshot(cdp, filename) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const destination = path.join(SCREENSHOT_DIR, filename);
  await fs.writeFile(destination, Buffer.from(result.data, 'base64'));
  return repoRelative(destination);
}

async function writeDataUrl(filename, dataUrl) {
  const separator = dataUrl.indexOf(',');
  if (separator === -1) throw new Error('Screenshot API did not return a data URL');
  const destination = path.join(SCREENSHOT_DIR, filename);
  await fs.writeFile(destination, Buffer.from(dataUrl.slice(separator + 1), 'base64'));
  return repoRelative(destination);
}

async function tryJSON(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function requestStatus(url, options = {}) {
  try {
    const response = await fetch(url, { cache: 'no-store', ...options });
    await response.arrayBuffer();
    return {
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      allow: response.headers.get('allow'),
    };
  } catch (error) {
    return { error: error.message };
  }
}

/**
 * Node's fetch normalizes dot segments before sending, so use a raw request to
 * verify that the server itself rejects an encoded traversal attempt.
 */
function rawRequestStatus(baseUrl, rawPath, method = 'GET') {
  const target = new URL(baseUrl);
  return new Promise((resolve) => {
    const request = http.request(
      { hostname: target.hostname, port: target.port || 80, path: rawPath, method },
      (response) => {
        response.resume();
        response.on('end', () => resolve({
          status: response.statusCode,
          contentType: response.headers['content-type'],
        }));
      },
    );
    request.on('error', (error) => resolve({ error: error.message }));
    request.end();
  });
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((entry) => Number(entry)) : null;
}

function closeEnough(actual, expected, tolerance = 0.05) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length < 3 || expected.length < 3) return false;
  return actual.slice(0, 3).every((value, index) => Math.abs(Number(value) - Number(expected[index])) <= tolerance);
}

async function chooseSceneSource(baseUrl) {
  const status = await tryJSON(`${baseUrl}/api/project-assets`);
  const candidates = [];

  if (SCENE_SOURCE !== 'fixture') {
    if (status?.available && status.scene && status.manifest) {
      candidates.push({
        kind: 'project-assets',
        scene: status.scene,
        manifest: status.manifest,
        note: 'real fps-demo/assets pack via /project-assets/',
      });
    }
    candidates.push({
      kind: 'project-assets',
      scene: '/project-assets/scenes/range.scene.json',
      manifest: '/project-assets/manifest.json',
      note: 'real fps-demo/assets pack via /project-assets/ (direct probe)',
    });
  }
  if (SCENE_SOURCE !== 'project') {
    candidates.push({
      kind: 'fixture',
      scene: '/samples/neon/scenes/range.scene.json',
      manifest: '/samples/neon/manifest.json',
      note: 'development fixture; real pack was not available',
    });
  }

  const attempts = [];
  for (const candidate of candidates) {
    if (candidate.kind === 'project-assets' && !status?.available && status) continue;
    const scene = await tryJSON(new URL(candidate.scene, baseUrl).href);
    const manifest = await tryJSON(new URL(candidate.manifest, baseUrl).href);
    if (scene && manifest) {
      return { ...candidate, sceneData: scene, manifestData: manifest, projectStatus: status, attempts };
    }
    attempts.push({ ...candidate, scene: Boolean(scene), manifest: Boolean(manifest) });
  }
  throw new Error(`No scene source could be loaded. Serve /project-assets/ or the fixture. Attempts: ${JSON.stringify(attempts)}`);
}

async function chooseUiSource(baseUrl, projectStatus) {
  const candidates = [];
  if (SCENE_SOURCE !== 'fixture' && projectStatus?.uiLayout) {
    candidates.push({ kind: 'project-assets', layout: projectStatus.uiLayout });
  }
  if (SCENE_SOURCE !== 'fixture') {
    candidates.push({ kind: 'project-assets', layout: '/project-assets/ui/layout.json' });
  }
  if (SCENE_SOURCE !== 'project') {
    candidates.push({ kind: 'fixture', layout: '/samples/neon/ui/layout.json' });
  }

  const attempts = [];
  for (const candidate of candidates) {
    if (candidate.kind === 'project-assets' && projectStatus && !projectStatus.available) continue;
    const layout = await tryJSON(new URL(candidate.layout, baseUrl).href);
    if (layout) return { ...candidate, layoutData: layout, attempts };
    attempts.push(candidate);
  }
  return { kind: 'none', layout: null, layoutData: null, attempts };
}

async function main() {
  if (!existsSync(EDGE_PATH)) throw new Error(`Microsoft Edge was not found at ${EDGE_PATH}`);
  try {
    const response = await fetch(BASE_URL, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    throw new Error(`Local server is not reachable at ${BASE_URL}. Start it with "python serve.py 8126". (${error.message})`);
  }

  await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
  await fs.rm(PROFILE_DIR, { recursive: true, force: true });
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const source = await chooseSceneSource(BASE_URL);
  const uiSource = await chooseUiSource(BASE_URL, source.projectStatus);
  const scene = source.sceneData;

  const props = Array.isArray(scene.props) ? scene.props : [];
  const targetSlots = Array.isArray(scene.target_slots) ? scene.target_slots : [];
  const lights = Array.isArray(scene.environment?.lights) ? scene.environment.lights : [];
  const camera = scene.environment?.camera || {};
  const envId = scene.environment?.static_model || null;
  const manifestIds = new Set(
    Array.isArray(source.manifestData?.assets)
      ? source.manifestData.assets.map((asset) => asset.id)
      : Object.keys(source.manifestData?.assets || {}),
  );
  const targetAssetSlots = targetSlots.filter((slot) => slot.asset && manifestIds.has(slot.asset));
  const expected = {
    environmentInstances: envId ? 1 : 0,
    propInstances: props.length,
    targetInstances: targetAssetSlots.length,
    instances: (envId ? 1 : 0) + props.length + targetAssetSlots.length,
    targetSlots: targetSlots.length,
    colliders: props.filter((prop) => prop.collider).length,
    lights: lights.length,
    camera: {
      position: normalizeArray(camera.position),
      target: normalizeArray(camera.target),
      fov: Number.isFinite(Number(camera.fov)) ? Number(camera.fov) : null,
    },
  };

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
    schema: 1,
    baseUrl: BASE_URL,
    startedAt: new Date().toISOString(),
    source: {
      kind: source.kind,
      scene: source.scene,
      manifest: source.manifest,
      note: source.note,
      forced: SCENE_SOURCE,
      realPackAvailable: Boolean(source.projectStatus?.available),
      attempts: source.attempts,
    },
    expected,
    scene: null,
    ui: null,
    routes: null,
    screenshots: [],
    consoleErrors: [],
    consoleWarnings: [],
    failures: [],
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

    /* ------------------------------------------------------------
       Scene inspector
       ------------------------------------------------------------ */

    const sceneUrl = new URL(source.scene, BASE_URL).href;
    const manifestUrl = new URL(source.manifest, BASE_URL).href;
    const loaded = cdp.waitForEvent('Page.loadEventFired');
    await cdp.send('Page.navigate', {
      url: `${BASE_URL}/?scene=${encodeURIComponent(source.scene)}&manifest=${encodeURIComponent(source.manifest)}`,
    });
    await loaded;
    await waitForViewerReady(cdp);
    const viewerState = await waitForScene(cdp);
    await waitForPaint(cdp, 1200);

    const sceneState = viewerState.scene;
    const sceneFailures = [];
    if (!sceneState) throw new Error('Scene state is missing from window.__GLB_VIEWER__.getState()');
    if (!sceneState.ready) sceneFailures.push(`scene.ready is false: ${sceneState.errors.join(' / ')}`);
    if (sceneState.errors.length) sceneFailures.push(`scene errors: ${sceneState.errors.join(' / ')}`);
    const counts = sceneState.counts || {};
    if (counts.environmentInstances !== expected.environmentInstances) {
      sceneFailures.push(`environmentInstances ${counts.environmentInstances} !== ${expected.environmentInstances}`);
    }
    if (counts.propInstances !== expected.propInstances) {
      sceneFailures.push(`propInstances ${counts.propInstances} !== ${expected.propInstances}`);
    }
    if (counts.instances !== expected.instances) {
      sceneFailures.push(`instances ${counts.instances} !== ${expected.instances}`);
    }
    if (counts.targetInstances !== expected.targetInstances) {
      sceneFailures.push(`targetInstances ${counts.targetInstances} !== ${expected.targetInstances}`);
    }
    if (counts.targetSlots !== expected.targetSlots) {
      sceneFailures.push(`targetSlots ${counts.targetSlots} !== ${expected.targetSlots}`);
    }
    if (counts.colliders !== expected.colliders) {
      sceneFailures.push(`colliders ${counts.colliders} !== ${expected.colliders}`);
    }
    if (counts.lights !== expected.lights) {
      sceneFailures.push(`lights ${counts.lights} !== ${expected.lights}`);
    }
    if (counts.triangles < 1000) sceneFailures.push(`triangle count ${counts.triangles} looks empty`);
    if (!sceneState.bounds || sceneState.bounds.empty) {
      sceneFailures.push('scene bounds are empty');
    } else if (!(sceneState.bounds.size[0] > 5)) {
      sceneFailures.push(`scene bounds unexpectedly small: ${sceneState.bounds.size.join(' × ')}`);
    }
    if (expected.camera.position && !closeEnough(sceneState.camera?.position, expected.camera.position)) {
      sceneFailures.push(`camera position ${JSON.stringify(sceneState.camera?.position)} !== ${JSON.stringify(expected.camera.position)}`);
    }
    if (expected.camera.target && !closeEnough(sceneState.camera?.target, expected.camera.target)) {
      sceneFailures.push(`camera target ${JSON.stringify(sceneState.camera?.target)} !== ${JSON.stringify(expected.camera.target)}`);
    }
    if (expected.camera.fov !== null && Math.abs(Number(sceneState.camera?.fov) - expected.camera.fov) > 0.1) {
      sceneFailures.push(`camera fov ${sceneState.camera?.fov} !== ${expected.camera.fov}`);
    }
    if (sceneState.instances.length !== expected.instances) {
      sceneFailures.push(`instance records ${sceneState.instances.length} !== ${expected.instances}`);
    }
    if (sceneState.targetSlots.length !== expected.targetSlots) {
      sceneFailures.push(`slot records ${sceneState.targetSlots.length} !== ${expected.targetSlots}`);
    }
    const loadedTargetSlots = sceneState.targetSlots.filter((slot) => slot.loaded).length;
    if (loadedTargetSlots !== expected.targetInstances) {
      sceneFailures.push(`loaded target slots ${loadedTargetSlots} !== ${expected.targetInstances}`);
    }
    if (sceneState.colliders.length !== expected.colliders) {
      sceneFailures.push(`collider records ${sceneState.colliders.length} !== ${expected.colliders}`);
    }
    if (sceneState.post && sceneState.post.bloom > 0 && !sceneState.post.mounted) {
      sceneFailures.push('bloom is configured but the post-processing composer was not mounted');
    }

    const sceneDom = await evaluate(cdp, `(() => {
      const hud = document.getElementById('scene-hud');
      return {
        sceneSectionVisible: !document.getElementById('scene-section').hidden,
        sceneId: document.getElementById('scene-id').textContent,
        sceneInstances: document.getElementById('scene-instances').textContent,
        sceneTargets: document.getElementById('scene-targets').textContent,
        sceneColliders: document.getElementById('scene-colliders').textContent,
        sceneBounds: document.getElementById('scene-bounds').textContent,
        scenePost: document.getElementById('scene-post').textContent,
        hudVisible: !hud.hidden && getComputedStyle(hud).display !== 'none',
        hudInstances: document.getElementById('scene-hud-instances').textContent,
        hierarchyRows: document.querySelectorAll('#hierarchy-tree .tree-row').length,
        materialRows: document.querySelectorAll('#materials-list .material-row').length,
        loadingHidden: document.getElementById('loading-overlay').hidden,
        errorHidden: document.getElementById('error-state').hidden,
        emptyHidden: document.getElementById('empty-state').hidden,
        stageName: document.getElementById('stage-model-name').textContent,
        w: document.getElementById('viewport').clientWidth,
        h: document.getElementById('viewport').clientHeight,
      };
    })()`, { awaitPromise: false });
    if (!sceneDom.sceneSectionVisible) sceneFailures.push('scene summary panel is hidden');
    if (sceneDom.sceneId !== sceneState.sceneId) sceneFailures.push(`scene summary id ${sceneDom.sceneId} !== ${sceneState.sceneId}`);
    if (Number(sceneDom.sceneInstances.replaceAll(',', '')) !== expected.instances) {
      sceneFailures.push(`summary instances ${sceneDom.sceneInstances} !== ${expected.instances}`);
    }
    if (!sceneDom.hudVisible) sceneFailures.push('scene HUD overlay is hidden');
    if (sceneDom.hierarchyRows < 10) sceneFailures.push(`hierarchy rows ${sceneDom.hierarchyRows} < 10`);
    if (sceneDom.materialRows < 1) sceneFailures.push('material list is empty');
    if (!sceneDom.loadingHidden) sceneFailures.push('loading overlay still visible');
    if (!sceneDom.errorHidden) sceneFailures.push('error overlay visible after a successful scene load');
    if (!sceneDom.emptyHidden) sceneFailures.push('empty state still visible in scene mode');

    const sceneScreenshot = await screenshot(cdp, 'scene-range.png');
    summary.screenshots.push(sceneScreenshot.replaceAll('\\', '/'));
    const viewportData = await evaluate(cdp, 'window.__GLB_VIEWER__.screenshot()', { awaitPromise: false });
    const viewportScreenshot = await writeDataUrl('scene-range-viewport.png', viewportData);
    summary.screenshots.push(viewportScreenshot.replaceAll('\\', '/'));

    const interactions = await evaluate(cdp, `(() => {
      const rows = document.querySelectorAll('#hierarchy-tree .tree-row');
      (rows[2] || rows[0])?.click();
      const selected = document.getElementById('metric-selected').textContent;
      const selectionVisible = !document.getElementById('selection-section').hidden;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      const cleared = document.getElementById('metric-selected').textContent === '—';
      const bounds = document.getElementById('toggle-bounds');
      bounds.click();
      const boundsOn = bounds.getAttribute('aria-checked') === 'true';
      bounds.click();
      const boundsOff = bounds.getAttribute('aria-checked') === 'false';
      document.getElementById('btn-stage-frame').click();
      return { selected, selectionVisible, cleared, boundsOn, boundsOff };
    })()`, { awaitPromise: false });
    if (!interactions.selected || interactions.selected === '—') sceneFailures.push('scene hierarchy selection did not update the status bar');
    if (!interactions.selectionVisible) sceneFailures.push('scene selection inspector did not appear');
    if (!interactions.cleared) sceneFailures.push('Escape did not clear the scene selection');
    if (!interactions.boundsOn || !interactions.boundsOff) sceneFailures.push('scene bounding-box toggle did not toggle');

    summary.scene = {
      url: sceneUrl,
      manifestUrl,
      state: sceneState,
      dom: sceneDom,
      interactions,
      screenshot: sceneScreenshot.replaceAll('\\', '/'),
      viewportScreenshot: viewportScreenshot.replaceAll('\\', '/'),
      pass: sceneFailures.length === 0,
      failures: sceneFailures,
    };

    /* ------------------------------------------------------------
       Read-only route checks
       ------------------------------------------------------------ */

    const routes = {
      status: await requestStatus(`${BASE_URL}/api/project-assets`),
      manifest: await requestStatus(`${BASE_URL}/project-assets/manifest.json`),
      scene: await requestStatus(`${BASE_URL}/project-assets/scenes/range.scene.json`),
      write: await requestStatus(`${BASE_URL}/project-assets/manifest.json`, { method: 'POST' }),
      traversal: await rawRequestStatus(BASE_URL, '/project-assets/%2e%2e/serve.py'),
    };
    const routeFailures = [];
    if (routes.status.status !== 200) routeFailures.push(`status endpoint ${routes.status.status || routes.status.error}`);
    if (routes.manifest.status !== 200) routeFailures.push(`manifest route ${routes.manifest.status || routes.manifest.error}`);
    if (routes.scene.status !== 200) routeFailures.push(`scene route ${routes.scene.status || routes.scene.error}`);
    if (routes.write.status !== 405) routeFailures.push(`POST should be 405, got ${routes.write.status || routes.write.error}`);
    if (routes.traversal.status === 200) routeFailures.push('path traversal unexpectedly returned 200');
    summary.routes = { ...routes, pass: routeFailures.length === 0, failures: routeFailures };

    /* ------------------------------------------------------------
       Coarse UI preview
       ------------------------------------------------------------ */

    let uiFailures = [];
    let uiState = null;
    let uiScreenshots = [];
    if (!uiSource.layout) {
      uiFailures.push('no UI layout.json available (project or fixture)');
    } else {
      const uiLoaded = cdp.waitForEvent('Page.loadEventFired');
      await cdp.send('Page.navigate', { url: `${BASE_URL}/?ui=${encodeURIComponent(uiSource.layout)}` });
      await uiLoaded;
      await waitForViewerReady(cdp);
      uiState = await waitForUi(cdp);
      await waitForPaint(cdp, 700);

      if (!uiState.ready) uiFailures.push(`ui.ready is false: ${uiState.errors.join(' / ')}`);
      if (uiState.errors.length) uiFailures.push(`ui errors: ${uiState.errors.join(' / ')}`);
      if (!uiState.screens.length) uiFailures.push('UI layout produced no screens');
      if (uiState.totalNodes < 10) uiFailures.push(`UI preview only rendered ${uiState.totalNodes} nodes`);
      if (uiState.boundNodes < 1) uiFailures.push('UI preview did not resolve any bindings');

      const uiDom = await evaluate(cdp, `(() => {
        const preview = document.getElementById('ui-preview');
        const root = document.getElementById('ui-preview-root');
        return {
          previewVisible: !preview.hidden && getComputedStyle(preview).display !== 'none',
          uiSectionVisible: !document.getElementById('ui-section').hidden,
          nodeCount: root.querySelectorAll('.ui-node').length,
          text: root.innerText.slice(0, 600),
          layoutPath: document.getElementById('ui-layout-path').textContent,
          errorHidden: document.getElementById('error-state').hidden,
          pageOverflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
          frame: (() => {
            const stage = document.getElementById('ui-preview-stage').getBoundingClientRect();
            const frame = document.getElementById('ui-preview-frame').getBoundingClientRect();
            return { stage: { x: stage.x, y: stage.y, w: stage.width, h: stage.height }, frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height } };
          })(),
        };
      })()`, { awaitPromise: false });
      if (!uiDom.previewVisible) uiFailures.push('UI preview layer is hidden');
      if (!uiDom.uiSectionVisible) uiFailures.push('UI summary panel is hidden');
      if (uiDom.nodeCount < 10) uiFailures.push(`UI DOM only has ${uiDom.nodeCount} nodes`);
      if (uiDom.text.trim().length < 10) uiFailures.push('UI DOM text is empty');
      if (!uiDom.errorHidden) uiFailures.push('error overlay visible after a successful UI load');
      if (uiDom.pageOverflow) uiFailures.push('UI preview causes page overflow');

      const sizes = [];
      for (const [key, filename] of [
        ['1600x900', 'ui-preview-1600.png'],
        ['2400x1350', 'ui-preview-2400.png'],
        ['900', 'ui-preview-900.png'],
      ]) {
        const sizeState = await evaluate(cdp, `window.__GLB_UI_PREVIEW__.setSize(${JSON.stringify(key)})`, { awaitPromise: false });
        await waitForPaint(cdp, 450);
        const fit = await evaluate(cdp, `(() => {
          const stage = document.getElementById('ui-preview-stage').getBoundingClientRect();
          const frame = document.getElementById('ui-preview-frame').getBoundingClientRect();
          const root = document.getElementById('ui-preview-root');
          return {
            target: window.__GLB_UI_PREVIEW__.getState().target,
            stage: { w: stage.width, h: stage.height },
            frame: { x: frame.x, y: frame.y, w: frame.width, h: frame.height },
            rootTransform: getComputedStyle(root).transform,
            overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
          };
        })()`, { awaitPromise: false });
        const expectedSize = key === '900' ? { width: 900, height: 506 } : key === '2400x1350' ? { width: 2400, height: 1350 } : { width: 1600, height: 900 };
        const entry = { key, state: sizeState, fit, failures: [] };
        if (fit.target.width !== expectedSize.width || fit.target.height !== expectedSize.height) {
          entry.failures.push(`target ${fit.target.width}×${fit.target.height} !== ${expectedSize.width}×${expectedSize.height}`);
        }
        if (fit.frame.w > fit.stage.w + 2 || fit.frame.h > fit.stage.h + 2) {
          entry.failures.push(`frame ${fit.frame.w}×${fit.frame.h} overflows stage ${fit.stage.w}×${fit.stage.h}`);
        }
        if (fit.overflow) entry.failures.push('page overflow after resize');
        const path = await screenshot(cdp, filename);
        entry.screenshot = path.replaceAll('\\', '/');
        summary.screenshots.push(entry.screenshot);
        uiScreenshots.push(entry);
        if (entry.failures.length) uiFailures.push(...entry.failures.map((failure) => `${key}: ${failure}`));
      }

      // Return to the HUD at 1600×900, then exercise the menu/results tabs.
      await evaluate(cdp, 'window.__GLB_UI_PREVIEW__.setSize("1600x900")', { awaitPromise: false });
      const screenChecks = [];
      for (const screenId of uiState.screens.map((screen) => screen.id)) {
        const screenState = await evaluate(cdp, `window.__GLB_UI_PREVIEW__.setScreen(${JSON.stringify(screenId)})`, { awaitPromise: false });
        await waitForPaint(cdp, 350);
        const dom = await evaluate(cdp, `(() => ({
          active: document.querySelector('#ui-screen-tabs .active')?.dataset.uiScreen || null,
          nodes: document.querySelectorAll('#ui-preview-root .ui-node').length,
          text: document.getElementById('ui-preview-root').innerText.slice(0, 240),
          frameFits: (() => {
            const stage = document.getElementById('ui-preview-stage').getBoundingClientRect();
            const frame = document.getElementById('ui-preview-frame').getBoundingClientRect();
            return frame.width <= stage.width + 2 && frame.height <= stage.height + 2;
          })(),
        }))()`, { awaitPromise: false });
        const failures = [];
        if (screenState.activeScreen !== screenId) failures.push(`active screen ${screenState.activeScreen} !== ${screenId}`);
        if (dom.active !== screenId) failures.push(`inactive tab for ${screenId}`);
        if (dom.nodes < 3) failures.push(`too few nodes (${dom.nodes})`);
        if (!dom.frameFits) failures.push('frame does not fit the stage');
        screenChecks.push({ id: screenId, state: screenState, dom, failures });
        if (failures.length) uiFailures.push(...failures.map((failure) => `${screenId}: ${failure}`));
        if (screenId === 'menu' || screenId === 'results') {
          const path = await screenshot(cdp, `ui-preview-${screenId}.png`);
          summary.screenshots.push(path.replaceAll('\\', '/'));
        }
      }

      await evaluate(cdp, 'window.__GLB_UI_PREVIEW__.setScreen("hud")', { awaitPromise: false });
      await waitForPaint(cdp, 500);
      const uiScreenshot = await screenshot(cdp, 'scene-ui-preview.png');
      summary.screenshots.push(uiScreenshot.replaceAll('\\', '/'));

      summary.ui = {
        source: uiSource.kind,
        layout: uiSource.layout,
        state: uiState,
        dom: uiDom,
        sizes: uiScreenshots,
        screens: screenChecks,
        screenshot: uiScreenshot.replaceAll('\\', '/'),
        pass: uiFailures.length === 0,
        failures: uiFailures,
      };
    }

    summary.consoleErrors = cdp.consoleErrors;
    summary.consoleWarnings = cdp.consoleWarnings;

    const failures = [];
    if (!summary.scene.pass) failures.push(...summary.scene.failures.map((failure) => `scene: ${failure}`));
    if (!summary.routes.pass) failures.push(...summary.routes.failures.map((failure) => `route: ${failure}`));
    if (summary.ui && !summary.ui.pass) failures.push(...summary.ui.failures.map((failure) => `ui: ${failure}`));
    if (!summary.ui) failures.push('ui: preview was not tested');
    if (summary.consoleErrors.length) failures.push(`${summary.consoleErrors.length} console/page error(s)`);
    summary.failures = failures;
    summary.pass = failures.length === 0;
    exitCode = summary.pass ? 0 : 1;

    console.log(JSON.stringify({
      pass: summary.pass,
      source: summary.source.kind,
      realPackAvailable: summary.source.realPackAvailable,
      scene: {
        id: sceneState.sceneId,
        sceneUrl: source.scene,
        instances: counts.instances,
        assetsUsed: counts.assetsUsed,
        targetSlots: counts.targetSlots,
        colliders: counts.colliders,
        lights: counts.lights,
        triangles: counts.triangles,
        pass: summary.scene.pass,
        failures: summary.scene.failures,
      },
      ui: summary.ui ? {
        layout: uiSource.layout,
        screens: uiState.screens.map((screen) => screen.id),
        nodes: uiState.totalNodes,
        boundNodes: uiState.boundNodes,
        pass: summary.ui.pass,
        failures: summary.ui.failures,
      } : null,
      routes: summary.routes,
      consoleErrors: summary.consoleErrors,
      consoleWarnings: summary.consoleWarnings,
      screenshots: summary.screenshots,
      failures,
      report: REPORT_PATH,
    }, null, 2));
  } catch (error) {
    summary.error = error.stack || error.message;
    summary.consoleErrors = cdp?.consoleErrors || [];
    summary.consoleWarnings = cdp?.consoleWarnings || [];
    summary.failures = [error.message];
    console.error(`[scene-smoke] FAILED: ${error.message}`);
    exitCode = 1;
  } finally {
    summary.finishedAt = new Date().toISOString();
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    cdp?.close();
    await sleep(300);
    if (!edge.killed) edge.kill();
  }
  return exitCode;
}

main().then((code) => process.exit(code ?? 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
