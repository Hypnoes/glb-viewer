import * as THREE from 'three';

/**
 * NEON RANGE sidecar animation libraries (`assets/anims/*.anims.json`).
 *
 * The Rust player in `fps-demo/crates/neon_anim` is the authority for these
 * semantics. This module mirrors it:
 *
 * - `translation` adds a metre offset to the node's bind translation.
 * - `rotation_euler_deg` appends an XYZ Euler offset after the bind rotation
 *   (`bindQuat * fromEuler(offset, 'XYZ')`).
 * - `scale` multiplies the bind scale.
 * - `emissive_scale` multiplies the material's authored emissive colour. The
 *   mixer cannot drive that, so the viewer applies it per frame.
 * - `$self` addresses the loaded model root; other names address glTF nodes.
 * - `looping` defaults to false; one-shot clips clamp at their final pose.
 *
 * Clips are converted to dense three.js keyframe tracks (~60 Hz). Dense
 * sampling keeps `linear` / `step` / `smooth` (smoothstep) semantics identical
 * at every visible frame instead of approximating step curves with linear
 * interpolation.
 */

export const SELF_NODE = '$self';
export const NEON_ANIM_SCHEMA = 1;
export const NEON_ANIM_SAMPLE_HZ = 60;
export const SUPPORTED_PROPERTIES = Object.freeze([
  'translation',
  'rotation_euler_deg',
  'scale',
  'emissive_scale',
]);
export const SUPPORTED_INTERPOLATIONS = Object.freeze(['linear', 'step', 'smooth']);

const TRANSFORM_PROPERTIES = new Set(['translation', 'rotation_euler_deg', 'scale']);
const DURATION_EPSILON = 1e-6;

export class NeonAnimError extends Error {
  constructor(message, { path = null, label = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'NeonAnimError';
    this.path = path;
    this.label = label;
  }
}

function fail(label, path, message) {
  const location = path ? `${label} · ${path}` : label;
  throw new NeonAnimError(`${location}: ${message}`, { path, label });
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteVec3(value) {
  return Array.isArray(value)
    && value.length === 3
    && value.every((component) => Number.isFinite(Number(component)));
}

/**
 * Validate and normalise a sidecar animation library.
 *
 * @param {string|object} input JSON text or an already parsed object.
 * @param {{label?: string, url?: string|null}} options
 * @returns {{schema: number, asset: string, clips: Array, label: string, url: string|null}}
 */
export function parseNeonAnimationLibrary(input, { label = 'anims.json', url = null } = {}) {
  const sourceLabel = String(label || 'anims.json');
  let data = input;

  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (error) {
      fail(sourceLabel, null, `invalid JSON — ${error.message}`);
    }
  }

  if (!isObject(data)) fail(sourceLabel, null, 'expected a JSON object at the top level');
  if (data.schema !== NEON_ANIM_SCHEMA) {
    fail(sourceLabel, 'schema', `unsupported schema ${JSON.stringify(data.schema)}; this viewer supports schema 1`);
  }
  if (typeof data.asset !== 'string' || !data.asset.trim()) {
    fail(sourceLabel, 'asset', 'must be a non-empty string such as "prp.drone.mk2"');
  }
  if (!Array.isArray(data.clips) || data.clips.length === 0) {
    fail(sourceLabel, 'clips', 'must be a non-empty array');
  }

  const names = new Set();
  const clips = data.clips.map((clip, index) => parseClip(clip, `clips[${index}]`, sourceLabel, names));

  return {
    schema: NEON_ANIM_SCHEMA,
    asset: data.asset.trim(),
    clips,
    label: sourceLabel,
    url: url || null,
  };
}

function parseClip(raw, path, label, names) {
  if (!isObject(raw)) fail(label, path, 'must be an object');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail(label, `${path}.name`, 'must be a non-empty string');
  if (names.has(name)) fail(label, `${path}.name`, `duplicate clip "${name}" (clip names must be unique)`);
  names.add(name);

  const duration = Number(raw.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    fail(label, `${path}.duration`, `must be a positive number of seconds (got ${JSON.stringify(raw.duration)})`);
  }

  let looping = false;
  if (raw.looping !== undefined) {
    if (typeof raw.looping !== 'boolean') fail(label, `${path}.looping`, 'must be true or false');
    looping = raw.looping;
  }

  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
    fail(label, `${path}.tracks`, 'must be a non-empty array');
  }

  const seenTracks = new Set();
  const tracks = raw.tracks.map((track, index) => {
    const trackPath = `${path}.tracks[${index}]`;
    if (!isObject(track)) fail(label, trackPath, 'must be an object');

    const node = typeof track.node === 'string' ? track.node.trim() : '';
    if (!node) fail(label, `${trackPath}.node`, `must name a glTF node or "${SELF_NODE}"`);

    const property = track.property;
    if (!SUPPORTED_PROPERTIES.includes(property)) {
      fail(
        label,
        `${trackPath}.property`,
        `unknown property ${JSON.stringify(property)}; expected one of ${SUPPORTED_PROPERTIES.join(', ')}`,
      );
    }

    const interpolation = track.interpolation === undefined ? 'linear' : track.interpolation;
    if (!SUPPORTED_INTERPOLATIONS.includes(interpolation)) {
      fail(
        label,
        `${trackPath}.interpolation`,
        `unknown interpolation ${JSON.stringify(interpolation)}; expected linear, step or smooth`,
      );
    }

    if (!Array.isArray(track.keys) || track.keys.length === 0) {
      fail(label, `${trackPath}.keys`, 'must contain at least one key');
    }

    const keyId = `${node}\u0000${property}`;
    if (seenTracks.has(keyId)) {
      fail(label, `${trackPath}.property`, `duplicate track for node "${node}" and property "${property}"`);
    }
    seenTracks.add(keyId);

    let previous = -1;
    const keys = track.keys.map((key, keyIndex) => {
      const keyPath = `${trackPath}.keys[${keyIndex}]`;
      if (!isObject(key)) fail(label, keyPath, 'must be an object with "t" and "value"');

      const t = Number(key.t);
      if (!Number.isFinite(t)) fail(label, `${keyPath}.t`, 'must be a finite number of seconds');
      if (t < 0) fail(label, `${keyPath}.t`, 'must not be negative');
      if (keyIndex > 0 && t === previous) fail(label, `${keyPath}.t`, 'key times must be unique');
      if (t < previous) fail(label, `${keyPath}.t`, 'keys must be ordered by ascending time');
      previous = t;

      if (!finiteVec3(key.value)) {
        fail(label, `${keyPath}.value`, 'must be an array of three finite numbers');
      }
      const value = key.value.map(Number);
      if (property === 'scale' && value.some((component) => component < 0.0001)) {
        fail(label, `${keyPath}.value`, 'scale factors must be at least 0.0001');
      }

      return { t, value };
    });

    const last = keys[keys.length - 1];
    if (last.t > duration + DURATION_EPSILON) {
      fail(
        label,
        `${trackPath}.keys`,
        `last key at ${last.t}s exceeds the clip duration of ${duration}s`,
      );
    }

    return { node, property, interpolation, keys };
  });

  return { name, duration, looping, tracks };
}

/**
 * Sample one track at `time` (seconds). Exact port of `AnimTrack::sample`:
 * values clamp outside the key range, step returns the lower key, smooth uses
 * smoothstep easing.
 */
export function sampleTrack(track, time) {
  const keys = track?.keys;
  if (!Array.isArray(keys) || keys.length === 0) return [0, 0, 0];
  const t = Number(time);
  if (!Number.isFinite(t) || t <= keys[0].t || keys.length === 1) return keys[0].value.slice();
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.value.slice();

  let low = 0;
  let high = keys.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (keys[middle].t < t) low = middle + 1;
    else high = middle;
  }

  const upper = keys[low];
  const lower = keys[low - 1];
  if (track.interpolation === 'step') return lower.value.slice();

  const span = upper.t - lower.t;
  let alpha = span > 0 ? (t - lower.t) / span : 0;
  if (track.interpolation === 'smooth') alpha = alpha * alpha * (3 - 2 * alpha);

  return [
    lower.value[0] + (upper.value[0] - lower.value[0]) * alpha,
    lower.value[1] + (upper.value[1] - lower.value[1]) * alpha,
    lower.value[2] + (upper.value[2] - lower.value[2]) * alpha,
  ];
}

function snapshot(object) {
  return {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
  };
}

function sampleTimes(duration, sampleHz) {
  const count = Math.max(2, Math.ceil(duration * sampleHz) + 1);
  const times = new Array(count);
  for (let index = 0; index < count; index += 1) {
    times[index] = (index / (count - 1)) * duration;
  }
  return times;
}

function collectEmissiveMaterials(object) {
  const materials = [];
  object.traverse((child) => {
    if (!child.isMesh) return;
    const list = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of list) {
      if (material?.emissive?.isColor && !materials.includes(material)) materials.push(material);
    }
  });
  return materials;
}

function makeTransformTrack(track, object, rest, duration, sampleHz) {
  const times = sampleTimes(duration, sampleHz);
  const values = [];
  let previousQuaternion = null;
  const euler = new THREE.Euler();
  const offset = new THREE.Quaternion();

  for (const time of times) {
    const value = sampleTrack(track, time);
    if (track.property === 'translation') {
      values.push(
        rest.position.x + value[0],
        rest.position.y + value[1],
        rest.position.z + value[2],
      );
    } else if (track.property === 'scale') {
      values.push(
        rest.scale.x * value[0],
        rest.scale.y * value[1],
        rest.scale.z * value[2],
      );
    } else {
      euler.set(
        THREE.MathUtils.degToRad(value[0]),
        THREE.MathUtils.degToRad(value[1]),
        THREE.MathUtils.degToRad(value[2]),
        'XYZ',
      );
      offset.setFromEuler(euler);
      const quaternion = rest.quaternion.clone().multiply(offset);
      if (previousQuaternion && previousQuaternion.dot(quaternion) < 0) {
        quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
      }
      previousQuaternion = quaternion;
      values.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
    }
  }

  const trackName = `${object.uuid}.${track.property === 'translation' ? 'position' : track.property === 'scale' ? 'scale' : 'quaternion'}`;
  if (track.property === 'rotation_euler_deg') {
    return new THREE.QuaternionKeyframeTrack(trackName, times, values);
  }
  return new THREE.VectorKeyframeTrack(trackName, times, values);
}

/**
 * Resolve every track against the loaded model and build three.js clips.
 *
 * `restPose` must be captured immediately after the model is installed; the
 * viewer keeps that map so a sidecar loaded later still offsets the bind pose
 * instead of whatever pose the previous clip left behind.
 *
 * @param {object} library parsed library from `parseNeonAnimationLibrary`
 * @param {THREE.Object3D} root loaded glTF scene root
 * @param {{restPose?: Map, sampleHz?: number}} options
 */
export function buildNeonAnimationClips(library, root, { restPose = new Map(), sampleHz = NEON_ANIM_SAMPLE_HZ } = {}) {
  if (!root?.isObject3D) throw new NeonAnimError('A loaded model is required before building sidecar clips.');
  const label = library.label || 'anims.json';

  const named = new Map();
  root.traverse((object) => {
    if (object === root || !object.name) return;
    if (!named.has(object.name)) named.set(object.name, object);
  });

  const missing = [];
  const resolved = library.clips.map((clip) => {
    const items = clip.tracks.map((track) => {
      const object = track.node === SELF_NODE ? root : named.get(track.node);
      if (!object) {
        missing.push(`${clip.name} → "${track.node}"`);
        return { track, object: null, rest: null };
      }
      return {
        track,
        object,
        rest: restPose.get(object) || snapshot(object),
      };
    });
    return { clip, items };
  });

  if (missing.length) {
    const unique = Array.from(new Set(missing));
    throw new NeonAnimError(
      `${label}: node${unique.length === 1 ? '' : 's'} not found in the loaded model — ${unique.join(', ')}`,
      { label },
    );
  }

  return {
    library,
    clips: resolved.map(({ clip, items }) => {
      const transformTracks = [];
      const emissiveTracks = [];
      const targets = [];

      for (const { track, object, rest } of items) {
        targets.push({
          node: track.node,
          property: track.property,
          object,
          rest: {
            position: rest.position.toArray(),
            quaternion: rest.quaternion.toArray(),
            scale: rest.scale.toArray(),
          },
        });
        if (track.property === 'emissive_scale') {
          emissiveTracks.push({
            node: track.node,
            track,
            object,
            materials: collectEmissiveMaterials(object),
          });
        } else if (TRANSFORM_PROPERTIES.has(track.property)) {
          transformTracks.push(makeTransformTrack(track, object, rest, clip.duration, sampleHz));
        }
      }

      const threeClip = new THREE.AnimationClip(clip.name, clip.duration, transformTracks);
      return {
        clip: threeClip,
        meta: {
          source: 'neon',
          name: clip.name,
          looping: clip.looping,
          asset: library.asset,
          label: library.label,
          url: library.url,
          targets,
          emissiveTracks,
          trackCount: clip.tracks.length,
          transformTrackCount: transformTracks.length,
        },
      };
    }),
  };
}

/** Human-readable clip summary used by the viewer state and tests. */
export function summarizeNeonLibrary(library) {
  return {
    asset: library.asset,
    label: library.label,
    url: library.url,
    count: library.clips.length,
    clips: library.clips.map((clip) => ({
      name: clip.name,
      duration: clip.duration,
      looping: clip.looping,
      tracks: clip.tracks.length,
      emissiveTracks: clip.tracks.filter((track) => track.property === 'emissive_scale').length,
    })),
  };
}
