import { Viewer } from './viewer.js';
import { UI } from './ui.js';
import { ScenePreview } from './scene-preview.js';
import { UiPreview } from './ui-preview.js';
import { fileNameFromURL, fmtInt, truncateMiddle } from './format.js';

const ui = new UI();
const initialParams = new URLSearchParams(window.location.search);
const initialModel = initialParams.get('model');
const initialAnims = initialParams.get('anims');
const initialScene = initialParams.get('scene');
const initialManifest = initialParams.get('manifest');
const initialAssetBase = initialParams.get('asset_base') || initialParams.get('assetBase');
const initialUi = initialParams.get('ui');
const initialTheme = initialParams.get('theme');
const initialStrings = initialParams.get('strings');
const includeSceneTargets = initialParams.get('targets') !== '0';
const initialBloom = initialParams.get('bloom');
const backgroundMode = 'gradient';
const controlState = {
  wireframe: false,
  grid: true,
  axes: false,
  bounds: false,
  autoRotate: false,
  shadows: true,
};

let viewer = null;
let scenePreview = null;
let uiPreview = null;
let mode = initialScene ? 'scene' : initialUi ? 'ui' : 'viewer';
let currentInfo = null;
let stateErrors = [];
let busy = false;
let booted = false;
let resolveReady;
const readyPromise = new Promise((resolve) => { resolveReady = resolve; });

const FALLBACK_SAMPLES = {
  groups: [
    { id: 'neon-range', label: 'NEON RANGE' },
    { id: 'khronos', label: 'KHRONOS' },
  ],
  samples: [
    {
      id: 'range-arena',
      group: 'NEON RANGE',
      name: 'Range Arena',
      url: 'samples/neon/range_arena.glb',
      format: 'GLB',
      type: 'ENVIRONMENT',
      purpose: 'Closed neon training range; authored interior camera.',
    },
    {
      id: 'weapon-nr01',
      group: 'NEON RANGE',
      name: 'Weapon NR01',
      url: 'samples/neon/weapon_nr01.glb',
      format: 'GLB',
      type: 'VIEWMODEL',
      purpose: '21-part rifle view-model with muzzle anchor.',
    },
    {
      id: 'drone-mk2',
      group: 'NEON RANGE',
      name: 'Drone Mk2',
      url: 'samples/neon/drone_mk2.glb',
      anims: 'samples/neon/drone_mk2.anims.json',
      format: 'GLB',
      type: 'PROP',
      purpose: 'Hovering target drone with ring silhouette.',
    },
    {
      id: 'cover-crate',
      group: 'NEON RANGE',
      name: 'Cover Crate',
      url: 'samples/neon/cover_crate.glb',
      format: 'GLB',
      type: 'PROP',
      purpose: 'Modular cyan-trim crate; 48 triangles.',
    },
    {
      id: 'damaged-helmet',
      group: 'KHRONOS',
      name: 'Damaged Helmet',
      url: 'samples/DamagedHelmet.glb',
      format: 'GLB',
      type: 'TEXTURED',
      purpose: 'Battle-worn PBR helmet with full texture set.',
    },
    {
      id: 'fox',
      group: 'KHRONOS',
      name: 'Fox',
      url: 'samples/Fox.gltf',
      format: 'GLTF',
      type: 'ANIMATED',
      purpose: 'Skeletal rig with Survey, Walk and Run clips.',
    },
    {
      id: 'box-textured',
      group: 'KHRONOS',
      name: 'Box Textured',
      url: 'samples/BoxTextured.gltf',
      format: 'GLTF',
      type: 'MULTI-FILE',
      purpose: 'External .bin + PNG resource resolution test.',
    },
  ],
};

const axisElements = {
  x: { line: document.getElementById('gizmo-x'), dot: document.getElementById('gizmo-dot-x'), label: document.getElementById('gizmo-label-x') },
  y: { line: document.getElementById('gizmo-y'), dot: document.getElementById('gizmo-dot-y'), label: document.getElementById('gizmo-label-y') },
  z: { line: document.getElementById('gizmo-z'), dot: document.getElementById('gizmo-dot-z'), label: document.getElementById('gizmo-label-z') },
};

function guardViewer() {
  if (!viewer) {
    ui.toast({ kind: 'error', title: 'Renderer unavailable', message: 'WebGL could not start in this browser.' });
    return false;
  }
  return true;
}

function showLoadError(message) {
  ui.showError('Model load failed', message);
  ui.toast({ kind: 'error', title: 'Could not load model', message, timeout: 8000 });
}

function exitInspectorModes() {
  if (mode === 'scene') {
    scenePreview?.dispose();
    scenePreview = null;
    viewer?.setSceneMode(false);
    const hud = document.getElementById('scene-hud');
    if (hud) hud.hidden = true;
  } else if (mode === 'ui') {
    uiPreview?.dispose();
    uiPreview = null;
    const layer = document.getElementById('ui-preview');
    if (layer) layer.hidden = true;
  }
  mode = 'viewer';
  ui.setMode('viewer');
}

async function loadScene(sceneUrl, manifestUrl) {
  if (!viewer || !scenePreview) throw new Error('Scene preview is unavailable because WebGL did not start.');
  mode = 'scene';
  busy = true;
  stateErrors = [];
  ui.setMode('scene');
  ui.showLoading(`Loading ${truncateMiddle(fileNameFromURL(sceneUrl || 'scene.json'), 30)}`, 'Reading scene JSON…');
  ui.setHint('LOADING SCENE · MANIFEST + GLB COMPOSITION');
  try {
    const state = await scenePreview.load({
      sceneUrl,
      manifestUrl,
      assetBase: initialAssetBase,
      includeTargets: includeSceneTargets,
      bloomOverride: initialBloom === null ? null : Number(initialBloom),
    });
    const hud = document.getElementById('scene-hud');
    if (hud) hud.hidden = false;
    ui.setSceneSummary(state);
    ui.renderModelTree(viewer.model, {
      onSelect: (object) => viewer.select(object),
    });
    ui.renderModelMaterials(scenePreview.getMaterials(), {
      onSelectMaterial: (material) => {
        const mesh = material.meshes.find((candidate) => candidate.visible) || material.meshes[0];
        if (mesh) viewer.select(mesh);
      },
    });
    ui.setAnimationClips([]);
    ui.setNeonAnimSummary(null, 0);
    ui.setSelection(null);
    if (state.errors.length) {
      ui.toast({
        kind: 'error',
        title: 'Scene loaded with errors',
        message: state.errors.slice(0, 2).join(' · '),
        timeout: 9000,
      });
    } else if (state.warnings.length) {
      ui.toast({
        kind: 'warning',
        title: 'Scene loaded with warnings',
        message: state.warnings.slice(0, 2).join(' · '),
        timeout: 8000,
      });
    }
    return state;
  } catch (error) {
    const message = error?.message || 'The scene could not be loaded.';
    stateErrors = [message];
    ui.showError('Scene load failed', message);
    ui.toast({ kind: 'error', title: 'Could not load scene', message, timeout: 9000 });
    throw error;
  } finally {
    busy = false;
    ui.hideLoading();
  }
}

async function loadUiPreview(layoutUrl, themeUrl, stringsUrl) {
  if (!uiPreview) throw new Error('UI preview is unavailable.');
  mode = 'ui';
  busy = true;
  stateErrors = [];
  ui.setMode('ui');
  ui.showLoading('Loading UI preview', 'Reading theme, layout and strings…');
  ui.setHint('LOADING UI PREVIEW · DOM/CSS APPROXIMATION');
  try {
    const state = await uiPreview.load({ layoutUrl, themeUrl, stringsUrl });
    const layer = document.getElementById('ui-preview');
    if (layer) layer.hidden = false;
    uiPreview.layout();
    ui.setUiSummary(state, { layoutUrl });
    ui.setAnimationClips([]);
    ui.setNeonAnimSummary(null, 0);
    ui.renderModelTree(null);
    ui.renderModelMaterials([]);
    ui.setSelection(null);
    if (state.warnings.length) {
      ui.toast({
        kind: 'warning',
        title: 'UI preview loaded with warnings',
        message: state.warnings.slice(0, 2).join(' · '),
        timeout: 8000,
      });
    }
    return state;
  } catch (error) {
    const message = error?.message || 'The UI schema could not be loaded.';
    stateErrors = [message];
    ui.showError('UI preview failed', message);
    ui.toast({ kind: 'error', title: 'Could not load UI preview', message, timeout: 9000 });
    throw error;
  } finally {
    busy = false;
    ui.hideLoading();
  }
}

async function performLoad(loader, label) {
  exitInspectorModes();
  if (!guardViewer()) throw new Error('WebGL viewer is unavailable.');
  if (busy) {
    const message = 'A model is already loading. Wait for the current load to finish.';
    ui.toast({ kind: 'warning', title: 'Load in progress', message });
    throw new Error(message);
  }

  busy = true;
  stateErrors = [];
  ui.closeDrawers();
  ui.closeSamples();
  ui.showLoading(`Loading ${truncateMiddle(label || 'model', 30)}`, 'Opening asset stream…');
  ui.setHint('LOADING ASSET · PARSING glTF');
  try {
    const info = await loader();
    // Sidecar `.anims.json` clips are attached during loading, so the asset
    // header and ANIMS stat should reflect the combined clip list.
    const animationState = viewer.getAnimationState();
    info.animationCount = animationState.count;
    const neonClips = animationState.clips.filter((clip) => clip.source === 'neon');
    if (info.neonRange && neonClips.length) {
      info.neonRange = {
        ...info.neonRange,
        note: `Rest pose + ${neonClips.length} NEON sidecar clip${neonClips.length === 1 ? '' : 's'}: ${neonClips.map((clip) => clip.name).join(', ')}.`,
      };
    }
    currentInfo = info;
    ui.updateAsset(info);
    ui.renderModelTree(viewer.model, {
      onSelect: (object) => viewer.select(object),
      onVisibilityChange: () => {
        // The render loop keeps the selection helper in sync with effective visibility.
      },
    });
    ui.renderModelMaterials(info.materials, {
      onSelectMaterial: (material) => {
        const mesh = material.meshes.find((candidate) => candidate.visible) || material.meshes[0];
        if (mesh) viewer.select(mesh);
      },
    });
    refreshAnimationPanel();
    if (info.note) {
      ui.toast({ kind: 'info', title: 'Selection note', message: info.note, timeout: 6000 });
    }
    return info;
  } catch (error) {
    const message = error?.message || 'The asset could not be loaded.';
    stateErrors = [message];
    showLoadError(message);
    throw error;
  } finally {
    busy = false;
    ui.hideLoading();
  }
}

function refreshAnimationPanel() {
  if (!viewer) return null;
  const state = viewer.getAnimationState();
  ui.setAnimationClips(state.clips, { sourceLabel: state.sourceLabel, activeIndex: state.index });
  ui.updateAnimationState(state);
  ui.setNeonAnimSummary(
    viewer.neonLibrary?.label || null,
    state.clips.filter((clip) => clip.source === 'neon').length,
  );
  if (currentInfo && currentInfo.animationCount !== state.count) {
    currentInfo.animationCount = state.count;
    // Keep the asset card / ANIMS stat in sync when a library is attached
    // manually after the model has already been loaded.
    ui.updateAsset(currentInfo);
  }
  return state;
}

function loadModel(url, animsUrl = null) {
  if (!url) return Promise.reject(new Error('No model URL was provided.'));
  return performLoad(
    () => viewer.loadFromURL(url, { animsUrl: animsUrl || null }),
    fileNameFromURL(url),
  );
}

async function loadNeonAnimationsInput(input) {
  if (!guardViewer()) throw new Error('WebGL viewer is unavailable.');
  if (busy) {
    const message = 'Another asset is already loading. Wait for it to finish.';
    ui.toast({ kind: 'warning', title: 'Load in progress', message });
    throw new Error(message);
  }
  if (!viewer.model) {
    const message = 'Load a model before attaching a .anims.json library.';
    ui.toast({ kind: 'warning', title: 'No model loaded', message });
    throw new Error(message);
  }

  busy = true;
  try {
    let summary;
    if (typeof input === 'string') {
      summary = await viewer.loadNeonAnimationsFromURL(input);
    } else if (input instanceof File) {
      summary = await viewer.loadNeonAnimationsFromFile(input);
    } else if (input && typeof input === 'object') {
      summary = await viewer.loadNeonAnimations(input, { label: 'inline.anims.json' });
    } else {
      throw new Error('No animation library was provided.');
    }
    refreshAnimationPanel();
    return summary;
  } catch (error) {
    ui.toast({
      kind: 'error',
      title: 'Animation library failed',
      message: error?.message || 'The .anims.json library could not be loaded.',
      timeout: 9000,
    });
    throw error;
  } finally {
    busy = false;
  }
}

function modelLabelFromFiles(files) {
  const models = Array.from(files).filter((file) => /\.(glb|gltf)$/i.test(file.name || ''));
  return models.find((file) => /\.glb$/i.test(file.name))?.name || models[0]?.name || 'local asset';
}

function handleFiles(files) {
  if (!guardViewer()) return;
  if (busy) {
    ui.toast({ kind: 'warning', title: 'Load in progress', message: 'Wait for the current asset to finish loading.' });
    return;
  }
  const list = Array.from(files || []);
  const models = list.filter((file) => /\.(glb|gltf)$/i.test(file.name || ''));
  const anims = list.filter((file) => /\.anims\.json$/i.test(file.name || ''));
  if (!models.length) {
    if (anims.length && viewer?.model) {
      loadNeonAnimationsInput(anims[0]).catch(() => {});
      return;
    }
    if (anims.length) {
      ui.toast({
        kind: 'warning',
        title: 'No model loaded',
        message: 'Open a .glb/.gltf first, then drop the .anims.json library.',
      });
      return;
    }
    ui.toast({
      kind: 'warning',
      title: 'No model found',
      message: 'Drop a .glb or .gltf file. Include its .bin, textures, and .anims.json sidecar if it has one.',
    });
    return;
  }
  performLoad(() => viewer.loadFromFiles(list), modelLabelFromFiles(list)).catch(() => {});
}

function applyControl(key, enabled, { syncUI = false } = {}) {
  controlState[key] = Boolean(enabled);
  if (syncUI) ui.setToggle(key, enabled);
  if (!viewer) return;
  switch (key) {
    case 'wireframe': viewer.setWireframe(enabled); break;
    case 'grid': viewer.setGrid(enabled); break;
    case 'axes': viewer.setAxes(enabled); break;
    case 'bounds': viewer.setBounds(enabled); break;
    case 'autoRotate': viewer.setAutoRotate(enabled); break;
    case 'shadows': viewer.setShadows(enabled); break;
    default: break;
  }
}

function frameModel() {
  if (!viewer?.model) {
    ui.toast({ kind: 'info', title: 'No model loaded', message: 'Open an asset before framing the camera.' });
    return;
  }
  viewer.frame();
}

function resetView() {
  if (!viewer?.model) return;
  viewer.resetView();
}

function downloadURL(dataUrl, filename) {
  const anchor = document.createElement('a');
  anchor.href = dataUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function screenshotData() {
  if (!viewer?.model) throw new Error('Load a model before taking a screenshot.');
  return viewer.captureScreenshot(backgroundMode);
}

function takeScreenshot() {
  if (mode === 'ui') {
    ui.toast({
      kind: 'info',
      title: 'UI preview is DOM/CSS',
      message: 'Use the preview toolbar to switch screens/sizes. Pixel captures come from the headless test or your browser screenshot tool.',
      timeout: 7000,
    });
    return null;
  }
  if (!viewer?.model) {
    ui.toast({ kind: 'info', title: 'Nothing to capture', message: 'Open an asset first.' });
    return;
  }
  try {
    const data = viewer.captureScreenshot(backgroundMode);
    const base = (currentInfo?.name || 'asset').replace(/\.(glb|gltf)$/i, '').replace(/[^a-z0-9._-]+/gi, '-');
    downloadURL(data, `${base || 'asset'}-glb-inspector.png`);
    ui.toast({ kind: 'success', title: 'Screenshot saved', message: 'A PNG of the current viewport was downloaded.', timeout: 3600 });
    return data;
  } catch (error) {
    ui.toast({ kind: 'error', title: 'Screenshot failed', message: error.message || 'The viewport could not be captured.', timeout: 7000 });
    return null;
  }
}

function dismissError() {
  ui.dismissError();
  if (mode !== 'viewer') return;
  if (!viewer?.model) {
    ui.showEmpty();
  }
}

const actions = {
  onFiles: handleFiles,
  onSample: (sample) => {
    if (!sample?.url) {
      ui.toast({ kind: 'error', title: 'Sample unavailable', message: 'This sample has no model URL.' });
      return;
    }
    loadModel(sample.url, sample.anims || null).catch(() => {});
  },
  onToggle: (key, enabled) => applyControl(key, enabled),
  onExposure: (value) => viewer?.setExposure(value),
  onEnvironment: (value) => viewer?.setEnvironmentIntensity(value),
  onBackground: (mode) => {
    viewer?.setBackground(mode);
    ui.setBackground(mode);
  },
  onFrame: frameModel,
  onResetView: resetView,
  onScreenshot: takeScreenshot,
  onAnimationClip: (index) => viewer?.selectAnimationClip(index),
  onAnimationToggle: () => viewer?.toggleAnimation(),
  onAnimationSeek: (fraction) => viewer?.seekAnimation(fraction),
  onAnimationSpeed: (speed) => viewer?.setAnimationSpeed(speed),
  onLoadAnims: () => ui.openAnimsDialog(),
  onAnimsFile: (file) => { loadNeonAnimationsInput(file).catch(() => {}); },
  onOpenFiles: () => ui.openFileDialog(),
  onDismissError: dismissError,
};

ui.bind(actions);
ui.applyControlStates(controlState);
ui.setBackground(backgroundMode);
ui.setMode('viewer');
ui.setStatus('idle');
ui.setHint('DROP A MODEL OR OPEN A SAMPLE');

try {
  viewer = new Viewer(document.getElementById('viewport'));
  viewer.addEventListener('loadprogress', (event) => {
    ui.setLoadingProgress(event.detail?.percent, event.detail?.detail);
  });
  viewer.addEventListener('selectionchange', (event) => {
    ui.setSelection(event.detail?.selection || null);
  });
  viewer.addEventListener('renderstats', (event) => {
    ui.updateRenderStats(event.detail || {});
  });
  viewer.addEventListener('animationstate', (event) => {
    ui.updateAnimationState(event.detail);
  });
  viewer.addEventListener('animationlibrary', (event) => {
    refreshAnimationPanel();
    const detail = event.detail || {};
    ui.toast({
      kind: 'success',
      title: 'Animation library loaded',
      message: `${detail.label || 'anims.json'} · ${detail.count || 0} clip${detail.count === 1 ? '' : 's'}`,
      timeout: 5000,
    });
  });
  viewer.addEventListener('animsloaderror', (event) => {
    ui.toast({
      kind: 'warning',
      title: 'Animation library failed',
      message: event.detail?.message || 'The .anims.json library could not be loaded.',
      timeout: 9000,
    });
  });
  viewer.setBackground(backgroundMode);
  viewer.setWireframe(controlState.wireframe);
  viewer.setGrid(controlState.grid);
  viewer.setAxes(controlState.axes);
  viewer.setBounds(controlState.bounds);
  viewer.setAutoRotate(controlState.autoRotate);
  viewer.setShadows(controlState.shadows);

  if (mode === 'scene') {
    scenePreview = new ScenePreview({ viewer });
    viewer.setSceneMode(true);
  } else if (mode === 'ui') {
    uiPreview = new UiPreview({
      stage: document.getElementById('ui-preview-stage'),
      frame: document.getElementById('ui-preview-frame'),
      root: document.getElementById('ui-preview-root'),
      screenTabs: document.getElementById('ui-screen-tabs'),
      sizeTabs: document.getElementById('ui-size-tabs'),
      caption: document.getElementById('ui-preview-caption'),
      onChange: (state) => ui.updateUiViewport(state),
    });
  }
} catch (error) {
  stateErrors = [error.message || 'WebGL initialization failed.'];
  ui.showError('WebGL unavailable', `${error.message || 'The browser could not create a WebGL context.'} Try enabling hardware acceleration or a WebGL-capable browser.`);
  ui.toast({ kind: 'error', title: 'Renderer offline', message: error.message || 'WebGL could not start.', timeout: 9000 });
}

/* ------------------------------------------------------------
   Public automation surface
   ------------------------------------------------------------ */

const api = {
  ready: false,
  readyPromise,
  loadModel,
  loadNeonAnimations: (input) => loadNeonAnimationsInput(input),
  selectAnimationClip: (index) => {
    viewer?.selectAnimationClip(index);
    return viewer?.getAnimationState() ?? null;
  },
  setAnimationPlaying: (playing) => {
    viewer?.setAnimationPlaying(playing);
    return viewer?.getAnimationState() ?? null;
  },
  seekAnimation: (fraction) => {
    viewer?.seekAnimation(fraction);
    return viewer?.getAnimationState() ?? null;
  },
  toggleAnimation: () => {
    viewer?.toggleAnimation();
    return viewer?.getAnimationState() ?? null;
  },
  getAnimationState: () => (viewer ? viewer.getAnimationState() : null),
  getAnimationProbe: () => (viewer ? viewer.getAnimationProbe() : null),
  getEmissiveState: () => (viewer ? viewer.getEmissiveState() : []),
  getState: () => {
    const animation = viewer ? viewer.getAnimationState() : null;
    const clips = animation?.clips || [];
    return {
      ready: api.ready,
      loading: busy,
      mode,
      modelName: currentInfo?.name ?? null,
      meshCount: currentInfo?.meshCount ?? 0,
      triangleCount: currentInfo?.triangleCount ?? 0,
      vertexCount: currentInfo?.vertexCount ?? 0,
      nodeCount: currentInfo?.nodeCount ?? 0,
      materialCount: currentInfo?.materialCount ?? 0,
      textureCount: currentInfo?.textureCount ?? 0,
      animationClips: clips.map((clip) => clip.name),
      animations: currentInfo?.animationCount ?? 0,
      neonAnimationClips: clips.filter((clip) => clip.source === 'neon').map((clip) => clip.name),
      neonAnimations: clips.filter((clip) => clip.source === 'neon').length,
      animationSource: animation?.source ?? null,
      animationSourceLabel: animation?.sourceLabel ?? null,
      activeClipIndex: animation?.index ?? -1,
      activeClip: animation && animation.index >= 0 ? clips[animation.index]?.name ?? null : null,
      activeClipSource: animation?.activeSource ?? null,
      animationPlaying: animation?.playing ?? false,
      animationDuration: animation?.duration ?? 0,
      animationLooping: Boolean(animation?.activeLooping),
      animationTime: animation?.time ?? 0,
      dimensions: currentInfo?.dimensions
        ? { x: currentInfo.dimensions.x, y: currentInfo.dimensions.y, z: currentInfo.dimensions.z }
        : null,
      neonRange: currentInfo?.neonRange
        ? {
          assetId: currentInfo.neonRange.asset_id || null,
          source: currentInfo.neonRange.source || null,
          viewHintUsed: Boolean(currentInfo.viewHintUsed),
        }
        : null,
      camera: viewer
        ? {
          position: viewer.camera.position.toArray(),
          target: viewer.controls.target.toArray(),
          fov: viewer.camera.fov,
        }
        : null,
      selected: viewer?.selected ? (viewer.selected.name || viewer.selected.type) : null,
      scene: scenePreview ? scenePreview.getState() : null,
      ui: uiPreview ? uiPreview.getState() : null,
      errors: stateErrors.slice(),
    };
  },
  screenshot: screenshotData,
};

window.__GLB_VIEWER__ = api;

window.__GLB_SCENE__ = {
  getState: () => (scenePreview ? scenePreview.getState() : null),
  load: (sceneUrl, manifestUrl) => loadScene(sceneUrl, manifestUrl),
  setMarkersVisible: (visible) => scenePreview?.setMarkersVisible(visible),
  setCollidersVisible: (visible) => scenePreview?.setCollidersVisible(visible),
  setSpawnVisible: (visible) => scenePreview?.setSpawnVisible(visible),
  setTargetsVisible: (visible) => scenePreview?.setTargetsVisible(visible),
};

window.__GLB_UI_PREVIEW__ = {
  getState: () => (uiPreview ? uiPreview.getState() : null),
  load: (layoutUrl, themeUrl, stringsUrl) => loadUiPreview(layoutUrl, themeUrl, stringsUrl),
  setSize: (key) => {
    uiPreview?.setSize(key);
    uiPreview?.layout();
    return uiPreview?.getState() ?? null;
  },
  setScreen: (id) => {
    uiPreview?.setScreen(id);
    return uiPreview?.getState() ?? null;
  },
  layout: () => {
    uiPreview?.layout();
    return uiPreview?.getState() ?? null;
  },
};

function updateAxisGizmo() {
  if (!viewer) return;
  const axes = viewer.getScreenAxes();
  const center = 48;
  const length = 27;
  for (const name of ['x', 'y', 'z']) {
    const vector = axes[name];
    const element = axisElements[name];
    if (!vector || !element) continue;
    const endX = center + vector.x * length;
    const endY = center + vector.y * length;
    element.line.setAttribute('x2', endX.toFixed(2));
    element.line.setAttribute('y2', endY.toFixed(2));
    element.dot.setAttribute('cx', endX.toFixed(2));
    element.dot.setAttribute('cy', endY.toFixed(2));
    element.label.setAttribute('x', (center + vector.x * (length + 9)).toFixed(2));
    element.label.setAttribute('y', (center + vector.y * (length + 9) + 3).toFixed(2));
    const opacity = 0.35 + Math.max(0, vector.depth) * 0.65;
    element.line.setAttribute('opacity', opacity.toFixed(2));
    element.dot.setAttribute('opacity', opacity.toFixed(2));
    element.label.setAttribute('opacity', (0.45 + Math.max(0, vector.depth) * 0.55).toFixed(2));
  }
}
window.setInterval(updateAxisGizmo, 50);

/* ------------------------------------------------------------
   Drag & drop
   ------------------------------------------------------------ */

let dragDepth = 0;
function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files');
}
window.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  ui.setDragActive(true);
});
window.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  ui.setDragActive(true);
});
window.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.setDragActive(false);
});
window.addEventListener('drop', (event) => {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  ui.setDragActive(false);
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) handleFiles(files);
});

/* ------------------------------------------------------------
   Keyboard shortcuts
   ------------------------------------------------------------ */

const TOGGLE_KEYS = {
  g: ['grid', 'Grid'],
  w: ['wireframe', 'Wireframe'],
  r: ['autoRotate', 'Auto-rotate'],
  b: ['bounds', 'Bounding box'],
  a: ['axes', 'Axes'],
};

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const interactive = target instanceof Element
    && Boolean(target.closest('button, a, input, select, textarea, [contenteditable="true"]'));

  if (event.key === 'Escape') {
    if (ui.handleEscape()) {
      event.preventDefault();
      return;
    }
    if (!interactive) {
      viewer?.clearSelection();
      event.preventDefault();
    }
    return;
  }

  if (interactive) return;
  if (ui.helpOpen) return;

  const key = event.key.toLowerCase();
  if (key === '?' || key === 'h') {
    event.preventDefault();
    ui.openHelp();
    return;
  }
  if (key === 'f') {
    event.preventDefault();
    frameModel();
    return;
  }
  if (key === 's') {
    event.preventDefault();
    takeScreenshot();
    return;
  }
  if (key === ' ') {
    event.preventDefault();
    viewer?.toggleAnimation();
    return;
  }
  if (TOGGLE_KEYS[key]) {
    event.preventDefault();
    const [control] = TOGGLE_KEYS[key];
    applyControl(control, !controlState[control], { syncUI: true });
  }
});

/* ------------------------------------------------------------
   Boot
   ------------------------------------------------------------ */

async function loadSampleManifest() {
  try {
    const response = await fetch('samples/manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data?.samples) || !data.samples.length) throw new Error('Manifest contains no samples.');
    ui.setSamples(data);
  } catch (error) {
    ui.setSamples(FALLBACK_SAMPLES);
    ui.toast({
      kind: 'warning',
      title: 'Sample manifest unavailable',
      message: 'Using the built-in reference list. Run python serve.py from the project root.',
      timeout: 6000,
    });
  }
}

async function boot() {
  await loadSampleManifest();
  booted = true;
  api.ready = true;
  resolveReady?.();
  if (mode === 'scene' && initialScene) {
    loadScene(initialScene, initialManifest).catch(() => {});
  } else if (mode === 'ui' && initialUi) {
    loadUiPreview(initialUi, initialTheme, initialStrings).catch(() => {});
  } else if (initialModel) {
    loadModel(initialModel, initialAnims).catch(() => {});
  }
}

boot();

window.addEventListener('error', (event) => {
  const message = event.message || 'Unhandled page error.';
  if (stateErrors[stateErrors.length - 1] !== message) stateErrors.push(message);
});

// A tiny debug helper for headless verification; the supported test surface is
// window.__GLB_VIEWER__ above.
window.addEventListener('unhandledrejection', (event) => {
  if (!booted) return;
  const reason = event.reason?.message;
  if (reason && !stateErrors.includes(reason)) stateErrors.push(reason);
});
