import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { analyzeModel } from './inspect.js';
import { fileNameFromURL } from './format.js';
import {
  parseNeonAnimationLibrary,
  buildNeonAnimationClips,
  sampleTrack,
  summarizeNeonLibrary,
} from './neon-anims.js';

const HOME_DIRECTION = new THREE.Vector3(0.82, 0.5, 1).normalize();
const LOCAL_PREFIX = 'local-asset/';

function normalizePath(path) {
  const parts = String(path).replace(/\\/g, '/').split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function baseName(path) {
  return String(path).split('/').filter(Boolean).pop() || '';
}

function stripQuery(path) {
  return String(path).split(/[?#]/)[0];
}

function formatForName(name) {
  return stripQuery(String(name)).toLowerCase().endsWith('.gltf') ? 'GLTF' : 'GLB';
}

function displayType(object) {
  if (object.isSkinnedMesh) return 'Skinned Mesh';
  if (object.isInstancedMesh) return 'Instanced Mesh';
  if (object.isMesh) return 'Mesh';
  if (object.isBone) return 'Bone';
  if (object.isGroup) return 'Group';
  if (object.isScene) return 'Scene';
  return object.type || 'Object3D';
}

function isEffectivelyVisible(object, stopAt) {
  let cursor = object;
  while (cursor && cursor !== stopAt) {
    if (!cursor.visible) return false;
    cursor = cursor.parent;
  }
  return Boolean(object);
}

function disposeModel(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

function friendlyError(error, missing = []) {
  const raw = error?.message || String(error || 'Unknown error');
  if (missing.length) {
    const list = missing.slice(0, 4).join(', ');
    const extra = missing.length > 4 ? ` and ${missing.length - 4} more` : '';
    return `Missing external resource${missing.length === 1 ? '' : 's'}: ${list}${extra}. Include every .bin and texture file with the .gltf.`;
  }
  if (/draco/i.test(raw)) {
    return 'This model uses Draco compression, which is not bundled in this offline build. Re-export without Draco to inspect it here.';
  }
  if (/ktx2|basis/i.test(raw)) {
    return 'This model uses KTX2/Basis textures, which are not bundled in this offline build. Re-export with standard PNG/JPEG textures to inspect it here.';
  }
  if (/meshopt|meshoptimizer/i.test(raw)) {
    return 'The meshopt decoder could not process this model. The file may be corrupt or use an unsupported meshopt extension.';
  }
  if (/json|unexpected token|unknown asset|unsupported asset|parse/i.test(raw) && !/fetch|network/i.test(raw)) {
    return `This file could not be parsed as glTF 2.0. ${raw.replace(/^THREE\.GLTFLoader:\s*/, '')}`;
  }
  if (/fetch|network|failed to load|404|load failed|xmlhttprequest/i.test(raw)) {
    return 'The model could not be downloaded. Check that serve.py is running and that the URL is reachable from this page.';
  }
  return raw.replace(/^THREE\.GLTFLoader:\s*/, '') || 'The model could not be loaded.';
}

function makeLoader(manager) {
  const loader = new GLTFLoader(manager);
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

export class Viewer extends EventTarget {
  constructor(canvas) {
    super();
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Viewport canvas is missing.');
    this.canvas = canvas;
    this.container = canvas.parentElement;
    this.backgroundMode = 'gradient';
    this.model = null;
    this.gltf = null;
    this.info = null;
    this.box = null;
    this.loading = false;
    this.selected = null;
    this.selectedAt = 0;
    this.errors = [];
    this.neonRange = null;
    this.viewHintUsed = false;
    this.defaultFov = 42;

    this.wireframe = false;
    this.showGrid = true;
    this.showAxes = false;
    this.showBounds = false;
    this.showShadows = true;
    this.autoRotate = false;
    this.backgroundMode = 'gradient';
    this.sceneMode = false;
    this.composer = null;

    this.animations = [];
    this.animationMeta = [];
    this.actions = [];
    this.activeAction = null;
    this.activeClipIndex = -1;
    this.mixer = null;
    this.playing = false;
    this.animationSpeed = 1;
    this._lastAnimEmit = 0;
    this.neonLibrary = null;
    this._neonBuild = null;
    this._restPose = new Map();
    this._emissiveOriginals = new Map();
    this._activeEmissiveTracks = [];
    this._activeFinished = false;
    this._onAnimationFinished = this._handleAnimationFinished.bind(this);

    this._pointerStart = null;
    this._frameCounter = 0;
    this._lastStatsAt = performance.now();
    this._lastFrameAt = performance.now();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
    this.camera.position.set(3.5, 2.2, 4.6);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.screenSpacePanning = true;
    this.controls.autoRotateSpeed = 0.9;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 10000;
    this.controls.target.set(0, 0.5, 0);

    this._setupEnvironment();
    this._setupLights();
    this._setupHelpers();
    this._bindPointerEvents();

    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(this.container);
    window.addEventListener('resize', this._onWindowResize);

    this.resize();
    this.controls.update();
    this.renderer.setAnimationLoop(() => this._tick());
  }

  /* ------------------------------------------------------------
     Scene setup
     ------------------------------------------------------------ */

  _setupEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    const renderTarget = pmrem.fromScene(room, 0.04, 0.1, 100);
    this.environmentTarget = renderTarget;
    this.scene.environment = renderTarget.texture;
    this.scene.environmentIntensity = 1.1;
    room.dispose();
    pmrem.dispose();
  }

  _setupLights() {
    const key = new THREE.DirectionalLight(0xfff3e7, 2.4);
    key.position.set(4, 6, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.bias = -0.00025;
    key.shadow.normalBias = 0.012;
    key.shadow.camera.near = 0.1;
    key.shadow.camera.far = 40;
    this.scene.add(key, key.target);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight(0x7ddfff, 1.15);
    fill.position.set(-5, 2.5, 3);
    this.scene.add(fill);
    this.fillLight = fill;

    const rim = new THREE.DirectionalLight(0xff8a2a, 2.2);
    rim.position.set(1, 4, -6);
    this.scene.add(rim);
    this.rimLight = rim;

    const bounce = new THREE.HemisphereLight(0x8bcde2, 0x130c06, 0.32);
    this.scene.add(bounce);
    this.bounceLight = bounce;
  }

  _setupHelpers() {
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ color: 0x000000, opacity: 0.4, transparent: true, depthWrite: false }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.ground.visible = false;
    this.ground.renderOrder = -1;
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(20, 20, 0x3d7c88, 0x1a343d);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.38;
    this.grid.material.depthWrite = false;
    this.grid.visible = false;
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(1);
    this.axes.material.transparent = true;
    this.axes.material.opacity = 0.8;
    this.axes.material.depthWrite = false;
    this.axes.material.depthTest = false;
    this.axes.visible = false;
    this.axes.renderOrder = 4;
    this.scene.add(this.axes);

    this.boundsHelper = null;

    this.selectionBox = new THREE.BoxHelper(new THREE.Object3D(), 0xff8a2a);
    this.selectionBox.material.transparent = true;
    this.selectionBox.material.opacity = 0.95;
    this.selectionBox.material.depthTest = false;
    this.selectionBox.material.depthWrite = false;
    this.selectionBox.visible = false;
    this.selectionBox.renderOrder = 9;
    this.scene.add(this.selectionBox);
  }

  _setupBoundsHelper(box) {
    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper.geometry.dispose();
      this.boundsHelper.material.dispose();
    }
    const helper = new THREE.Box3Helper(box.clone(), 0x46e6ff);
    helper.material.transparent = true;
    helper.material.opacity = 0.44;
    helper.material.depthTest = false;
    helper.material.depthWrite = false;
    helper.visible = this.showBounds && Boolean(this.model);
    helper.renderOrder = 6;
    this.scene.add(helper);
    this.boundsHelper = helper;
  }

  _bindPointerEvents() {
    this._onPointerDown = (event) => {
      if (event.button !== 0) {
        this._pointerStart = null;
        return;
      }
      this._pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
    };

    this._onPointerUp = (event) => {
      if (!this._pointerStart || event.pointerId !== this._pointerStart.id || event.button !== 0) {
        this._pointerStart = null;
        return;
      }
      const dx = event.clientX - this._pointerStart.x;
      const dy = event.clientY - this._pointerStart.y;
      this._pointerStart = null;
      if (dx * dx + dy * dy > 25) return;
      this._pickAt(event.clientX, event.clientY);
    };

    this._onDoubleClick = () => {
      if (this.model) this.frame();
    };

    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('dblclick', this._onDoubleClick);
  }

  _onWindowResize = () => this.resize();

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    if (this.composer) {
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(width, height);
    }
  }

  /* ------------------------------------------------------------
     Public loading API
     ------------------------------------------------------------ */

  async loadFromURL(url, { animsUrl = null } = {}) {
    if (!url) throw new Error('No model URL was provided.');
    if (this.loading) throw new Error('Another model is already loading.');
    this.loading = true;
    this.errors = [];
    const label = fileNameFromURL(url);
    this._emit('loadstart', { label, source: url });

    const started = performance.now();
    try {
      this._emitProgress(null, 'Fetching model…');
      const [gltf, fileSize] = await Promise.all([
        this._loadGLTFUrl(url),
        this._headContentLength(url),
      ]);
      const loadTime = (performance.now() - started) / 1000;
      const info = this._install(gltf, {
        name: label,
        format: formatForName(label),
        fileSize,
        sourceLabel: this._shortSource(url),
        url,
        loadTime,
      });
      if (animsUrl) await this._attachSidecarForInfo(info, animsUrl);
      this.loading = false;
      this._emit('loaded', info);
      return info;
    } catch (error) {
      this.loading = false;
      const message = friendlyError(error);
      this.errors.push(message);
      this._emit('loaderror', { message, error });
      throw new Error(message, { cause: error });
    }
  }

  async loadFromFiles(fileList) {
    const files = Array.from(fileList || []);
    const models = files.filter((file) => /\.(glb|gltf)$/i.test(file.name || ''));
    const animFiles = files.filter((file) => /\.anims\.json$/i.test(file.name || ''));
    if (!models.length) {
      const message = animFiles.length
        ? 'An .anims.json library needs a model. Select the .glb/.gltf together with the sidecar.'
        : 'No .glb or .gltf file was found in that selection.';
      this._emit('loaderror', { message, error: new Error(message) });
      throw new Error(message);
    }
    if (this.loading) throw new Error('Another model is already loading.');

    const preferred = models.find((file) => /\.glb$/i.test(file.name)) || models[0];
    const rootFile = preferred;
    const label = rootFile.name || 'model.glb';
    const format = formatForName(label);
    const note = models.length > 1
      ? `${models.length} model files were selected; loading ${label}.`
      : null;

    this.loading = true;
    this.errors = [];
    this._emit('loadstart', { label, source: 'local' });
    const started = performance.now();
    const objectUrls = [];
    const missingResources = [];

    try {
      const resourceMaps = this._makeResourceMaps(files, rootFile, objectUrls);
      const manager = new THREE.LoadingManager();
      manager.setURLModifier((requested) => {
        const withoutQuery = stripQuery(requested);
        const prefixIndex = withoutQuery.indexOf(LOCAL_PREFIX);
        if (prefixIndex === -1) return requested;
        const relative = normalizePath(safeDecode(withoutQuery.slice(prefixIndex + LOCAL_PREFIX.length)));
        const found = resourceMaps.byPath.get(relative.toLowerCase())
          || resourceMaps.byName.get(baseName(relative).toLowerCase());
        if (!found) {
          if (!missingResources.includes(relative)) missingResources.push(relative);
          return requested;
        }
        return found;
      });
      manager.onProgress = (_url, loaded, total) => {
        if (total > 0) {
          const percent = 12 + Math.min(78, (loaded / total) * 78);
          this._emitProgress(percent, `Resolving resources ${loaded} / ${total}`);
        } else {
          this._emitProgress(null, 'Resolving external resources…');
        }
      };

      this._emitProgress(null, 'Reading asset…');
      const buffer = await rootFile.arrayBuffer();
      const loader = makeLoader(manager);
      const gltf = await new Promise((resolve, reject) => {
        loader.parse(buffer, LOCAL_PREFIX, resolve, reject);
      });

      const loadTime = (performance.now() - started) / 1000;
      const info = this._install(gltf, {
        name: label,
        format,
        fileSize: rootFile.size,
        sourceLabel: 'LOCAL FILE',
        loadTime,
      });
      if (note) info.note = note;
      if (animFiles.length) {
        const stem = label.replace(/\.(glb|gltf)$/i, '').toLowerCase();
        const preferred = animFiles.find((file) => file.name.replace(/\.anims\.json$/i, '').toLowerCase() === stem)
          || animFiles[0];
        try {
          info.neonAnimations = await this.loadNeonAnimationsFromFile(preferred);
          if (animFiles.length > 1) {
            info.note = [info.note, `Loaded sidecar ${preferred.name}; ${animFiles.length - 1} other .anims.json file(s) were ignored.`]
              .filter(Boolean).join(' ');
          }
        } catch (error) {
          info.neonAnimationError = this._reportSidecarError(error, preferred.name, preferred);
        }
      }
      this.loading = false;
      this._emit('loaded', info);
      return info;
    } catch (error) {
      this.loading = false;
      const message = friendlyError(error, missingResources);
      this.errors.push(message);
      this._emit('loaderror', { message, error });
      throw new Error(message, { cause: error });
    } finally {
      for (const url of objectUrls) URL.revokeObjectURL(url);
    }
  }

  _makeResourceMaps(files, rootFile, objectUrls) {
    const byPath = new Map();
    const byName = new Map();
    const rootPath = normalizePath(rootFile.webkitRelativePath || rootFile.name || '');
    const rootDirectory = rootPath.includes('/') ? rootPath.slice(0, rootPath.lastIndexOf('/') + 1) : '';

    for (const file of files) {
      const objectUrl = URL.createObjectURL(file);
      objectUrls.push(objectUrl);
      const fullPath = normalizePath(file.webkitRelativePath || file.name || '');
      const relative = rootDirectory && fullPath.startsWith(rootDirectory)
        ? fullPath.slice(rootDirectory.length)
        : fullPath;

      const candidates = new Set([
        relative,
        safeDecode(relative),
        fullPath,
        file.name,
      ]);
      for (const candidate of candidates) {
        const clean = normalizePath(candidate);
        if (!clean) continue;
        byPath.set(clean.toLowerCase(), objectUrl);
        byName.set(baseName(clean).toLowerCase(), objectUrl);
      }
    }

    return { byPath, byName };
  }

  _loadGLTFUrl(url) {
    const manager = new THREE.LoadingManager();
    manager.onProgress = (_url, loaded, total) => {
      if (total > 0) {
        this._emitProgress(12 + Math.min(74, (loaded / total) * 74), `Resolving resources ${loaded} / ${total}`);
      }
    };
    const loader = makeLoader(manager);

    return new Promise((resolve, reject) => {
      loader.load(
        url,
        resolve,
        (event) => {
          if (event?.lengthComputable && event.total > 0) {
            const percent = 4 + Math.min(56, (event.loaded / event.total) * 56);
            this._emitProgress(percent, `Downloading ${fileNameFromURL(url)} · ${Math.round((event.loaded / event.total) * 100)}%`);
          } else {
            this._emitProgress(null, 'Downloading model…');
          }
        },
        (error) => reject(error),
      );
    });
  }

  async _headContentLength(url) {
    try {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) return null;
      const value = Number(response.headers.get('content-length'));
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  _shortSource(url) {
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.host === window.location.host
        ? `${parsed.pathname.split('/').slice(0, -1).join('/') || '/'}`
        : parsed.host;
    } catch {
      return 'REMOTE';
    }
  }

  _install(gltf, meta) {
    this._clearCurrentModel();

    const model = gltf.scene;
    this.gltf = gltf;
    this.model = model;
    this.scene.add(model);

    model.traverse((object) => {
      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      if (object.isSkinnedMesh) object.frustumCulled = false;
    });

    // Capture the authored bind pose before any mixer writes to the hierarchy.
    // Sidecar libraries loaded later must offset this pose, not the pose that
    // happens to be active at attach time.
    this._captureRestPose(model);
    this._captureEmissiveOriginals(model);

    this.info = analyzeModel(gltf, meta);
    this.box = this.info.box;
    this.neonRange = this._findNeonRange(model);
    if (this.neonRange) this.info.neonRange = this.neonRange;
    this._setupStageForModel(this.info);
    this._applyWireframe();
    this._applyVisibilityHelpers();
    this._setupAnimation();

    this.camera.fov = this.defaultFov;
    this.camera.updateProjectionMatrix();
    const hintApplied = this._applyViewHint(this.neonRange, this.info);
    this.viewHintUsed = hintApplied;
    this.info.viewHintUsed = hintApplied;
    if (!hintApplied) this._frameBox(this.box, { saveHome: true });

    this._emitProgress(100, 'Asset ready.');
    return this.info;
  }

  _findNeonRange(root) {
    let metadata = null;
    root.traverse((object) => {
      if (metadata) return;
      const candidate = object.userData?.neon_range;
      if (candidate && typeof candidate === 'object') metadata = candidate;
    });
    return metadata;
  }

  /**
   * Closed-room assets include an authored interior camera. The prop exports also
   * carry authoring hints, but the integration spec wants those auto-framed, so a
   * hint is honored for environment-tagged assets (or a hint whose camera origin
   * is actually inside the geometry) and ignored for product-style props.
   */
  _applyViewHint(metadata, info) {
    const hint = metadata?.view_hint;
    if (!hint || !Array.isArray(hint.position) || !Array.isArray(hint.target)) return false;

    const position = new THREE.Vector3().fromArray(hint.position);
    const target = new THREE.Vector3().fromArray(hint.target);
    if (![position.x, position.y, position.z, target.x, target.y, target.z].every(Number.isFinite)) return false;

    const isEnvironment = /^ENV_/i.test(metadata.asset_id || '') || hint.interior === true;
    const cameraInside = info.box && !info.box.isEmpty() && info.box.containsPoint(position);
    if (!isEnvironment && !cameraInside) return false;

    const distance = Math.max(position.distanceTo(target), 0.05);
    const fov = Number.isFinite(hint.fov) ? THREE.MathUtils.clamp(hint.fov, 20, 110) : this.defaultFov;
    this.camera.position.copy(position);
    this.controls.target.copy(target);
    this.camera.fov = fov;
    this.camera.near = Math.max(0.0001, distance * 0.002);
    this.camera.far = Math.max(100, distance * 120);
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.max(0.001, distance * 0.02);
    this.controls.maxDistance = Math.max(100, distance * 20);
    this.controls.update();

    this.homeView = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
      fov,
    };
    return true;
  }

  _clearCurrentModel() {
    this.select(null);
    this._restoreEmissive();
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this._onAnimationFinished);
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.actions = [];
    this.activeAction = null;
    this.activeClipIndex = -1;
    this.animations = [];
    this.animationMeta = [];
    this.animationSpeed = 1;
    this.playing = false;
    this.neonLibrary = null;
    this._neonBuild = null;
    this._restPose.clear();
    this._emissiveOriginals.clear();
    this._activeEmissiveTracks = [];
    this._activeFinished = false;

    if (this.boundsHelper) {
      this.scene.remove(this.boundsHelper);
      this.boundsHelper.geometry.dispose();
      this.boundsHelper.material.dispose();
      this.boundsHelper = null;
    }
    if (this.model) {
      this.scene.remove(this.model);
      disposeModel(this.model);
    }
    this.model = null;
    this.gltf = null;
    this.info = null;
    this.box = null;
    this.neonRange = null;
    this.viewHintUsed = false;
    this.ground.visible = false;
    this.grid.visible = false;
    this.axes.visible = false;
  }

  _setupStageForModel(info) {
    const size = info.dimensions;
    const maxDim = Math.max(size.x, size.y, size.z, 0.1);
    const extent = Math.max(4, maxDim * 8);
    const groundY = info.dimensions.minY - maxDim * 0.0025;
    const center = info.dimensions.center;

    this.ground.scale.set(extent, extent, 1);
    this.ground.position.set(center.x, groundY, center.z);
    this.ground.visible = this.showShadows;

    this.grid.scale.setScalar(extent / 20);
    this.grid.position.set(center.x, groundY + maxDim * 0.0006, center.z);
    this.grid.visible = this.showGrid;

    this.axes.scale.setScalar(maxDim * 0.7);
    this.axes.position.set(center.x, groundY + maxDim * 0.001, center.z);
    this.axes.visible = this.showAxes;

    this._setupBoundsHelper(info.box);

    const radius = Math.max(maxDim * 0.7, 0.1);
    this.keyLight.position.set(center.x + radius * 2.3, center.y + radius * 3.2, center.z + radius * 2.4);
    this.keyLight.target.position.copy(center);
    this.keyLight.target.updateMatrixWorld();
    this.fillLight.position.set(center.x - radius * 3.1, center.y + radius * 1.4, center.z + radius * 2.2);
    this.rimLight.position.set(center.x + radius * 0.7, center.y + radius * 2.2, center.z - radius * 3.2);
    this.bounceLight.position.set(center.x, center.y + radius * 0.8, center.z);

    const shadowCamera = this.keyLight.shadow.camera;
    shadowCamera.left = -radius * 2.2;
    shadowCamera.right = radius * 2.2;
    shadowCamera.top = radius * 2.2;
    shadowCamera.bottom = -radius * 2.2;
    shadowCamera.near = Math.max(0.001, radius * 0.1);
    shadowCamera.far = radius * 12;
    shadowCamera.updateProjectionMatrix();
    this.keyLight.shadow.needsUpdate = true;
  }

  _frameBox(box, { saveHome = false } = {}) {
    if (!box || box.isEmpty()) {
      this.camera.position.set(3.5, 2.2, 4.6);
      this.controls.target.set(0, 0.5, 0);
      this.controls.update();
      return;
    }

    const center = box.getCenter(new THREE.Vector3());
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 0.02);
    const vFov = THREE.MathUtils.degToRad(this.camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.1));
    const fitFov = Math.min(vFov, hFov);
    const distance = (radius / Math.sin(fitFov / 2)) * 1.15;

    this.camera.position.copy(center).addScaledVector(HOME_DIRECTION, distance);
    this.camera.near = Math.max(0.0001, distance * 0.004);
    this.camera.far = Math.max(100, distance * 120);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = Math.max(0.001, radius * 0.04);
    this.controls.maxDistance = Math.max(radius * 30, distance * 8);
    this.controls.update();

    if (saveHome) {
      this.homeView = {
        position: this.camera.position.clone(),
        target: this.controls.target.clone(),
        near: this.camera.near,
        far: this.camera.far,
        fov: this.camera.fov,
      };
    }
  }

  frame() {
    if (!this.model) return;
    const box = new THREE.Box3().setFromObject(this.model);
    this._frameBox(box, { saveHome: false });
  }

  resetView() {
    if (!this.model) return;
    if (this.homeView) {
      this.camera.position.copy(this.homeView.position);
      this.controls.target.copy(this.homeView.target);
      this.camera.near = this.homeView.near;
      this.camera.far = this.homeView.far;
      if (Number.isFinite(this.homeView.fov)) this.camera.fov = this.homeView.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    } else {
      this.frame();
    }
  }

  /* ------------------------------------------------------------
     Visibility + render settings
     ------------------------------------------------------------ */

  _applyWireframe() {
    if (!this.model) return;
    this.model.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material || !('wireframe' in material)) continue;
        material.wireframe = this.wireframe;
        material.needsUpdate = true;
      }
    });
  }

  _applyVisibilityHelpers() {
    const hasModel = Boolean(this.model);
    this.grid.visible = hasModel && this.showGrid;
    this.axes.visible = hasModel && this.showAxes;
    this.ground.visible = hasModel && this.showShadows && !this.sceneMode;
    if (this.boundsHelper) this.boundsHelper.visible = hasModel && this.showBounds;
    this.keyLight.castShadow = hasModel && this.showShadows && !this.sceneMode;
  }

  setWireframe(enabled) {
    this.wireframe = Boolean(enabled);
    this._applyWireframe();
  }

  setGrid(enabled) {
    this.showGrid = Boolean(enabled);
    this.grid.visible = Boolean(this.model) && this.showGrid;
  }

  setAxes(enabled) {
    this.showAxes = Boolean(enabled);
    this.axes.visible = Boolean(this.model) && this.showAxes;
  }

  setBounds(enabled) {
    this.showBounds = Boolean(enabled);
    if (this.boundsHelper) this.boundsHelper.visible = Boolean(this.model) && this.showBounds;
  }

  setShadows(enabled) {
    this.showShadows = Boolean(enabled);
    this.ground.visible = Boolean(this.model) && this.showShadows && !this.sceneMode;
    this.keyLight.castShadow = Boolean(this.model) && this.showShadows && !this.sceneMode;
  }

  setSceneMode(enabled) {
    this.sceneMode = Boolean(enabled);
    for (const light of [this.keyLight, this.fillLight, this.rimLight, this.bounceLight]) {
      if (light) light.visible = !this.sceneMode;
    }
    this.scene.environmentIntensity = this.sceneMode ? 0.05 : 1.1;
    this.ground.visible = !this.sceneMode && Boolean(this.model) && this.showShadows;
    this.keyLight.castShadow = !this.sceneMode && Boolean(this.model) && this.showShadows;

    if (!this.sceneMode) {
      this.scene.fog = null;
      this.scene.background = null;
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1;
      this.setPostProcessing(null);
    }
  }

  /**
   * Replaces the single-model stage with a composed scene root. Picking,
   * framing, screenshots and the hierarchy panel keep working because they all
   * operate on `this.model`; the scene comes from a temporary dev tool and is
   * intentionally read-only.
   */
  attachScene(root, { arenaHalf = 18 } = {}) {
    this._clearCurrentModel();
    this.model = root;
    this.scene.add(root);
    root.updateMatrixWorld(true);
    this.box = new THREE.Box3().setFromObject(root);
    this._setupBoundsHelper(this.box);

    const gridScale = Math.max(1, Math.ceil(Math.max(arenaHalf * 2, 20) / 20));
    this.grid.scale.setScalar(gridScale);
    this.grid.position.set(0, 0.012, 0);
    this.grid.visible = this.showGrid;
    this.grid.material.opacity = 0.22;

    this.axes.scale.setScalar(Math.max(2, arenaHalf * 0.14));
    this.axes.position.set(0, 0, 0);
    this.axes.visible = this.showAxes;

    this.ground.visible = false;
    this.keyLight.castShadow = false;
    if (this.boundsHelper) this.boundsHelper.visible = this.showBounds;
    this._emit('loaded', { name: root.name, scene: true });
  }

  setSceneCamera({ position, target, fov, near, far } = {}) {
    if (Array.isArray(position) && position.length >= 3) this.camera.position.fromArray(position);
    if (Array.isArray(target) && target.length >= 3) this.controls.target.fromArray(target);
    this.camera.fov = THREE.MathUtils.clamp(Number(fov) || 60, 10, 120);
    this.camera.near = Math.max(0.001, Number(near) || 0.05);
    this.camera.far = Math.max(this.camera.near + 1, Number(far) || 200);
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = Math.max(60, this.camera.far);
    this.controls.update();
    this.defaultFov = this.camera.fov;
    this.homeView = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      near: this.camera.near,
      far: this.camera.far,
      fov: this.camera.fov,
    };
  }

  setPostProcessing(composer) {
    if (this.composer && this.composer !== composer) {
      try { this.composer.dispose?.(); } catch { /* ignore */ }
    }
    this.composer = composer || null;
    if (this.composer) {
      const width = Math.max(1, this.container.clientWidth);
      const height = Math.max(1, this.container.clientHeight);
      this.composer.setPixelRatio(this.renderer.getPixelRatio());
      this.composer.setSize(width, height);
    }
  }

  _renderFrame() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  setAutoRotate(enabled) {
    this.autoRotate = Boolean(enabled);
    this.controls.autoRotate = this.autoRotate;
  }

  setExposure(value) {
    const exposure = THREE.MathUtils.clamp(Number(value), 0, 2);
    this.renderer.toneMappingExposure = exposure;
  }

  setEnvironmentIntensity(value) {
    const intensity = THREE.MathUtils.clamp(Number(value), 0, 3);
    this.scene.environmentIntensity = intensity;
  }

  setBackground(mode) {
    if (['dark', 'gradient', 'transparent'].includes(mode)) this.backgroundMode = mode;
  }

  /* ------------------------------------------------------------
     Selection
     ------------------------------------------------------------ */

  _pickAt(clientX, clientY) {
    if (!this.model) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(x, y), this.camera);
    const hits = raycaster.intersectObject(this.model, true);
    const hit = hits.find((entry) => entry.object?.isMesh && isEffectivelyVisible(entry.object, this.model.parent));
    this.select(hit?.object || null);
  }

  select(object) {
    if (!object || !this.model) {
      this.selected = null;
      if (this.selectionBox) this.selectionBox.visible = false;
      this._emit('selectionchange', { selection: null });
      return;
    }

    this.selected = object;
    this.selectedAt = performance.now();
    this.selectionBox.setFromObject(object);
    this.selectionBox.visible = true;
    this._emit('selectionchange', { selection: this._selectionDetail(object) });
  }

  _selectionDetail(object) {
    let triangles = 0;
    let meshes = 0;
    const materialNames = new Set();
    object.traverse((child) => {
      if (!child.isMesh) return;
      meshes += 1;
      const geometry = child.geometry;
      const count = geometry?.index?.count || geometry?.attributes?.position?.count || 0;
      triangles += Math.floor(count / 3) * (child.isInstancedMesh ? Math.max(1, child.count) : 1);
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material?.name) materialNames.add(material.name);
        else if (material?.type) materialNames.add(material.type);
      }
    });

    return {
      uuid: object.uuid,
      name: object.name || object.type || 'Unnamed node',
      type: displayType(object),
      triangles,
      meshes,
      materialNames: Array.from(materialNames),
      visible: isEffectivelyVisible(object, this.model?.parent),
    };
  }

  clearSelection() {
    this.select(null);
  }

  _updateSelectionHelper() {
    if (!this.selectionBox) return;
    if (!this.selected || !this.model || !isEffectivelyVisible(this.selected, this.model.parent)) {
      this.selectionBox.visible = false;
      return;
    }
    const now = performance.now();
    if (!this.selectionBox.visible || (this.mixer && this.playing && now - this.selectedAt > 120)) {
      this.selectionBox.setFromObject(this.selected);
      this.selectedAt = now;
    }
    this.selectionBox.visible = true;
  }

  /* ------------------------------------------------------------
     Animation
     ------------------------------------------------------------ */

  _captureRestPose(root) {
    this._restPose = new Map();
    root.updateMatrixWorld(true);
    root.traverse((object) => {
      this._restPose.set(object, {
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
        scale: object.scale.clone(),
      });
    });
  }

  _captureEmissiveOriginals(root) {
    this._emissiveOriginals = new Map();
    root.traverse((object) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (material?.emissive?.isColor && !this._emissiveOriginals.has(material)) {
          // three.js stores emissive in linear space; multiplying this authored
          // colour is exactly what the Rust player does conceptually.
          this._emissiveOriginals.set(material, material.emissive.clone());
        }
      }
    });
  }

  _restoreRestPose() {
    for (const [object, pose] of this._restPose) {
      object.position.copy(pose.position);
      object.quaternion.copy(pose.quaternion);
      object.scale.copy(pose.scale);
    }
  }

  _restoreEmissive() {
    for (const [material, original] of this._emissiveOriginals) {
      if (material?.emissive?.isColor) material.emissive.copy(original);
    }
  }

  _applyEmissiveAt(time) {
    if (!this._activeEmissiveTracks.length) return;
    this._restoreEmissive();
    for (const entry of this._activeEmissiveTracks) {
      const value = sampleTrack(entry.track, time);
      for (const material of entry.materials) {
        const original = this._emissiveOriginals.get(material);
        if (!original) continue;
        // Color.multiply expects another Color, so apply the component-wise
        // factor directly. `original` is the authored linear emissive colour.
        material.emissive.setRGB(
          original.r * value[0],
          original.g * value[1],
          original.b * value[2],
        );
      }
    }
  }

  _activeMeta() {
    return this.animationMeta[this.activeClipIndex] || null;
  }

  _sourceSummary() {
    const sources = new Set(this.animationMeta.map((meta) => meta.source));
    if (!sources.size) return { source: null, sourceLabel: '—' };
    if (sources.size > 1) {
      return {
        source: 'mixed',
        sourceLabel: `GLTF + NEON · ${this.neonLibrary?.label || 'anims.json'}`,
      };
    }
    const source = sources.values().next().value;
    if (source === 'neon') {
      return { source, sourceLabel: `NEON ANIMS · ${this.neonLibrary?.label || 'anims.json'}` };
    }
    return { source: 'gltf', sourceLabel: 'GLTF CLIPS' };
  }

  _setupAnimation() {
    this._teardownMixer();
    this.animations = [];
    this.animationMeta = [];
    this.playing = false;
    this.animationSpeed = 1;

    for (const clip of this.gltf?.animations || []) {
      this.animations.push(clip);
      this.animationMeta.push({
        source: 'gltf',
        name: clip.name || 'Untitled clip',
        looping: true,
        targets: [],
        emissiveTracks: [],
      });
    }

    if (!this.animations.length) {
      this.activeClipIndex = -1;
      return;
    }

    this._createMixerAndActions();
    this.playing = true;
    this._activateClip(0, { emit: false });
  }

  _appendNeonClips(neonBuild = null) {
    if (!this.neonLibrary || !this.model) return;
    const built = neonBuild || buildNeonAnimationClips(this.neonLibrary, this.model, { restPose: this._restPose });
    this._neonBuild = built;
    for (const entry of built.clips) {
      this.animations.push(entry.clip);
      this.animationMeta.push(entry.meta);
    }
  }

  _teardownMixer() {
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this._onAnimationFinished);
      this.mixer.stopAllAction();
      if (this.model) this.mixer.uncacheRoot(this.model);
    }
    this.mixer = null;
    this.actions = [];
    this.activeAction = null;
    this.activeClipIndex = -1;
    this._activeEmissiveTracks = [];
    this._activeFinished = false;
  }

  _createMixerAndActions() {
    this.mixer = new THREE.AnimationMixer(this.model);
    this.mixer.addEventListener('finished', this._onAnimationFinished);
    this.actions = this.animations.map((clip, index) => {
      const meta = this.animationMeta[index] || {};
      const action = this.mixer.clipAction(clip);
      if (meta.looping) {
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.clampWhenFinished = false;
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      return action;
    });
  }

  _handleAnimationFinished(event) {
    if (event.action !== this.activeAction) return;
    const meta = this._activeMeta();
    if (meta?.looping) return;
    this.playing = false;
    this._activeFinished = true;
    this._applyEmissiveAt(event.action.time);
    this._emitAnimationState();
    this._emit('animationfinished', {
      index: this.activeClipIndex,
      name: event.action.getClip()?.name || null,
      time: event.action.time,
    });
  }

  _activateClip(index, { emit = true, time = 0, playing = true } = {}) {
    if (!this.actions.length) return;
    const nextIndex = Math.max(0, Math.min(this.actions.length - 1, Number(index) || 0));
    if (this.activeAction) this.activeAction.stop();
    this._restoreEmissive();
    this._restoreRestPose();

    const action = this.actions[nextIndex];
    const clip = action.getClip();
    const duration = clip?.duration || 0;
    action.reset();
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.setEffectiveWeight(1);
    action.play();
    action.time = THREE.MathUtils.clamp(Number(time) || 0, 0, duration);
    action.paused = !playing;

    this.activeAction = action;
    this.activeClipIndex = nextIndex;
    this.playing = Boolean(playing);
    this._activeFinished = false;

    const meta = this.animationMeta[nextIndex];
    this._activeEmissiveTracks = meta?.source === 'neon' ? (meta.emissiveTracks || []) : [];

    this.mixer.update(0);
    this._applyEmissiveAt(action.time);
    if (emit) this._emitAnimationState();
  }

  selectAnimationClip(index) {
    if (!this.actions.length) return;
    this._activateClip(index);
  }

  setAnimationPlaying(playing) {
    if (!this.activeAction) return;
    if (playing) {
      if (this._activeFinished) {
        // Loop-once clips clamp at their end; pressing play starts them over.
        this._activateClip(this.activeClipIndex, { emit: false });
      } else {
        this.activeAction.paused = false;
        this.playing = true;
      }
    } else {
      this.activeAction.paused = true;
      this.playing = false;
    }
    this._applyEmissiveAt(this.activeAction.time);
    this._emitAnimationState();
  }

  toggleAnimation() {
    if (!this.activeAction) return;
    this.setAnimationPlaying(!this.playing);
  }

  seekAnimation(fraction) {
    if (!this.activeAction) return;
    const duration = this.activeAction.getClip().duration || 0;
    const t = THREE.MathUtils.clamp(Number(fraction) || 0, 0, 1) * duration;
    this.activeAction.time = t;
    this.activeAction.paused = !this.playing;
    if (t < duration - 1e-6) this._activeFinished = false;
    this.mixer.update(0);
    this._applyEmissiveAt(t);
    this._emitAnimationState();
  }

  setAnimationSpeed(speed) {
    this.animationSpeed = THREE.MathUtils.clamp(Number(speed) || 1, 0.1, 3);
    this._emitAnimationState();
  }

  _animationStateDetail() {
    const clip = this.activeAction?.getClip();
    const activeMeta = this._activeMeta();
    const { source, sourceLabel } = this._sourceSummary();
    return {
      index: this.activeClipIndex,
      playing: this.playing,
      time: this.activeAction?.time || 0,
      duration: clip?.duration || 0,
      speed: this.animationSpeed,
      count: this.animations.length,
      source,
      sourceLabel,
      activeSource: activeMeta?.source || null,
      activeLooping: Boolean(activeMeta?.looping),
      clips: this.animations.map((item, index) => {
        const meta = this.animationMeta[index] || {};
        return {
          name: item.name || 'Untitled clip',
          duration: item.duration || 0,
          source: meta.source || 'gltf',
          looping: Boolean(meta.looping),
          tracks: item.tracks?.length || 0,
        };
      }),
    };
  }

  _emitAnimationState() {
    this._emit('animationstate', this._animationStateDetail());
  }

  getAnimationState() {
    return this._animationStateDetail();
  }

  /**
   * Lightweight transform probe for headless verification. It reports the
   * active sidecar clip's resolved targets plus their bind pose so a test can
   * prove the mixer actually moved the model.
   */
  getAnimationProbe() {
    const meta = this._activeMeta();
    return {
      index: this.activeClipIndex,
      name: meta?.name || null,
      source: meta?.source || null,
      looping: Boolean(meta?.looping),
      playing: this.playing,
      time: this.activeAction?.time || 0,
      duration: this.activeAction?.getClip()?.duration || 0,
      targets: (meta?.targets || []).map((target) => ({
        node: target.node,
        object: target.object?.name || target.object?.uuid || target.node,
        property: target.property,
        position: target.object?.position?.toArray() || null,
        quaternion: target.object?.quaternion?.toArray() || null,
        scale: target.object?.scale?.toArray() || null,
        rest: target.rest,
      })),
    };
  }

  getEmissiveState() {
    return Array.from(this._emissiveOriginals.entries()).map(([material, original]) => ({
      uuid: material.uuid,
      name: material.name || material.type || 'material',
      emissive: material.emissive.toArray(),
      original: original.toArray(),
    }));
  }

  /**
   * Load a NEON RANGE `.anims.json` library for the current model. The build
   * happens before committing so a malformed library or a missing node never
   * destroys the clips that are currently playing.
   */
  async loadNeonAnimations(input, { label = null, url = null } = {}) {
    if (!this.model) throw new Error('Load a model before attaching a .anims.json library.');
    const library = parseNeonAnimationLibrary(input, {
      label: label || (url ? fileNameFromURL(url) : 'anims.json'),
      url,
    });
    const built = buildNeonAnimationClips(library, this.model, { restPose: this._restPose });

    this._restoreEmissive();
    this.neonLibrary = library;
    this._neonBuild = built;
    this._rebuildAnimationLibrary({ preserveActive: true, neonBuild: built });

    const summary = summarizeNeonLibrary(library);
    this._emit('animationlibrary', summary);
    return summary;
  }

  async loadNeonAnimationsFromURL(url) {
    if (!url) throw new Error('No .anims.json URL was provided.');
    let response;
    try {
      response = await fetch(url, { cache: 'no-store' });
    } catch (error) {
      throw new Error(
        `Could not fetch animation library ${fileNameFromURL(url)}. Check the URL and that serve.py is running.`,
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new Error(`Could not fetch animation library ${fileNameFromURL(url)} (HTTP ${response.status}).`);
    }
    const text = await response.text();
    return this.loadNeonAnimations(text, { label: fileNameFromURL(url), url });
  }

  async loadNeonAnimationsFromFile(file) {
    if (!file) throw new Error('No .anims.json file was provided.');
    const text = await file.text();
    return this.loadNeonAnimations(text, { label: file.name || 'anims.json' });
  }

  _rebuildAnimationLibrary({ preserveActive = true, neonBuild = null } = {}) {
    const previous = preserveActive && this.activeAction
      ? {
        source: this.animationMeta[this.activeClipIndex]?.source || null,
        name: this.activeAction.getClip()?.name || null,
        time: this.activeAction.time,
        playing: this.playing,
      }
      : null;

    this._restoreEmissive();
    this._restoreRestPose();
    this._teardownMixer();

    this.animations = [];
    this.animationMeta = [];
    for (const clip of this.gltf?.animations || []) {
      this.animations.push(clip);
      this.animationMeta.push({
        source: 'gltf',
        name: clip.name || 'Untitled clip',
        looping: true,
        targets: [],
        emissiveTracks: [],
      });
    }
    if (this.neonLibrary) this._appendNeonClips(neonBuild);

    if (!this.animations.length) {
      this.playing = false;
      this.activeClipIndex = -1;
      this._emitAnimationState();
      return;
    }

    this._createMixerAndActions();
    let index = 0;
    let time = 0;
    let playing = true;
    if (previous) {
      const found = this.animationMeta.findIndex((meta, metaIndex) => (
        meta.source === previous.source && (this.animations[metaIndex]?.name || '') === previous.name
      ));
      if (found >= 0) {
        index = found;
        time = previous.time;
        playing = previous.playing;
      }
    }
    this._activateClip(index, { emit: false, time, playing });
    this._emitAnimationState();
  }

  async _attachSidecarForInfo(info, animsUrl) {
    if (!animsUrl) return;
    try {
      info.neonAnimations = await this.loadNeonAnimationsFromURL(animsUrl);
    } catch (error) {
      info.neonAnimationError = this._reportSidecarError(error, fileNameFromURL(animsUrl), animsUrl);
    }
  }

  _reportSidecarError(error, label, source = null) {
    const message = error?.message || `Could not read ${label}.`;
    if (this.info) this.info.neonAnimationError = message;
    this._emit('animsloaderror', { message, label, source, error });
    return message;
  }


  /* ------------------------------------------------------------
     Capture + lifecycle
     ------------------------------------------------------------ */

  captureScreenshot(mode = this.backgroundMode) {
    if (!this.model) throw new Error('Load a model before taking a screenshot.');
    this.controls.update();
    this._renderFrame();
    const source = this.renderer.domElement;
    const width = source.width;
    const height = source.height;

    if (mode === 'transparent') {
      return source.toDataURL('image/png');
    }

    const output = document.createElement('canvas');
    output.width = width;
    output.height = height;
    const context = output.getContext('2d');
    if (!context) throw new Error('Could not create the screenshot canvas.');

    context.fillStyle = '#04060b';
    context.fillRect(0, 0, width, height);

    if (mode === 'gradient') {
      const cyanGlow = context.createRadialGradient(
        width * 0.14, height * 0.02, 0,
        width * 0.14, height * 0.02, Math.max(width, height) * 0.72,
      );
      cyanGlow.addColorStop(0, 'rgba(36, 133, 156, 0.24)');
      cyanGlow.addColorStop(0.55, 'rgba(10, 38, 49, 0.10)');
      cyanGlow.addColorStop(1, 'rgba(4, 6, 11, 0)');
      context.fillStyle = cyanGlow;
      context.fillRect(0, 0, width, height);

      const orangeGlow = context.createRadialGradient(
        width * 0.87, height * 0.95, 0,
        width * 0.87, height * 0.95, Math.max(width, height) * 0.62,
      );
      orangeGlow.addColorStop(0, 'rgba(132, 69, 22, 0.18)');
      orangeGlow.addColorStop(1, 'rgba(4, 6, 11, 0)');
      context.fillStyle = orangeGlow;
      context.fillRect(0, 0, width, height);

      context.strokeStyle = 'rgba(70, 230, 255, 0.038)';
      context.lineWidth = Math.max(1, width / 1600);
      const step = Math.max(32, width / 22);
      for (let x = 0; x < width; x += step) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
      for (let y = 0; y < height; y += step) {
        context.beginPath();
        context.moveTo(0, y);
        context.lineTo(width, y);
        context.stroke();
      }
    } else {
      const darkGlow = context.createRadialGradient(
        width * 0.5, height * 0.4, 0,
        width * 0.5, height * 0.4, Math.max(width, height) * 0.7,
      );
      darkGlow.addColorStop(0, 'rgba(12, 29, 40, 0.42)');
      darkGlow.addColorStop(1, 'rgba(4, 6, 11, 0)');
      context.fillStyle = darkGlow;
      context.fillRect(0, 0, width, height);
    }

    context.drawImage(source, 0, 0);
    return output.toDataURL('image/png');
  }

  getScreenAxes() {
    const inverse = this.camera.quaternion.clone().invert();
    const axes = {};
    for (const [name, vector] of Object.entries({
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1),
    })) {
      vector.applyQuaternion(inverse);
      axes[name] = { x: vector.x, y: -vector.y, depth: vector.z };
    }
    return axes;
  }

  getRenderStats() {
    return {
      fps: this._lastFps || 0,
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  _tick() {
    const frameNow = performance.now();
    const delta = Math.min((frameNow - this._lastFrameAt) / 1000, 0.1);
    this._lastFrameAt = frameNow;
    this.controls.update();

    if (this.mixer && this.playing && this.activeAction) {
      this.mixer.update(delta * this.animationSpeed);
      if (this._activeEmissiveTracks.length) this._applyEmissiveAt(this.activeAction.time);
      const now = performance.now();
      if (now - this._lastAnimEmit > 90) {
        this._lastAnimEmit = now;
        this._emitAnimationState();
      }
    }

    this._updateSelectionHelper();
    this._renderFrame();

    this._frameCounter += 1;
    const now = performance.now();
    const elapsed = now - this._lastStatsAt;
    if (elapsed >= 500) {
      this._lastFps = Math.round((this._frameCounter * 1000) / elapsed);
      this._frameCounter = 0;
      this._lastStatsAt = now;
      this._emit('renderstats', {
        fps: this._lastFps,
        calls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
      });
    }
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _emitProgress(percent, detail) {
    this._emit('loadprogress', { percent, detail });
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this._resizeObserver?.disconnect();
    window.removeEventListener('resize', this._onWindowResize);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    this.canvas.removeEventListener('pointerup', this._onPointerUp);
    this.canvas.removeEventListener('dblclick', this._onDoubleClick);
    this.controls.dispose();
    this.setPostProcessing(null);
    this._clearCurrentModel();
    this.selectionBox?.geometry.dispose();
    this.selectionBox?.material.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.axes.geometry.dispose();
    this.axes.material.dispose();
    this.environmentTarget?.dispose();
    this.renderer.dispose();
  }
}
