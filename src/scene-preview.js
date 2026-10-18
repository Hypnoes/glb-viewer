import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const TONEMAP_APPROX = {
  tony_mc_mapface: { value: THREE.NeutralToneMapping, label: 'Neutral (Tony McMapface approximation)' },
  tony_mcmapface: { value: THREE.NeutralToneMapping, label: 'Neutral (Tony McMapface approximation)' },
  neutral: { value: THREE.NeutralToneMapping, label: 'Neutral' },
  aces: { value: THREE.ACESFilmicToneMapping, label: 'ACES Filmic' },
  agx: { value: THREE.AgXToneMapping, label: 'AgX' },
  reinhard: { value: THREE.ReinhardToneMapping, label: 'Reinhard' },
  cineon: { value: THREE.CineonToneMapping, label: 'Cineon' },
  linear: { value: THREE.LinearToneMapping, label: 'Linear' },
  none: { value: THREE.NoToneMapping, label: 'None' },
};

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toVectorArray(value) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const result = value.slice(0, 3).map((entry) => toNumber(entry, 0));
  return Number.isFinite(result[0]) && Number.isFinite(result[1]) && Number.isFinite(result[2]) ? result : null;
}

/** Scene colours are authored as linear RGB in the Rust contract. */
function linearColor(value, fallback = 0xffffff) {
  const array = toVectorArray(value);
  const color = new THREE.Color();
  if (array) color.setRGB(clampNumber(array[0], 0, 1), clampNumber(array[1], 0, 1), clampNumber(array[2], 0, 1), THREE.LinearSRGBColorSpace);
  else color.set(fallback);
  return color;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function roundArray(array, digits = 3) {
  return array.map((value) => round(value, digits));
}

function normalizePath(url) {
  try {
    return new URL(url, window.location.href).href;
  } catch {
    return null;
  }
}

function sceneDirUrl(sceneUrl) {
  return new URL('.', sceneUrl).href;
}

function ensureTrailingSlash(url) {
  return url.endsWith('/') ? url : `${url}/`;
}

function collectString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeManifest(raw) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.assets)
      ? raw.assets
      : raw?.assets && typeof raw.assets === 'object'
        ? Object.entries(raw.assets).map(([id, entry]) => ({ id, ...(entry || {}) }))
        : [];

  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({
      ...entry,
      id: collectString(entry.id ?? entry.asset_id ?? entry.assetId),
    }))
    .filter((entry) => Boolean(entry.id));
}

function resolveAssetUrl(entry, baseUrl) {
  const raw = collectString(entry.path ?? entry.url ?? entry.file ?? entry.src);
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  if (raw.startsWith('//')) return `${window.location.protocol}${raw}`;
  if (raw.startsWith('/')) return new URL(raw, window.location.origin).href;
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

function applyTransform(object, transform = {}, fallback = {}) {
  const translation = transform.translation ?? transform.position ?? fallback.translation ?? fallback.position;
  const rotation = transform.rotation ?? transform.euler_xyz ?? fallback.rotation;
  const rotationY = transform.rotation_y ?? transform.rotationY ?? fallback.rotation_y ?? fallback.rotationY;
  const scale = transform.scale ?? fallback.scale;

  const vector = toVectorArray(translation);
  if (vector) object.position.fromArray(vector);

  const euler = toVectorArray(rotation);
  if (euler) object.rotation.set(euler[0], euler[1], euler[2]);
  else if (rotationY !== undefined && rotationY !== null) object.rotation.y = toNumber(rotationY, 0);

  if (typeof scale === 'number') {
    object.scale.setScalar(scale);
  } else if (Array.isArray(scale) && scale.length >= 3) {
    const values = scale.slice(0, 3).map((entry) => toNumber(entry, 1));
    if (values.every((entry) => entry !== 0)) object.scale.fromArray(values);
  } else if (scale && typeof scale === 'object') {
    const x = toNumber(scale.x ?? scale[0], 1);
    const y = toNumber(scale.y ?? scale[1], 1);
    const z = toNumber(scale.z ?? scale[2], 1);
    object.scale.set(x || 1, y || 1, z || 1);
  }
}

function disposeObject3D(root) {
  if (!root) return;
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
      if (material.map?.isTexture) textures.add(material.map);
    }
  });
  for (const geometry of geometries) geometry.dispose?.();
  for (const material of materials) material.dispose?.();
  for (const texture of textures) texture.dispose?.();
}

function clearHelperGroup(group) {
  if (!group) return;
  disposeObject3D(group);
  group.clear();
}

function makeLabelSprite(text, color = '#46e6ff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = 'rgba(4, 6, 11, 0.72)';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
  context.font = '700 24px "Cascadia Mono", Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = color;
  context.fillText(text, canvas.width / 2, canvas.height / 2 + 1);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.35, 0.34, 1);
  sprite.renderOrder = 20;
  return sprite;
}

function countGeometry(root) {
  let meshes = 0;
  let triangles = 0;
  let vertices = 0;
  root.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    const geometry = object.geometry;
    const positionCount = geometry?.attributes?.position?.count || 0;
    const indexCount = geometry?.index?.count || positionCount;
    const instances = object.isInstancedMesh ? Math.max(1, object.count) : 1;
    vertices += positionCount * instances;
    triangles += Math.floor(indexCount / 3) * instances;
  });
  return { meshes, triangles, vertices };
}

function collectMaterials(root) {
  const map = new Map();
  root.traverse((object) => {
    if (!object.isMesh) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) {
      if (!material) continue;
      let entry = map.get(material.uuid);
      if (!entry) {
        const emissive = material.emissive?.isColor ? material.emissive : null;
        const hasEmissive = emissive ? emissive.r + emissive.g + emissive.b > 0.002 : false;
        entry = {
          uuid: material.uuid,
          name: material.name || material.type || 'Unnamed material',
          type: material.type || 'Material',
          color: material.color?.isColor ? `#${material.color.getHexString()}` : '#7d8f99',
          emissive: hasEmissive ? `#${emissive.getHexString()}` : null,
          emissiveIntensity: Number.isFinite(material.emissiveIntensity) ? material.emissiveIntensity : 1,
          transparent: Boolean(material.transparent),
          opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
          metalness: Number.isFinite(material.metalness) ? material.metalness : null,
          roughness: Number.isFinite(material.roughness) ? material.roughness : null,
          uses: 0,
          meshes: [],
        };
        map.set(material.uuid, entry);
      }
      entry.uses += 1;
      entry.meshes.push(object);
    }
  });
  return Array.from(map.values());
}

function makeLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader;
}

/**
 * Read-only NEON RANGE scene/UI inspector.
 *
 * Scene mode composes `manifest.json` + `scene.json` into a temporary three.js
 * scene. It is deliberately not an editor: nothing here writes back to disk or
 * mutates scene JSON.
 */
export class ScenePreview {
  constructor({ viewer }) {
    this.viewer = viewer;
    this.loader = makeLoader();
    this.assetCache = new Map();
    this.assets = new Map();
    this.manifest = null;
    this.sceneData = null;
    this.instanceRoot = new THREE.Group();
    this.instanceRoot.name = 'SCENE_ROOT';
    this.helperGroup = new THREE.Group();
    this.helperGroup.name = 'SCENE_HELPERS';
    this.markerGroup = new THREE.Group();
    this.markerGroup.name = 'TARGET_SLOTS';
    this.colliderGroup = new THREE.Group();
    this.colliderGroup.name = 'COLLIDERS';
    this.spawnGroup = new THREE.Group();
    this.spawnGroup.name = 'SPAWN';
    this.lightGroup = new THREE.Group();
    this.lightGroup.name = 'SCENE_LIGHTS';
    this.cameraLights = [];
    this.targetGroup = null;
    this.targetsEnabled = true;
    this.materials = [];
    this.state = this._emptyState();
  }

  _emptyState() {
    return {
      ready: false,
      loading: false,
      origin: null,
      sceneId: null,
      sceneUrl: null,
      manifestUrl: null,
      assetBase: null,
      pack: null,
      packVersion: null,
      environmentAsset: null,
      counts: {
        authoredAssets: 0,
        assetsUsed: 0,
        instances: 0,
        environmentInstances: 0,
        propInstances: 0,
        targetInstances: 0,
        targetSlots: 0,
        colliders: 0,
        lights: 0,
        spawnPoints: 0,
        meshes: 0,
        triangles: 0,
        vertices: 0,
        materials: 0,
      },
      bounds: null,
      camera: null,
      post: null,
      lights: [],
      instances: [],
      targetSlots: [],
      colliders: [],
      spawn: null,
      errors: [],
      warnings: [],
    };
  }

  getState() {
    const state = this.state;
    return {
      ...state,
      counts: { ...state.counts },
      bounds: state.bounds ? { ...state.bounds } : null,
      camera: state.camera ? { ...state.camera } : null,
      post: state.post ? { ...state.post } : null,
      lights: state.lights.map((entry) => ({ ...entry })),
      instances: state.instances.map((entry) => ({ ...entry, transform: { ...entry.transform } })),
      targetSlots: state.targetSlots.map((entry) => ({ ...entry, position: [...entry.position] })),
      colliders: state.colliders.map((entry) => ({
        ...entry,
        center: [...entry.center],
        half: [...entry.half],
      })),
      spawn: state.spawn ? { ...state.spawn, position: [...state.spawn.position] } : null,
      errors: [...state.errors],
      warnings: [...state.warnings],
    };
  }

  getMaterials() {
    return this.materials;
  }

  _progress(percent, detail) {
    this.viewer?._emit?.('loadprogress', { percent, detail });
  }

  _warn(message) {
    if (!this.state.warnings.includes(message)) this.state.warnings.push(message);
  }

  _error(message) {
    if (!this.state.errors.includes(message)) this.state.errors.push(message);
  }

  async load({ sceneUrl, manifestUrl, assetBase, includeTargets = true, bloomOverride = null } = {}) {
    const resolvedSceneUrl = normalizePath(sceneUrl);
    if (!resolvedSceneUrl) throw new Error('No scene URL was provided.');

    this._teardown();
    this.state = this._emptyState();
    this.state.loading = true;
    this.state.sceneUrl = resolvedSceneUrl;
    this.state.origin = resolvedSceneUrl.includes('/project-assets/')
      ? 'project-assets'
      : resolvedSceneUrl.includes('/samples/neon/')
        ? 'fixture'
        : 'custom';

    try {
      this._progress(5, 'Fetching scene JSON…');
      const sceneData = await this._fetchJSON(resolvedSceneUrl).catch((error) => {
        throw new Error(`Scene JSON could not be loaded from ${resolvedSceneUrl}: ${error.message}`);
      });
      if (!sceneData || typeof sceneData !== 'object') throw new Error('Scene JSON is empty or not an object.');
      this.sceneData = sceneData;
      this.state.sceneId = collectString(sceneData.id) || 'scene';

      this._progress(12, 'Resolving manifest…');
      const { data: manifestData, url: resolvedManifestUrl } = await this._loadManifest({
        sceneUrl: resolvedSceneUrl,
        sceneData,
        manifestUrl,
      });
      this.manifest = manifestData;
      this.state.manifestUrl = resolvedManifestUrl;
      this.state.pack = collectString(manifestData.pack) || null;
      this.state.packVersion = collectString(manifestData.version) || null;

      const assets = normalizeManifest(manifestData);
      if (!assets.length) throw new Error('Manifest contains no assets.');
      const baseUrl = this._resolveAssetBase(manifestData, resolvedManifestUrl, assetBase);
      this.state.assetBase = baseUrl;
      let missingPaths = 0;
      for (const entry of assets) {
        const url = resolveAssetUrl(entry, baseUrl);
        if (!url) missingPaths += 1;
        this.assets.set(entry.id, { ...entry, url });
      }
      this.state.counts.authoredAssets = assets.length;
      if (missingPaths) this._warn(`${missingPaths} manifest asset(s) have no usable path.`);

      const scene = sceneData;
      const environment = scene.environment && typeof scene.environment === 'object' ? scene.environment : {};
      const props = Array.isArray(scene.props) ? scene.props : [];
      const targetSlots = Array.isArray(scene.target_slots)
        ? scene.target_slots
        : Array.isArray(scene.targets)
          ? scene.targets
          : [];
      const spawnSpec = scene.spawn || scene.player_spawn || environment.spawn || null;

      this.instanceRoot = new THREE.Group();
      this.instanceRoot.name = this.state.sceneId;
      const environmentGroup = new THREE.Group();
      environmentGroup.name = 'ENVIRONMENT';
      const propGroup = new THREE.Group();
      propGroup.name = 'PROPS';
      const targetGroup = new THREE.Group();
      targetGroup.name = 'TARGETS';
      targetGroup.visible = includeTargets;
      this.targetGroup = targetGroup;
      this.targetsEnabled = includeTargets;
      this.instanceRoot.add(environmentGroup, propGroup, targetGroup);

      const usedAssets = new Set();
      const instances = [];
      const slotEntries = targetSlots.map((slot, index) => ({
        id: collectString(slot.id) || `slot.${index}`,
        asset: collectString(slot.asset ?? slot.asset_id) || null,
        position: toVectorArray(slot.position) || [0, 0, 0],
        phase: toNumber(slot.phase, 0),
        rotationY: toNumber(slot.rotation_y ?? slot.rotationY, 0),
        loaded: false,
      }));

      this._progress(18, 'Loading environment…');
      const environmentId = collectString(environment.static_model ?? environment.model ?? environment.asset);
      let environmentCount = 0;
      if (environmentId) {
        this.state.environmentAsset = environmentId;
        try {
          const cached = await this._loadAsset(environmentId);
          usedAssets.add(environmentId);
          const object = this._instantiate(cached, environmentId, 'environment', environment.transform || {});
          environmentGroup.add(object);
          environmentCount += 1;
          instances.push({
            id: environmentId,
            asset: environmentId,
            kind: 'environment',
            url: cached.url,
            transform: this._transformSummary(environment.transform || {}),
          });
        } catch (error) {
          this._error(error.message);
        }
      } else {
        this._warn('environment.static_model is missing; only props will be shown.');
      }

      for (let index = 0; index < props.length; index += 1) {
        const prop = props[index] || {};
        const id = collectString(prop.id) || `prop.${index}`;
        const assetId = collectString(prop.asset ?? prop.asset_id);
        if (!assetId) {
          this._error(`Prop '${id}' has no asset id.`);
          continue;
        }
        const percent = 20 + Math.round(((index + 1) / Math.max(props.length, 1)) * 36);
        this._progress(percent, `Instancing ${assetId} (${index + 1}/${props.length})…`);
        try {
          const cached = await this._loadAsset(assetId);
          usedAssets.add(assetId);
          const transform = prop.transform || {};
          const object = this._instantiate(cached, id, 'prop', transform, prop);
          object.userData.sceneProp = { id, assetId };
          propGroup.add(object);
          instances.push({
            id,
            asset: assetId,
            kind: 'prop',
            url: cached.url,
            transform: this._transformSummary(transform),
          });
        } catch (error) {
          this._error(error.message);
        }
      }

      let targetInstances = 0;
      if (includeTargets) {
        for (let index = 0; index < slotEntries.length; index += 1) {
          const slot = slotEntries[index];
          if (!slot.asset) continue;
          const percent = 58 + Math.round(((index + 1) / Math.max(slotEntries.length, 1)) * 8);
          this._progress(percent, `Instancing target ${slot.asset} (${index + 1}/${slotEntries.length})…`);
          try {
            const cached = await this._loadAsset(slot.asset);
            usedAssets.add(slot.asset);
            const transform = {
              translation: slot.position,
              rotation_y: slot.rotationY,
              scale: [1, 1, 1],
            };
            const object = this._instantiate(cached, slot.id, 'target', transform);
            object.userData.sceneTarget = { slotId: slot.id, assetId: slot.asset, phase: slot.phase };
            targetGroup.add(object);
            slot.loaded = true;
            targetInstances += 1;
            instances.push({
              id: slot.id,
              asset: slot.asset,
              kind: 'target',
              slotId: slot.id,
              phase: slot.phase,
              url: cached.url,
              transform: this._transformSummary(transform),
            });
          } catch (error) {
            this._error(error.message);
          }
        }
      }

      this.instanceRoot.updateMatrixWorld(true);
      const propInstances = instances.filter((entry) => entry.kind === 'prop').length;
      this.state.counts.environmentInstances = environmentCount;
      this.state.counts.propInstances = propInstances;
      this.state.counts.targetInstances = targetInstances;
      this.state.counts.instances = environmentCount + propInstances + targetInstances;
      this.state.counts.assetsUsed = usedAssets.size;
      this.state.instances = instances;

      this.state.counts.targetSlots = slotEntries.length;
      this.state.targetSlots = slotEntries;

      this._progress(68, 'Building target markers and colliders…');
      this._buildMarkers(this.state.targetSlots);
      const colliders = this._buildColliders(props, propGroup);
      this.state.colliders = colliders;
      this.state.counts.colliders = colliders.length;

      const spawnPosition = toVectorArray(spawnSpec?.position ?? spawnSpec?.translation);
      if (spawnPosition) {
        this.state.spawn = {
          position: spawnPosition,
          rotationY: toNumber(spawnSpec?.rotation_y ?? spawnSpec?.rotationY, 0),
        };
        this._buildSpawn(spawnPosition);
        this.state.counts.spawnPoints = 1;
      }

      this._progress(74, 'Applying lights…');
      this._buildLights(environment);
      this.state.counts.lights = this.state.lights.length;

      const geometryCounts = countGeometry(this.instanceRoot);
      this.state.counts.meshes = geometryCounts.meshes;
      this.state.counts.triangles = geometryCounts.triangles;
      this.state.counts.vertices = geometryCounts.vertices;
      this.materials = collectMaterials(this.instanceRoot);
      this.state.counts.materials = this.materials.length;

      const box = new THREE.Box3().setFromObject(this.instanceRoot);
      this.state.bounds = box.isEmpty()
        ? { empty: true, min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] }
        : {
          empty: false,
          min: roundArray(box.min.toArray()),
          max: roundArray(box.max.toArray()),
          size: roundArray(box.getSize(new THREE.Vector3()).toArray()),
          center: roundArray(box.getCenter(new THREE.Vector3()).toArray()),
        };

      this._progress(84, 'Applying camera and post-processing…');
      const authoredCamera = Boolean(toVectorArray(environment.camera?.position));
      this._applyCamera(environment);
      this._applyPost(environment, bloomOverride);

      this.viewer.setSceneMode(true);
      this.viewer.attachScene(this.instanceRoot, {
        arenaHalf: toNumber(environment.arena_half, 18),
      });
      this.viewer.scene.add(this.helperGroup, this.lightGroup);
      this.helperGroup.add(this.markerGroup, this.colliderGroup, this.spawnGroup);

      if (!authoredCamera) {
        this.viewer.frame();
        this.state.camera = {
          position: roundArray(this.viewer.camera.position.toArray()),
          target: roundArray(this.viewer.controls.target.toArray()),
          fov: round(this.viewer.camera.fov, 2),
          near: round(this.viewer.camera.near, 4),
          far: round(this.viewer.camera.far, 2),
        };
      }

      this.state.loading = false;
      this.state.ready = true;
      this._progress(100, 'Scene ready.');
      return this.getState();
    } catch (error) {
      this.state.loading = false;
      this.state.ready = false;
      const message = error?.message || String(error);
      this._error(message);
      this._progress(null, 'Scene load failed.');
      throw error;
    }
  }

  async _fetchJSON(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    return response.json();
  }

  async _loadManifest({ sceneUrl, sceneData, manifestUrl }) {
    const candidates = [];
    const explicit = collectString(manifestUrl);
    if (explicit) candidates.push({ url: normalizePath(explicit), explicit: true });
    const inline = collectString(sceneData.manifest);
    if (inline) candidates.push({ url: normalizePath(new URL(inline, sceneUrl).href), explicit: false });
    if (!candidates.length) {
      candidates.push({ url: new URL('manifest.json', sceneUrl).href, explicit: false });
      candidates.push({ url: new URL('../manifest.json', sceneUrl).href, explicit: false });
    }

    const failures = [];
    for (const candidate of candidates) {
      if (!candidate.url) continue;
      try {
        const data = await this._fetchJSON(candidate.url);
        if (!normalizeManifest(data).length) throw new Error('manifest has no assets array');
        return { data, url: candidate.url };
      } catch (error) {
        failures.push(`${candidate.url} (${error.message})`);
        if (candidate.explicit) break;
      }
    }

    const detail = failures.length ? ` Tried: ${failures.join('; ')}` : '';
    throw new Error(
      `Manifest could not be loaded. Pass ?manifest=<url> or place manifest.json next to the scene.${detail}`,
    );
  }

  _resolveAssetBase(manifestData, manifestUrl, override) {
    const manifestDir = sceneDirUrl(manifestUrl);
    const requested = collectString(override)
      || collectString(manifestData?.asset_base)
      || collectString(manifestData?.assetBase);
    if (!requested) return manifestDir;
    try {
      return ensureTrailingSlash(new URL(requested, manifestUrl).href);
    } catch {
      this._warn(`Invalid asset_base '${requested}'; falling back to the manifest directory.`);
      return manifestDir;
    }
  }

  _loadAsset(assetId) {
    if (this.assetCache.has(assetId)) return this.assetCache.get(assetId);

    const promise = (async () => {
      const entry = this.assets.get(assetId);
      if (!entry) throw new Error(`Asset '${assetId}' is not declared in the manifest.`);
      if (!entry.url) throw new Error(`Asset '${assetId}' has no usable path.`);
      try {
        const gltf = await this.loader.loadAsync(entry.url);
        return { gltf, entry, url: entry.url };
      } catch (error) {
        throw new Error(`Asset '${assetId}' failed to load from ${entry.url}: ${error?.message || error}`);
      }
    })();

    this.assetCache.set(assetId, promise);
    promise.catch(() => this.assetCache.delete(assetId));
    return promise;
  }

  _instantiate(cached, name, kind, transform, prop = {}) {
    const object = cloneSkeleton(cached.gltf.scene);
    object.name = name;
    object.userData.sceneInstance = { id: name, assetId: cached.entry.id, kind };
    applyTransform(object, transform, prop);
    object.traverse((child) => {
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;
    });
    return object;
  }

  _transformSummary(transform = {}) {
    return {
      translation: toVectorArray(transform.translation ?? transform.position) || [0, 0, 0],
      rotationY: toNumber(transform.rotation_y ?? transform.rotationY, 0),
      scale: Array.isArray(transform.scale)
        ? transform.scale.slice(0, 3).map((entry) => toNumber(entry, 1))
        : typeof transform.scale === 'number'
          ? [transform.scale, transform.scale, transform.scale]
          : [1, 1, 1],
    };
  }

  _buildMarkers(slots) {
    clearHelperGroup(this.markerGroup);
    const ringGeometry = new THREE.RingGeometry(0.6, 0.7, 40);
    const dotGeometry = new THREE.SphereGeometry(0.06, 12, 8);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x46e6ff,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
      toneMapped: false,
    });
    const dotMaterial = new THREE.MeshBasicMaterial({
      color: 0xff8a2a,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
    });

    for (const slot of slots) {
      const group = new THREE.Group();
      group.name = slot.id;
      group.position.fromArray(slot.position);
      group.userData.targetSlot = slot;

      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 8;
      group.add(ring);

      const dot = new THREE.Mesh(dotGeometry, dotMaterial);
      dot.renderOrder = 9;
      group.add(dot);

      const label = makeLabelSprite(`${slot.id}${slot.phase ? ` · φ${slot.phase.toFixed(1)}` : ''}`);
      if (label) {
        label.position.set(0, slot.loaded ? 0.9 : 0.5, 0);
        group.add(label);
      }
      this.markerGroup.add(group);
    }
  }

  _buildColliders(props, propGroup) {
    clearHelperGroup(this.colliderGroup);
    const colliders = [];
    const instances = new Map();
    propGroup.children.forEach((child) => instances.set(child.name, child));
    const material = new THREE.LineBasicMaterial({
      color: 0x46e6ff,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
    });

    props.forEach((prop, index) => {
      const id = collectString(prop.id) || `prop.${index}`;
      const collider = prop.collider;
      if (!collider || typeof collider !== 'object') return;
      const instance = instances.get(id);
      const transform = prop.transform || {};
      let center = toVectorArray(collider.center ?? transform.translation ?? prop.position);
      let half = toVectorArray(collider.half);

      if (!half) {
        const full = toVectorArray(collider.size);
        if (full) half = full.map((value) => Math.abs(value) / 2);
      }

      let source = 'data';
      if ((!half || !center) && instance) {
        const box = new THREE.Box3().setFromObject(instance);
        if (!box.isEmpty()) {
          center = box.getCenter(new THREE.Vector3()).toArray();
          half = box.getSize(new THREE.Vector3()).toArray().map((value) => value / 2);
          source = 'mesh-bounds';
        }
      }

      if (!center || !half || half.some((value) => !Number.isFinite(value) || value <= 0)) {
        this._warn(`Collider '${id}' is missing half extents; skipped.`);
        return;
      }

      const geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(half[0] * 2, half[1] * 2, half[2] * 2));
      const lines = new THREE.LineSegments(geometry, material);
      lines.name = `collider:${id}`;
      lines.position.fromArray(center);
      lines.renderOrder = 7;
      this.colliderGroup.add(lines);

      colliders.push({
        id,
        type: collectString(collider.type) || 'aabb',
        center: roundArray(center),
        half: roundArray(half),
        source,
      });
    });

    return colliders;
  }

  _buildSpawn(position) {
    clearHelperGroup(this.spawnGroup);
    const group = new THREE.Group();
    group.name = 'SPAWN';
    group.position.fromArray(position);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 40),
      new THREE.MeshBasicMaterial({
        color: 0x8dffb0,
        transparent: true,
        opacity: 0.8,
        side: THREE.DoubleSide,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    group.add(ring);
    const label = makeLabelSprite('SPAWN', '#8dffb0');
    if (label) {
      label.position.set(0, 0.42, 0);
      group.add(label);
    }
    this.spawnGroup.add(group);
  }

  _buildLights(environment) {
    for (const light of this.cameraLights) {
      if (light.parent) light.parent.remove(light);
    }
    this.cameraLights = [];
    this.lightGroup.clear();
    this.state.lights = [];

    const specs = Array.isArray(environment.lights) ? environment.lights : [];
    specs.forEach((spec, index) => {
      const kind = String(spec?.kind || spec?.type || '').toLowerCase();
      const color = linearColor(spec?.color ?? spec?.sky_color, 0xffffff);
      let light = null;

      if (kind === 'ambient') {
        light = new THREE.AmbientLight(color, clampNumber(toNumber(spec.brightness ?? spec.intensity, 80) / 1000, 0, 4));
      } else if (kind === 'hemisphere') {
        const ground = linearColor(spec.ground_color ?? spec.groundColor, 0x0c0906);
        light = new THREE.HemisphereLight(color, ground, clampNumber(toNumber(spec.brightness ?? spec.intensity, 80) / 1000, 0, 4));
      } else if (kind === 'directional') {
        light = new THREE.DirectionalLight(
          color,
          clampNumber(toNumber(spec.illuminance ?? spec.intensity ?? spec.brightness, 7500) / 18000, 0, 12),
        );
        const position = toVectorArray(spec.position) || [0, 10, 0];
        light.position.fromArray(position);
        const target = toVectorArray(spec.look_at ?? spec.target) || [0, 0, 0];
        light.target.position.fromArray(target);
        light.target.updateMatrixWorld();
        this.lightGroup.add(light.target);
      } else if (kind === 'point') {
        const attached = String(spec.attach || '').toLowerCase() === 'camera';
        const divisor = attached ? 400000 : 80000;
        light = new THREE.PointLight(
          color,
          clampNumber(toNumber(spec.intensity ?? spec.brightness ?? spec.illuminance, 0) / divisor, 0.005, 200),
          Math.max(0.1, toNumber(spec.range ?? spec.distance, 10)),
          toNumber(spec.decay, 2),
        );
        light.position.fromArray(toVectorArray(spec.position) || [0, 0, 0]);
        if (attached) {
          this.viewer.scene.add(this.viewer.camera);
          this.viewer.camera.add(light);
          this.cameraLights.push(light);
        }
      } else if (kind === 'spot') {
        light = new THREE.SpotLight(
          color,
          clampNumber(toNumber(spec.intensity ?? spec.brightness ?? spec.illuminance, 0) / 50000, 0.005, 200),
          Math.max(0.1, toNumber(spec.range ?? spec.distance, 20)),
          clampNumber(toNumber(spec.outer_angle ?? spec.angle, Math.PI / 5), 0.01, Math.PI / 2),
          clampNumber(toNumber(spec.penumbra, 0.2), 0, 1),
          toNumber(spec.decay, 2),
        );
        light.position.fromArray(toVectorArray(spec.position) || [0, 5, 0]);
        const target = toVectorArray(spec.look_at ?? spec.target) || [0, 0, 0];
        light.target.position.fromArray(target);
        this.lightGroup.add(light.target);
      } else {
        this._warn(`Unsupported light kind '${spec?.kind || spec?.type || 'unknown'}' (#${index}) ignored.`);
        return;
      }

      light.name = `scene-light-${index}-${kind}`;
      light.castShadow = false;
      light.userData.sceneLight = spec;
      if (!this.cameraLights.includes(light)) this.lightGroup.add(light);

      this.state.lights.push({
        kind,
        color: spec?.color ?? null,
        attached: this.cameraLights.includes(light) ? 'camera' : 'world',
        intensity: round(light.intensity ?? 0, 3),
        authoredIntensity: round(toNumber(spec?.illuminance ?? spec?.intensity ?? spec?.brightness, 0), 3),
        distance: light.distance != null ? round(light.distance, 2) : null,
        position: light.position.toArray().map((value) => round(value, 2)),
      });
    });

    if (!this.state.lights.length) this._warn('Scene defines no lights; the preview may be black.');
  }

  _applyCamera(environment) {
    const camera = environment.camera && typeof environment.camera === 'object' ? environment.camera : {};
    this.viewer.setSceneCamera({
      position: toVectorArray(camera.position) || undefined,
      target: toVectorArray(camera.target) || undefined,
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
    });
    this.state.camera = {
      position: roundArray(this.viewer.camera.position.toArray()),
      target: roundArray(this.viewer.controls.target.toArray()),
      fov: round(this.viewer.camera.fov, 2),
      near: round(this.viewer.camera.near, 4),
      far: round(this.viewer.camera.far, 2),
    };
  }

  _applyPost(environment, bloomOverride = null) {
    const camera = environment.camera || {};
    const post = camera.post || environment.post || {};
    const scene = this.viewer.scene;

    const clear = environment.clear_color ?? environment.clearColor;
    const fogSpec = post.fog || environment.fog;
    let background = clear ? linearColor(clear) : new THREE.Color(0x04060b);
    if (fogSpec?.color) background = linearColor(fogSpec.color, background);

    scene.background = background.clone();
    this.viewer.renderer.setClearColor(background, 1);

    if (fogSpec) {
      scene.fog = new THREE.Fog(
        linearColor(fogSpec.color, background.getHex()),
        toNumber(fogSpec.start, 20),
        toNumber(fogSpec.end, 60),
      );
    } else {
      scene.fog = null;
    }

    const tonemappingKey = String(post.tonemapping ?? post.tone_mapping ?? post.toneMapping ?? 'aces').toLowerCase();
    const tonemap = TONEMAP_APPROX[tonemappingKey] || TONEMAP_APPROX.aces;
    this.viewer.renderer.toneMapping = tonemap.value;
    this.viewer.renderer.toneMappingExposure = clampNumber(toNumber(post.exposure, 1), 0.05, 8);

    const authoredBloom = clampNumber(toNumber(post.bloom ?? post.bloom_strength, 0), 0, 4);
    const overrideValue = bloomOverride === null || bloomOverride === undefined || bloomOverride === ''
      ? null
      : Number(bloomOverride);
    const bloomValue = clampNumber(
      overrideValue !== null && Number.isFinite(overrideValue) ? overrideValue : authoredBloom,
      0,
      4,
    );
    const bloomStrength = clampNumber(bloomValue * 0.23, 0, 1);
    this.state.post = {
      tonemapping: String(post.tonemapping ?? 'aces'),
      tonemappingApproximation: tonemap.label,
      exposure: this.viewer.renderer.toneMappingExposure,
      bloom: authoredBloom,
      bloomOverride: overrideValue,
      bloomPreviewStrength: bloomStrength,
      bloomPass: 'UnrealBloomPass (approximation)',
      fog: fogSpec
        ? {
          color: fogSpec.color ?? null,
          start: round(toNumber(fogSpec.start, 20), 2),
          end: round(toNumber(fogSpec.end, 60), 2),
        }
        : null,
      clearColor: background.toArray().slice(0, 3).map((value) => round(value, 4)),
      mounted: false,
    };

    if (bloomValue > 0) {
      try {
        const size = new THREE.Vector2();
        this.viewer.renderer.getSize(size);
        const composer = new EffectComposer(this.viewer.renderer);
        composer.setPixelRatio(this.viewer.renderer.getPixelRatio());
        composer.setSize(Math.max(1, size.x), Math.max(1, size.y));
        composer.addPass(new RenderPass(scene, this.viewer.camera));
        const bloomPass = new UnrealBloomPass(
          new THREE.Vector2(Math.max(1, size.x), Math.max(1, size.y)),
          bloomStrength,
          0.35,
          0.85,
        );
        composer.addPass(bloomPass);
        composer.addPass(new OutputPass());
        this.viewer.setPostProcessing(composer);
        this.state.post.mounted = true;
      } catch (error) {
        this._warn(`Bloom post-processing could not start: ${error?.message || error}`);
        this.viewer.setPostProcessing(null);
      }
    } else {
      this.viewer.setPostProcessing(null);
    }
  }

  setWireframe(enabled) {
    const wireframe = Boolean(enabled);
    this.instanceRoot.traverse((object) => {
      if (!object.isMesh) return;
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) {
        if (!material || !('wireframe' in material)) continue;
        material.wireframe = wireframe;
        material.needsUpdate = true;
      }
    });
  }

  setMarkersVisible(visible) {
    this.markerGroup.visible = Boolean(visible);
  }

  setCollidersVisible(visible) {
    this.colliderGroup.visible = Boolean(visible);
  }

  setTargetsVisible(visible) {
    this.targetsEnabled = Boolean(visible);
    if (this.targetGroup) this.targetGroup.visible = this.targetsEnabled;
  }

  setSpawnVisible(visible) {
    this.spawnGroup.visible = Boolean(visible);
  }

  dispose() {
    this._teardown();
    this.state = this._emptyState();
  }

  _teardown() {
    clearHelperGroup(this.markerGroup);
    clearHelperGroup(this.colliderGroup);
    clearHelperGroup(this.spawnGroup);
    clearHelperGroup(this.helperGroup);
    for (const light of this.cameraLights) {
      if (light.parent) light.parent.remove(light);
    }
    this.cameraLights = [];
    this.lightGroup.clear();
    this.helperGroup.parent?.remove(this.helperGroup);
    this.lightGroup.parent?.remove(this.lightGroup);
    this.materials = [];
    this.assetCache.clear();
    this.assets.clear();
    this.manifest = null;
    this.sceneData = null;
    this.targetGroup = null;

    this.viewer.setPostProcessing(null);
    if (this.instanceRoot.parent) {
      this.instanceRoot.parent.remove(this.instanceRoot);
    }
    if (this.viewer.model === this.instanceRoot) {
      this.viewer.model = null;
      this.viewer.gltf = null;
      this.viewer.info = null;
      this.viewer.box = null;
    }
    disposeObject3D(this.instanceRoot);
    this.instanceRoot = new THREE.Group();
    this.instanceRoot.name = 'SCENE_ROOT';
    this.viewer.scene.fog = null;
  }
}
