const ICONS = {
  mesh: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1.8 5.7 3.1v6.2L8 14.2l-5.7-3.1V4.9z" stroke="currentColor"/><path d="M8 1.8v6.2m0 0 5.7 3.1M8 8 2.3 11.1" stroke="currentColor" opacity=".55"/></svg>',
  skinned: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m8 1.8 5.7 3.1v6.2L8 14.2l-5.7-3.1V4.9z" stroke="currentColor"/><circle cx="8" cy="8" r="1.6" stroke="currentColor"/><path d="M8 6.4V3.3M6.6 8.7 3.4 10.5m6 0 3.2 1.8" stroke="currentColor" opacity=".65"/></svg>',
  bone: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5 5.5 8 2m3 8.5L8 14M5.5 5 2 8m9 3 3.5-3" stroke="currentColor"/><circle cx="5" cy="5.5" r="1.4" stroke="currentColor"/><circle cx="11" cy="10.5" r="1.4" stroke="currentColor"/></svg>',
  group: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.8 4.2h4.4l1.4 1.7h6.6v6.4H1.8z" stroke="currentColor"/><path d="M1.8 4.2V3h4.1l1.1 1.3" stroke="currentColor" opacity=".6"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3.1" stroke="currentColor"/><path d="M8 1.5v1.7M8 12.8v1.7M1.5 8h1.7M12.8 8h1.7M3.4 3.4l1.2 1.2m6.8 6.8 1.2 1.2m0-9.2-1.2 1.2m-6.8 6.8-1.2 1.2" stroke="currentColor" opacity=".7"/></svg>',
  camera: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.8" y="4.4" width="9" height="7.2" rx="1" stroke="currentColor"/><path d="m10.8 7 3.4-2v6l-3.4-2z" stroke="currentColor"/></svg>',
  scene: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.8" stroke="currentColor"/><path d="M2.2 8h11.6M8 2.2c2 1.7 3 3.6 3 5.8s-1 4.1-3 5.8c-2-1.7-3-3.6-3-5.8s1-4.1 3-5.8Z" stroke="currentColor" opacity=".6"/></svg>',
  default: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="2.4" stroke="currentColor"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" opacity=".5"/></svg>',
};

const EYE_OPEN = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.6 8S4.2 3.7 8 3.7 14.4 8 14.4 8 11.8 12.3 8 12.3 1.6 8 1.6 8Z" stroke="currentColor"/><circle cx="8" cy="8" r="1.9" stroke="currentColor"/></svg>';
const EYE_CLOSED = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.6 8S4.2 3.7 8 3.7 14.4 8 14.4 8c-.7 1.2-1.7 2.3-2.9 3.1M5.6 4.3C6.3 4 7.1 3.7 8 3.7M3.2 5.3C2.4 6 1.9 7 1.6 8c1 1.7 2.7 3.2 4.6 3.8" stroke="currentColor" stroke-linecap="round"/><path d="m2.4 2.4 11.2 11.2" stroke="currentColor" stroke-linecap="round"/></svg>';
const CHEVRON = '<svg viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="m3 2.2 3 2.8-3 2.8" stroke="currentColor" stroke-linecap="round"/></svg>';

function kindFor(object) {
  if (object.isSkinnedMesh) return 'skinned';
  if (object.isMesh) return 'mesh';
  if (object.isBone) return 'bone';
  if (object.isLight) return 'light';
  if (object.isCamera) return 'camera';
  if (object.isScene) return 'scene';
  if (object.isGroup || object.children?.length) return 'group';
  return 'default';
}

function displayName(object, unnamed) {
  if (object.name) return object.name;
  if (object.isScene) return 'Scene';
  if (object.isMesh) return `Mesh ${String(++unnamed.mesh).padStart(2, '0')}`;
  if (object.isBone) return `Bone ${String(++unnamed.bone).padStart(2, '0')}`;
  if (object.isGroup) return `Group ${String(++unnamed.group).padStart(2, '0')}`;
  return `${object.type} ${String(++unnamed.other).padStart(2, '0')}`;
}

function shortType(object) {
  if (object.isSkinnedMesh) return 'SkinnedMesh';
  if (object.isMesh) return 'Mesh';
  if (object.isBone) return 'Bone';
  if (object.isScene) return 'Scene';
  return object.type || 'Node';
}

/**
 * Renders a proper DOM tree with independent visibility toggles.
 * Returns the number of rendered object rows.
 */
export function renderHierarchy(container, root, { onSelect, onVisibilityChange } = {}) {
  container.replaceChildren();
  if (!root) {
    const empty = document.createElement('div');
    empty.className = 'empty-mini';
    empty.textContent = 'Scene nodes will appear here.';
    container.append(empty);
    return 0;
  }

  const unnamed = { mesh: 0, bone: 0, group: 0, other: 0 };
  let count = 0;

  const buildNode = (object) => {
    count += 1;
    const node = document.createElement('li');
    node.className = 'tree-node';
    node.setAttribute('role', 'treeitem');

    const label = displayName(object, unnamed);
    const kind = kindFor(object);
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.uuid = object.uuid;
    row.tabIndex = 0;
    row.title = `${label} · ${shortType(object)}`;
    if (!object.visible) row.classList.add('is-hidden');

    const hasChildren = object.children.length > 0;
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = `tree-chevron${hasChildren ? '' : ' is-leaf'}`;
    chevron.tabIndex = hasChildren ? 0 : -1;
    chevron.setAttribute('aria-label', hasChildren ? 'Collapse node' : '');
    chevron.innerHTML = CHEVRON;
    if (hasChildren) {
      chevron.addEventListener('click', (event) => {
        event.stopPropagation();
        node.classList.toggle('is-collapsed');
        chevron.setAttribute('aria-label', node.classList.contains('is-collapsed') ? 'Expand node' : 'Collapse node');
        node.setAttribute('aria-expanded', String(!node.classList.contains('is-collapsed')));
      });
    }

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.dataset.kind = kind;
    icon.innerHTML = ICONS[kind] || ICONS.default;

    const name = document.createElement('span');
    name.className = 'tree-name';
    name.textContent = label;

    const type = document.createElement('span');
    type.className = 'tree-type';
    type.textContent = shortType(object);

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = `tree-eye${object.visible ? '' : ' is-off'}`;
    eye.innerHTML = object.visible ? EYE_OPEN : EYE_CLOSED;
    eye.setAttribute('aria-label', `Hide ${name.textContent}`);
    eye.setAttribute('aria-pressed', String(object.visible));
    eye.title = object.visible ? 'Hide node' : 'Show node';
    eye.addEventListener('click', (event) => {
      event.stopPropagation();
      object.visible = !object.visible;
      eye.classList.toggle('is-off', !object.visible);
      eye.innerHTML = object.visible ? EYE_OPEN : EYE_CLOSED;
      eye.setAttribute('aria-label', object.visible ? `Hide ${name.textContent}` : `Show ${name.textContent}`);
      eye.setAttribute('aria-pressed', String(object.visible));
      eye.title = object.visible ? 'Hide node' : 'Show node';
      row.classList.toggle('is-hidden', !object.visible);
      onVisibilityChange?.(object, object.visible);
    });

    row.append(chevron, icon, name, type, eye);
    row.addEventListener('click', () => onSelect?.(object));
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onSelect?.(object);
      }
      if (event.key === 'ArrowRight' && hasChildren) {
        node.classList.remove('is-collapsed');
        node.setAttribute('aria-expanded', 'true');
        chevron.setAttribute('aria-label', 'Collapse node');
      }
      if (event.key === 'ArrowLeft' && hasChildren) {
        node.classList.add('is-collapsed');
        node.setAttribute('aria-expanded', 'false');
        chevron.setAttribute('aria-label', 'Expand node');
      }
    });

    node.append(row);
    node.setAttribute('aria-expanded', 'true');

    if (hasChildren) {
      const list = document.createElement('ul');
      list.setAttribute('role', 'group');
      for (const child of object.children) list.append(buildNode(child));
      node.append(list);
    }

    return node;
  };

  const list = document.createElement('ul');
  list.className = 'tree-list';
  list.setAttribute('role', 'group');
  list.append(buildNode(root));
  container.append(list);
  return count;
}

function swatchStyle(element, color) {
  element.style.setProperty('--mat-color', color || '#7d8f99');
}

/**
 * Renders the material inspector rows.
 */
export function renderMaterials(container, materials, { onSelectMaterial } = {}) {
  container.replaceChildren();
  if (!materials?.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-mini';
    empty.textContent = 'Base color and emissive swatches appear here.';
    container.append(empty);
    return 0;
  }

  for (const material of materials) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'material-row';
    row.dataset.matUuid = material.uuid;
    row.title = [
      material.name,
      material.type,
      `Base ${material.color || 'n/a'}`,
      material.emissive ? `Emissive ${material.emissive}` : 'No emissive',
      `${material.uses} use${material.uses === 1 ? '' : 's'}`,
    ].join(' · ');

    const swatch = document.createElement('span');
    swatch.className = 'material-swatch';
    swatchStyle(swatch, material.color);
    if (material.emissive) {
      const dot = document.createElement('i');
      dot.className = 'mat-emissive';
      dot.style.setProperty('--mat-emissive', material.emissive);
      swatch.append(dot);
    } else {
      const dot = document.createElement('i');
      dot.className = 'mat-emissive';
      dot.style.setProperty('--mat-emissive', 'rgba(255,255,255,.12)');
      dot.style.boxShadow = 'none';
      swatch.append(dot);
    }

    const copy = document.createElement('span');
    copy.className = 'mat-copy';
    const name = document.createElement('span');
    name.className = 'mat-name';
    name.textContent = material.name;
    const meta = document.createElement('span');
    meta.className = 'mat-meta';
    const kind = material.type.replace(/^Mesh/, '').replace(/Material$/, '').toUpperCase() || 'MATERIAL';
    const surface = material.metalness !== null && material.roughness !== null
      ? ` · M ${material.metalness.toFixed(2)} / R ${material.roughness.toFixed(2)}`
      : '';
    meta.textContent = `${kind}${surface}`;
    copy.append(name, meta);

    const uses = document.createElement('span');
    uses.className = 'mat-count';
    uses.textContent = `${material.uses}×`;

    row.append(swatch, copy, uses);
    row.addEventListener('click', () => onSelectMaterial?.(material));
    container.append(row);
  }

  return materials.length;
}
