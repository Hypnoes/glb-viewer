import * as THREE from 'three';

function toHex(color) {
  if (!color || !color.isColor) return null;
  return `#${color.getHexString()}`;
}

function materialColor(material) {
  if (!material) return '#7d8f99';
  if (material.color?.isColor) return `#${material.color.getHexString()}`;
  const uniformColor =
    material.uniforms?.diffuse?.value?.isColor ? material.uniforms.diffuse.value :
    material.uniforms?.color?.value?.isColor ? material.uniforms.color.value :
    null;
  return toHex(uniformColor) || '#7d8f99';
}

function emissiveColor(material) {
  if (!material?.emissive?.isColor) return null;
  const { r, g, b } = material.emissive;
  if (r + g + b <= 0.002) return null;
  return `#${material.emissive.getHexString()}`;
}

/**
 * Extracts review metadata from a parsed glTF. Everything here is display-only,
 * which keeps the viewer itself free of hierarchy and panel concerns.
 */
export function analyzeModel(gltf, meta = {}) {
  const model = gltf.scene;
  const json = gltf.parser?.json || {};
  const asset = gltf.asset || json.asset || {};
  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];

  let meshCount = 0;
  let instancedMeshCount = 0;
  let skinnedMeshCount = 0;
  let boneCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let drawableCount = 0;

  const materialMap = new Map();
  const textureMap = new Map();

  model.updateMatrixWorld(true);

  model.traverse((object) => {
    if (object.isBone) boneCount += 1;
    if (!object.isMesh) return;

    meshCount += 1;
    drawableCount += object.isInstancedMesh ? object.count : 1;
    if (object.isInstancedMesh) instancedMeshCount += 1;
    if (object.isSkinnedMesh) skinnedMeshCount += 1;

    const geometry = object.geometry;
    const positionCount = geometry?.attributes?.position?.count || 0;
    const indexCount = geometry?.index?.count || positionCount;
    const instances = object.isInstancedMesh ? Math.max(1, object.count) : 1;
    vertexCount += positionCount * instances;
    triangleCount += Math.floor(indexCount / 3) * instances;

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      const existing = materialMap.get(material.uuid);
      if (existing) {
        existing.uses += 1;
        existing.meshes.push(object);
      } else {
        materialMap.set(material.uuid, { material, uses: 1, meshes: [object] });
      }

      for (const value of Object.values(material)) {
        if (value?.isTexture) textureMap.set(value.uuid, value);
      }
    }
  });

  const box = new THREE.Box3().setFromObject(model);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  const center = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());

  const materials = Array.from(materialMap.values()).map(({ material, uses, meshes }) => ({
    uuid: material.uuid,
    name: material.name || material.type || 'Unnamed material',
    type: material.type || 'Material',
    color: materialColor(material),
    emissive: emissiveColor(material),
    emissiveIntensity: Number.isFinite(material.emissiveIntensity) ? material.emissiveIntensity : 1,
    transparent: Boolean(material.transparent),
    opacity: Number.isFinite(material.opacity) ? material.opacity : 1,
    metalness: Number.isFinite(material.metalness) ? material.metalness : null,
    roughness: Number.isFinite(material.roughness) ? material.roughness : null,
    uses,
    meshes,
  }));

  const nodeCount = Number.isFinite(json.nodes?.length)
    ? json.nodes.length
    : Math.max(0, countNodes(model) - (model.isScene ? 1 : 0));

  const format = (meta.format || guessFormat(meta.name) || 'GLB').toUpperCase();
  const fileSize = Number.isFinite(meta.fileSize) ? meta.fileSize : null;
  const generator = typeof asset.generator === 'string' ? asset.generator : null;
  const version = typeof asset.version === 'string' ? asset.version : '2.0';
  const copyright = typeof asset.copyright === 'string' ? asset.copyright : null;

  return {
    name: meta.name || gltf.scene?.name || 'Untitled asset',
    format,
    fileSize,
    generator,
    version,
    copyright,
    sourceLabel: meta.sourceLabel || null,
    url: meta.url || null,
    loadTime: Number.isFinite(meta.loadTime) ? meta.loadTime : null,
    meshCount,
    drawableCount,
    instancedMeshCount,
    skinnedMeshCount,
    nodeCount,
    boneCount,
    vertexCount,
    triangleCount,
    materialCount: materials.length,
    textureCount: textureMap.size,
    animationCount: animations.length,
    animations: animations.map((clip) => ({
      name: clip.name || 'Untitled clip',
      duration: clip.duration || 0,
      tracks: clip.tracks?.length || 0,
    })),
    dimensions: {
      x: size.x,
      y: size.y,
      z: size.z,
      center: { x: center.x, y: center.y, z: center.z },
      minY: box.isEmpty() ? 0 : box.min.y,
      maxY: box.isEmpty() ? 0 : box.max.y,
    },
    box,
    materials,
  };
}

function countNodes(root) {
  let count = 0;
  root.traverse(() => { count += 1; });
  return count;
}

function guessFormat(name = '') {
  const clean = String(name).split(/[?#]/)[0].toLowerCase();
  if (clean.endsWith('.gltf')) return 'GLTF';
  if (clean.endsWith('.glb')) return 'GLB';
  return null;
}
