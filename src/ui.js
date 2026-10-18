import {
  fmtBytes,
  fmtDimension,
  fmtDuration,
  fmtInt,
  fmtLoadTime,
  truncateMiddle,
} from './format.js';
import { renderHierarchy, renderMaterials } from './hierarchy.js';

const $ = (id) => document.getElementById(id);

const TOGGLE_IDS = {
  wireframe: 'toggleWireframe',
  grid: 'toggleGrid',
  axes: 'toggleAxes',
  bounds: 'toggleBounds',
  autoRotate: 'toggleAutorotate',
  shadows: 'toggleShadows',
};

const STATUS_LABELS = {
  idle: { global: 'ENGINE STANDBY', footer: 'STANDBY' },
  loading: { global: 'LOADING ASSET', footer: 'LOADING' },
  ready: { global: 'MODEL READY', footer: 'READY' },
  error: { global: 'LOAD INTERRUPTED', footer: 'ERROR' },
};

const ARROW = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2 6h8M6.6 2.6 10 6l-3.4 3.4" stroke="currentColor"/></svg>';

export class UI {
  constructor() {
    this.dom = {
      app: $('app'),
      stage: $('stage'),
      globalStatusDot: $('global-status-dot'),
      globalStatusText: $('global-status-text'),
      btnPanelLeft: $('btn-panel-left'),
      btnPanelRight: $('btn-panel-right'),
      btnSamples: $('btn-samples'),
      samplesPopover: $('samples-popover'),
      samplesPopoverList: $('samples-popover-list'),
      btnOpen: $('btn-open'),
      btnHelp: $('btn-help'),
      btnCloseLeft: $('btn-close-left'),
      btnCloseRight: $('btn-close-right'),
      assetChip: $('asset-chip'),
      assetFormat: $('asset-format'),
      assetName: $('asset-name'),
      assetSource: $('asset-source'),
      metaGrid: $('meta-grid'),
      geometrySection: $('geometry-section'),
      hierarchySection: $('hierarchy-section'),
      materialsSection: $('materials-section'),
      sceneSection: $('scene-section'),
      sceneId: $('scene-id'),
      sceneSource: $('scene-source'),
      sceneAssets: $('scene-assets'),
      sceneInstances: $('scene-instances'),
      sceneTargets: $('scene-targets'),
      sceneColliders: $('scene-colliders'),
      sceneLights: $('scene-lights'),
      sceneTriangles: $('scene-triangles'),
      sceneEnvironment: $('scene-environment'),
      sceneCamera: $('scene-camera'),
      scenePost: $('scene-post'),
      sceneBounds: $('scene-bounds'),
      sceneNote: $('scene-note'),
      sceneWarnings: $('scene-warnings'),
      sceneHud: $('scene-hud'),
      sceneHudTitle: $('scene-hud-title'),
      sceneHudAssets: $('scene-hud-assets'),
      sceneHudInstances: $('scene-hud-instances'),
      sceneHudTargets: $('scene-hud-targets'),
      sceneHudColliders: $('scene-hud-colliders'),
      uiSection: $('ui-section'),
      uiLayoutPath: $('ui-layout-path'),
      uiThemePath: $('ui-theme-path'),
      uiStringsPath: $('ui-strings-path'),
      uiScreens: $('ui-screens'),
      uiNodes: $('ui-nodes'),
      uiViewport: $('ui-viewport'),
      uiWarnings: $('ui-warnings'),
      metaSize: $('meta-size'),
      metaVersion: $('meta-version'),
      metaGenerator: $('meta-generator'),
      metaCopyrightWrap: $('meta-copyright-wrap'),
      metaCopyright: $('meta-copyright'),
      neonMeta: $('neon-meta'),
      neonAssetId: $('neon-asset-id'),
      neonNote: $('neon-note'),
      neonSource: $('neon-source'),
      dimX: $('dim-x'),
      dimY: $('dim-y'),
      dimZ: $('dim-z'),
      statTriangles: $('stat-triangles'),
      statVertices: $('stat-vertices'),
      statMeshes: $('stat-meshes'),
      statNodes: $('stat-nodes'),
      statMaterials: $('stat-materials'),
      statTextures: $('stat-textures'),
      statBones: $('stat-bones'),
      statAnims: $('stat-anims'),
      hierarchyCount: $('hierarchy-count'),
      hierarchyTree: $('hierarchy-tree'),
      materialsCount: $('materials-count'),
      materialsList: $('materials-list'),
      stageModelName: $('stage-model-name'),
      stageSubreadout: $('stage-subreadout'),
      btnStageFrame: $('btn-stage-frame'),
      btnStageScreenshot: $('btn-stage-screenshot'),
      btnStageHelp: $('btn-stage-help'),
      emptyState: $('empty-state'),
      dropzone: $('dropzone'),
      browseBtn: $('browse-btn'),
      folderBtn: $('folder-btn'),
      sampleGroups: $('sample-groups'),
      sampleCards: $('sample-cards'),
      loadingOverlay: $('loading-overlay'),
      loadingTitle: $('loading-title'),
      loadingPct: $('loading-pct'),
      loadingBar: $('loading-bar'),
      loadingDetail: $('loading-detail'),
      errorState: $('error-state'),
      errorTitle: $('error-title'),
      errorDetail: $('error-detail'),
      btnErrorOpen: $('btn-error-open'),
      btnErrorDismiss: $('btn-error-dismiss'),
      toggleWireframe: $('toggle-wireframe'),
      toggleGrid: $('toggle-grid'),
      toggleAxes: $('toggle-axes'),
      toggleBounds: $('toggle-bounds'),
      toggleAutorotate: $('toggle-autorotate'),
      toggleShadows: $('toggle-shadows'),
      exposure: $('exposure'),
      exposureValue: $('exposure-value'),
      envIntensity: $('env-intensity'),
      envIntensityValue: $('env-intensity-value'),
      backgroundSeg: $('background-seg'),
      animationSection: $('animation-section'),
      animSource: $('anim-source'),
      animBadge: $('anim-badge'),
      animClip: $('anim-clip'),
      animPlay: $('anim-play'),
      animTime: $('anim-time'),
      animDuration: $('anim-duration'),
      animSpeedReadout: $('anim-speed-readout'),
      animScrub: $('anim-scrub'),
      animSpeed: $('anim-speed'),
      animSpeedValue: $('anim-speed-value'),
      btnLoadAnims: $('btn-load-anims'),
      animsInput: $('anims-input'),
      animFileNote: $('anim-file-note'),
      btnFrame: $('btn-frame'),
      btnReset: $('btn-reset'),
      btnScreenshot: $('btn-screenshot'),
      selectionSection: $('selection-section'),
      selectionName: $('selection-name'),
      selectionType: $('selection-type'),
      selectionTris: $('selection-tris'),
      selectionMaterials: $('selection-materials'),
      statusDot: $('status-dot'),
      statusMode: $('status-mode'),
      statusHint: $('status-hint'),
      metricFps: $('metric-fps'),
      metricCalls: $('metric-calls'),
      metricTris: $('metric-tris'),
      metricSelected: $('metric-selected'),
      metricLoad: $('metric-load'),
      dropOverlay: $('drop-overlay'),
      toastStack: $('toast-stack'),
      helpDialog: $('help-dialog'),
      btnHelpClose: $('btn-help-close'),
      fileInput: $('file-input'),
      folderInput: $('folder-input'),
      panelScrim: $('panel-scrim'),
    };

    this.controlState = {
      wireframe: false,
      grid: true,
      axes: false,
      bounds: false,
      autoRotate: false,
      shadows: true,
    };
    this.samples = [];
    this.sampleGroups = [];
    this.activeSampleGroup = null;
    this.actions = null;
    this.animationState = null;
    this._scrubbing = false;
    this._helpReturnFocus = null;
    this._drawerQuery = window.matchMedia('(max-width: 1120px)');
    this._onViewportResize = () => this._syncPanelButtons();
    window.addEventListener('resize', this._onViewportResize);
    this._syncPanelButtons();
  }

  bind(actions) {
    this.actions = actions;

    this.dom.btnOpen.addEventListener('click', () => this.openFileDialog());
    this.dom.browseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.openFileDialog();
    });
    this.dom.folderBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.dom.folderInput.click();
    });
    this.dom.dropzone.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      this.openFileDialog();
    });
    this.dom.dropzone.addEventListener('keydown', (event) => {
      if (event.target.closest('button')) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        this.openFileDialog();
      }
    });
    this.dom.fileInput.addEventListener('change', () => this._handleFileInput(this.dom.fileInput));
    this.dom.folderInput.addEventListener('change', () => this._handleFileInput(this.dom.folderInput));

    this.dom.btnHelp.addEventListener('click', () => this.openHelp());
    this.dom.btnStageHelp.addEventListener('click', () => this.openHelp());
    this.dom.btnHelpClose.addEventListener('click', () => this.closeHelp());
    this.dom.helpDialog.addEventListener('click', (event) => {
      if (event.target === this.dom.helpDialog) this.closeHelp();
    });
    this.dom.helpDialog.addEventListener('close', () => {
      this._helpReturnFocus?.focus?.({ preventScroll: true });
      this._helpReturnFocus = null;
    });

    this.dom.btnSamples.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleSamples();
    });
    this.dom.samplesPopover.addEventListener('click', (event) => {
      const item = event.target.closest('[data-sample-id]');
      if (!item) return;
      const sample = this.samples.find((entry) => entry.id === item.dataset.sampleId);
      if (!sample) return;
      this.closeSamples();
      this.actions?.onSample?.(sample);
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.dom.samplesPopover.hidden) return;
      if (this.dom.samplesPopover.contains(event.target) || this.dom.btnSamples.contains(event.target)) return;
      this.closeSamples();
    });

    this.dom.btnPanelLeft.addEventListener('click', () => this.togglePanel('left'));
    this.dom.btnPanelRight.addEventListener('click', () => this.togglePanel('right'));
    this.dom.btnCloseLeft.addEventListener('click', () => this.closeDrawers());
    this.dom.btnCloseRight.addEventListener('click', () => this.closeDrawers());
    this.dom.panelScrim.addEventListener('click', () => this.closeDrawers());

    this.dom.sampleGroups.addEventListener('click', (event) => {
      const button = event.target.closest('[data-sample-group]');
      if (!button) return;
      this._setSampleGroup(button.dataset.sampleGroup);
    });
    this.dom.sampleCards.addEventListener('click', (event) => {
      const card = event.target.closest('[data-sample-id]');
      if (!card) return;
      const sample = this.samples.find((entry) => entry.id === card.dataset.sampleId);
      if (sample) this.actions?.onSample?.(sample);
    });

    for (const [key, id] of Object.entries(TOGGLE_IDS)) {
      const button = this.dom[id];
      button.addEventListener('click', () => {
        const next = !this.controlState[key];
        this.setToggle(key, next);
        this.actions?.onToggle?.(key, next);
      });
    }

    this._bindRange(this.dom.exposure, this.dom.exposureValue, (value) => value.toFixed(2), (value) => this.actions?.onExposure?.(value));
    this._bindRange(this.dom.envIntensity, this.dom.envIntensityValue, (value) => value.toFixed(2), (value) => this.actions?.onEnvironment?.(value));
    this._bindRange(this.dom.animSpeed, this.dom.animSpeedValue, (value) => `${value.toFixed(2)}×`, (value) => this.actions?.onAnimationSpeed?.(value));

    this.dom.backgroundSeg.addEventListener('click', (event) => {
      const button = event.target.closest('[data-bgmode]');
      if (!button) return;
      this.setBackground(button.dataset.bgmode);
      this.actions?.onBackground?.(button.dataset.bgmode);
    });

    this.dom.btnFrame.addEventListener('click', () => this.actions?.onFrame?.());
    this.dom.btnStageFrame.addEventListener('click', () => this.actions?.onFrame?.());
    this.dom.btnReset.addEventListener('click', () => this.actions?.onResetView?.());
    this.dom.btnScreenshot.addEventListener('click', () => this.actions?.onScreenshot?.());
    this.dom.btnStageScreenshot.addEventListener('click', () => this.actions?.onScreenshot?.());

    this.dom.animClip.addEventListener('change', () => this.actions?.onAnimationClip?.(Number(this.dom.animClip.value)));
    this.dom.animPlay.addEventListener('click', () => this.actions?.onAnimationToggle?.());
    this.dom.animScrub.addEventListener('pointerdown', () => { this._scrubbing = true; });
    this.dom.animScrub.addEventListener('input', () => {
      const fraction = Number(this.dom.animScrub.value) / 1000;
      this._updateRangeFill(this.dom.animScrub);
      this.actions?.onAnimationSeek?.(fraction);
    });
    window.addEventListener('pointerup', () => { this._scrubbing = false; });
    window.addEventListener('pointercancel', () => { this._scrubbing = false; });

    this.dom.btnLoadAnims?.addEventListener('click', () => this.openAnimsDialog());
    this.dom.animsInput?.addEventListener('change', () => {
      const file = this.dom.animsInput.files?.[0];
      this.dom.animsInput.value = '';
      if (file) this.actions?.onAnimsFile?.(file);
    });

    this.dom.btnErrorOpen.addEventListener('click', () => this.actions?.onOpenFiles?.());
    this.dom.btnErrorDismiss.addEventListener('click', () => this.actions?.onDismissError?.());

    this._updateRangeFill(this.dom.exposure);
    this._updateRangeFill(this.dom.envIntensity);
    this._updateRangeFill(this.dom.animSpeed);
    this._updateRangeFill(this.dom.animScrub);
    this.applyControlStates(this.controlState);
    this.setAnimationClips([]);
    this.setSelection(null);
  }

  _bindRange(input, output, format, onChange) {
    const update = () => {
      const value = Number(input.value);
      if (output) output.textContent = format(value);
      this._updateRangeFill(input);
      onChange?.(value);
    };
    input.addEventListener('input', update);
    if (output) output.textContent = format(Number(input.value));
    this._updateRangeFill(input);
  }

  _updateRangeFill(input) {
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 100;
    const current = Number(input.value) || 0;
    const percent = ((current - min) / (max - min)) * 100;
    input.style.setProperty('--fill', `${Math.max(0, Math.min(100, percent))}%`);
  }

  _handleFileInput(input) {
    const files = Array.from(input.files || []);
    input.value = '';
    if (files.length) this.actions?.onFiles?.(files);
  }

  openFileDialog() {
    this.closeSamples();
    this.dom.fileInput.click();
  }

  openAnimsDialog() {
    this.closeSamples();
    this.dom.animsInput?.click();
  }

  /* ------------------------------------------------------------
     Panels / navigation
     ------------------------------------------------------------ */

  get isDrawerMode() {
    return this._drawerQuery.matches;
  }

  togglePanel(side) {
    const cls = side === 'left' ? 'drawer-left' : 'drawer-right';
    const hideCls = side === 'left' ? 'hide-left' : 'hide-right';
    if (this.isDrawerMode) {
      const open = this.dom.app.classList.contains(cls);
      this.closeDrawers();
      if (!open) {
        this.dom.app.classList.add(cls);
        this.closeSamples();
      }
    } else {
      this.dom.app.classList.toggle(hideCls);
    }
    this._syncPanelButtons();
  }

  closeDrawers() {
    this.dom.app.classList.remove('drawer-left', 'drawer-right');
    this._syncPanelButtons();
  }

  _syncPanelButtons() {
    const drawer = this.isDrawerMode;
    const leftVisible = drawer
      ? this.dom.app.classList.contains('drawer-left')
      : !this.dom.app.classList.contains('hide-left');
    const rightVisible = drawer
      ? this.dom.app.classList.contains('drawer-right')
      : !this.dom.app.classList.contains('hide-right');
    this.dom.btnPanelLeft.classList.toggle('is-off', !leftVisible);
    this.dom.btnPanelRight.classList.toggle('is-off', !rightVisible);
    this.dom.btnPanelLeft.setAttribute('aria-expanded', String(leftVisible));
    this.dom.btnPanelRight.setAttribute('aria-expanded', String(rightVisible));
    if (!drawer) {
      this.dom.app.classList.remove('drawer-left', 'drawer-right');
    }
  }

  /* ------------------------------------------------------------
     Help / samples
     ------------------------------------------------------------ */

  openHelp() {
    this.closeSamples();
    this.closeDrawers();
    if (this.dom.helpDialog.open) return;
    this._helpReturnFocus = document.activeElement;
    this.dom.helpDialog.showModal();
  }

  closeHelp() {
    if (this.dom.helpDialog.open) this.dom.helpDialog.close();
  }

  get helpOpen() {
    return this.dom.helpDialog.open;
  }

  handleEscape() {
    if (this.dom.helpDialog.open) {
      this.closeHelp();
      return true;
    }
    if (!this.dom.samplesPopover.hidden) {
      this.closeSamples();
      return true;
    }
    if (this.dom.app.classList.contains('drawer-left') || this.dom.app.classList.contains('drawer-right')) {
      this.closeDrawers();
      return true;
    }
    return false;
  }

  toggleSamples() {
    if (this.dom.samplesPopover.hidden) {
      this.dom.samplesPopover.hidden = false;
      this.dom.btnSamples.setAttribute('aria-expanded', 'true');
    } else {
      this.closeSamples();
    }
  }

  closeSamples() {
    this.dom.samplesPopover.hidden = true;
    this.dom.btnSamples.setAttribute('aria-expanded', 'false');
  }

  setSamples(payload) {
    const data = Array.isArray(payload) ? { samples: payload } : payload || {};
    this.samples = Array.isArray(data.samples) ? data.samples : [];
    const declaredGroups = Array.isArray(data.groups) ? data.groups : [];
    const groupNames = [];
    for (const group of declaredGroups) {
      const name = typeof group === 'string' ? group : group?.label || group?.name;
      if (name) groupNames.push(name);
    }
    for (const sample of this.samples) {
      const group = sample.group || 'REFERENCE';
      if (!groupNames.includes(group)) groupNames.push(group);
    }
    this.sampleGroups = groupNames;
    if (!this.activeSampleGroup || !groupNames.includes(this.activeSampleGroup)) {
      this.activeSampleGroup = groupNames[0] || null;
    }
    this._renderSampleGroups();
    this._renderSampleCards();
    this._renderSamplePopover();
  }

  _renderSampleGroups() {
    this.dom.sampleGroups.replaceChildren();
    for (const group of this.sampleGroups) {
      const count = this.samples.filter((sample) => (sample.group || 'REFERENCE') === group).length;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `sample-group${group === this.activeSampleGroup ? ' active' : ''}${/neon/i.test(group) ? ' is-neon' : ''}`;
      button.dataset.sampleGroup = group;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(group === this.activeSampleGroup));
      button.append(document.createTextNode(group));
      const badge = document.createElement('span');
      badge.textContent = String(count);
      button.append(badge);
      this.dom.sampleGroups.append(button);
    }
  }

  _setSampleGroup(group) {
    if (!this.sampleGroups.includes(group)) return;
    this.activeSampleGroup = group;
    this._renderSampleGroups();
    this._renderSampleCards();
  }

  _renderSampleCards() {
    const container = this.dom.sampleCards;
    container.replaceChildren();
    const filtered = this.samples.filter((sample) => (sample.group || 'REFERENCE') === this.activeSampleGroup);
    container.dataset.count = String(filtered.length);
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-mini';
      empty.textContent = 'No samples available. Drop a model to begin.';
      container.append(empty);
      return;
    }

    filtered.forEach((sample, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'sample-card';
      card.dataset.sampleId = sample.id;
      card.title = sample.purpose || sample.name || 'Load sample';

      const top = document.createElement('span');
      top.className = 'sample-top';
      const number = document.createElement('span');
      number.className = 'sample-index';
      number.textContent = `${String(index + 1).padStart(2, '0')} / ${String(filtered.length).padStart(2, '0')}`;
      const badge = document.createElement('span');
      badge.className = 'sample-badge';
      badge.textContent = `${sample.format || 'GLB'} · ${sample.type || 'ASSET'}`;
      top.append(number, badge);

      const name = document.createElement('strong');
      name.textContent = sample.name || sample.id;

      const purpose = document.createElement('p');
      purpose.textContent = sample.purpose || '';

      const cta = document.createElement('span');
      cta.className = 'sample-cta';
      cta.innerHTML = `LOAD ASSET ${ARROW}`;

      card.append(top, name, purpose, cta);
      container.append(card);
    });
  }

  _renderSamplePopover() {
    const container = this.dom.samplesPopoverList;
    container.replaceChildren();
    if (!this.samples.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-mini';
      empty.textContent = 'Samples are unavailable. Serve the folder and retry.';
      container.append(empty);
      return;
    }

    for (const group of this.sampleGroups) {
      const section = document.createElement('div');
      section.className = 'popover-group-label';
      if (/neon/i.test(group)) section.classList.add('is-neon');
      const label = document.createElement('span');
      label.textContent = group;
      const count = document.createElement('span');
      count.textContent = `${this.samples.filter((sample) => (sample.group || 'REFERENCE') === group).length} ASSETS`;
      section.append(label, count);
      container.append(section);

      for (const sample of this.samples.filter((entry) => (entry.group || 'REFERENCE') === group)) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'popover-item';
        item.dataset.sampleId = sample.id;
        const index = document.createElement('span');
        index.className = 'popover-idx';
        index.textContent = (sample.format || 'GLB').slice(0, 3);
        const copy = document.createElement('span');
        copy.className = 'popover-copy';
        const name = document.createElement('strong');
        name.textContent = sample.name || sample.id;
        const purpose = document.createElement('span');
        purpose.textContent = sample.type || sample.purpose || '';
        copy.append(name, purpose);
        const format = document.createElement('span');
        format.className = 'popover-format';
        format.textContent = sample.format || 'GLB';
        item.append(index, copy, format);
        container.append(item);
      }
    }
  }

  /* ------------------------------------------------------------
     Status / loading / errors
     ------------------------------------------------------------ */

  setStatus(kind, label) {
    const labels = STATUS_LABELS[kind] || STATUS_LABELS.idle;
    this.dom.globalStatusText.textContent = label || labels.global;
    this.dom.statusMode.textContent = labels.footer;
    const dotClass = `status-dot${kind === 'loading' ? ' is-loading' : kind === 'ready' ? ' is-ready' : kind === 'error' ? ' is-error' : ''}`;
    this.dom.globalStatusDot.className = dotClass;
    this.dom.statusDot.className = dotClass;
  }

  setHint(text) {
    this.dom.statusHint.textContent = text;
  }

  showLoading(title = 'Loading model', detail = 'Reading asset…') {
    this.dom.loadingOverlay.hidden = false;
    this.dom.loadingOverlay.classList.add('is-indeterminate');
    this.dom.loadingTitle.textContent = title;
    this.dom.loadingPct.textContent = '—';
    this.dom.loadingBar.style.width = '0%';
    this.dom.loadingDetail.textContent = detail;
    this.dom.errorState.hidden = true;
    this.setStatus('loading');
  }

  setLoadingProgress(percent, detail) {
    const overlay = this.dom.loadingOverlay;
    if (overlay.hidden) return;
    if (detail) this.dom.loadingDetail.textContent = detail;
    if (Number.isFinite(percent)) {
      const clamped = Math.max(0, Math.min(100, percent));
      overlay.classList.remove('is-indeterminate');
      this.dom.loadingBar.style.width = `${clamped}%`;
      this.dom.loadingPct.textContent = `${Math.round(clamped)}%`;
    } else {
      overlay.classList.add('is-indeterminate');
      this.dom.loadingPct.textContent = '···';
    }
  }

  hideLoading() {
    this.dom.loadingOverlay.hidden = true;
    this.dom.loadingOverlay.classList.remove('is-indeterminate');
  }

  showError(title, detail) {
    this.hideLoading();
    this.dom.errorState.hidden = false;
    this.dom.errorTitle.textContent = title || 'Could not load model';
    this.dom.errorDetail.textContent = detail || 'The viewer could not read this asset.';
    this.dom.emptyState.hidden = true;
    this.setStatus('error');
    this.setHint('LOAD FAILED · CHOOSE ANOTHER FILE OR TRY A SAMPLE');
    this.dom.metricLoad.textContent = '—';
  }

  dismissError() {
    this.dom.errorState.hidden = true;
    if (!this.dom.app.classList.contains('has-model')) {
      this.dom.emptyState.hidden = false;
      this.setStatus('idle');
      this.setHint('DROP A MODEL OR OPEN A SAMPLE');
    } else {
      this.setStatus('ready');
      this.setHint('MODEL READY · SELECT A NODE TO INSPECT');
    }
  }

  showEmpty() {
    this.dom.emptyState.hidden = false;
  }

  setLoadedState(info) {
    this.dom.app.classList.add('has-model');
    this.dom.errorState.hidden = true;
    this.dom.emptyState.hidden = true;
    this.hideLoading();
    this.setStatus('ready');
    this.setHint('MODEL READY · DRAG ANOTHER FILE TO SWAP');
    this.dom.stageModelName.textContent = info.name || 'UNTITLED';
    const clipText = info.animationCount ? ` · ${info.animationCount} CLIP${info.animationCount === 1 ? '' : 'S'}` : '';
    const hintText = info.viewHintUsed ? ' · AUTHORED CAMERA' : '';
    this.dom.stageSubreadout.textContent = `${info.format} · ${fmtInt(info.triangleCount)} TRIANGLES${clipText}${hintText}`;
    this.dom.metricLoad.textContent = fmtLoadTime(info.loadTime);
    this.dom.metricSelected.textContent = '—';
    this.dom.metricSelected.title = '';
  }

  updateAsset(info) {
    const format = (info.format || 'GLB').toUpperCase();
    this.dom.assetChip.textContent = format;
    this.dom.assetChip.classList.remove('is-glb', 'is-gltf');
    this.dom.assetChip.classList.add(format === 'GLTF' ? 'is-gltf' : 'is-glb');
    this.dom.assetFormat.textContent = `${format} ASSET / ${info.animationCount ? 'ANIMATED' : 'STATIC'}`;
    this.dom.assetName.textContent = info.name || 'Untitled asset';
    this.dom.assetName.title = info.name || '';
    const source = info.sourceLabel || 'LOCAL FILE';
    this.dom.assetSource.textContent = source;
    this.dom.assetSource.title = source;

    this.dom.metaSize.textContent = info.fileSize != null ? fmtBytes(info.fileSize) : '—';
    this.dom.metaSize.title = info.fileSize != null ? `${fmtInt(info.fileSize)} bytes` : '';
    this.dom.metaVersion.textContent = info.version ? `glTF ${info.version}` : '—';
    this.dom.metaGenerator.textContent = info.generator || '—';
    this.dom.metaGenerator.title = info.generator || '';
    if (info.copyright) {
      this.dom.metaCopyrightWrap.hidden = false;
      this.dom.metaCopyright.textContent = info.copyright;
      this.dom.metaCopyright.title = info.copyright;
    } else {
      this.dom.metaCopyrightWrap.hidden = true;
    }

    this.dom.dimX.textContent = fmtDimension(info.dimensions.x);
    this.dom.dimY.textContent = fmtDimension(info.dimensions.y);
    this.dom.dimZ.textContent = fmtDimension(info.dimensions.z);

    const stats = [
      [this.dom.statTriangles, info.triangleCount],
      [this.dom.statVertices, info.vertexCount],
      [this.dom.statMeshes, info.meshCount],
      [this.dom.statNodes, info.nodeCount],
      [this.dom.statMaterials, info.materialCount],
      [this.dom.statTextures, info.textureCount],
      [this.dom.statBones, info.boneCount],
      [this.dom.statAnims, info.animationCount],
    ];
    for (const [element, value] of stats) {
      element.textContent = fmtInt(value);
      element.title = fmtInt(value);
    }

    this._renderNeonMeta(info.neonRange);
    document.title = `${info.name || 'Asset'} — GLB Inspector`;
    this.setSelection(null);
    this.dom.stage.scrollTop = 0;
    this.dom.loadingOverlay.hidden = true;
    this.setLoadedState(info);
  }

  _displayUrl(url) {
    if (!url) return '—';
    try {
      const parsed = new URL(url, window.location.href);
      return parsed.host === window.location.host ? parsed.pathname : parsed.href;
    } catch {
      return String(url);
    }
  }

  _renderWarnings(element, warnings) {
    if (!element) return;
    const list = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
    if (!list.length) {
      element.hidden = true;
      element.textContent = '';
      return;
    }
    element.hidden = false;
    element.textContent = list.map((warning) => `• ${warning}`).join('\n');
  }

  setMode(mode) {
    this.mode = mode;
    const scene = mode === 'scene';
    const ui = mode === 'ui';
    this.dom.app.classList.toggle('mode-scene', scene);
    this.dom.app.classList.toggle('mode-ui', ui);
    this.dom.metaGrid.hidden = scene || ui;
    this.dom.geometrySection.hidden = scene || ui;
    this.dom.hierarchySection.hidden = ui;
    this.dom.materialsSection.hidden = ui;
    this.dom.sceneSection.hidden = !scene;
    this.dom.uiSection.hidden = !ui;
    this.dom.sceneHud.hidden = !scene;
    if (!scene) this.dom.neonMeta.hidden = true;
  }

  setSceneSummary(state, { sceneUrl = '' } = {}) {
    this.setMode('scene');
    this.dom.app.classList.add('has-model');
    this.dom.errorState.hidden = true;
    this.dom.emptyState.hidden = true;
    this.hideLoading();
    this.setStatus('ready', 'SCENE READY');
    this.setHint('SCENE READY · READ-ONLY INSPECTOR');

    const counts = state.counts || {};
    const source = state.sceneUrl || sceneUrl;
    this.dom.assetChip.textContent = 'SCENE';
    this.dom.assetChip.classList.remove('is-glb');
    this.dom.assetChip.classList.add('is-gltf');
    this.dom.assetFormat.textContent = 'SCENE JSON / READ-ONLY';
    this.dom.assetName.textContent = state.sceneId || 'Scene';
    this.dom.assetName.title = source;
    this.dom.assetSource.textContent = this._displayUrl(source);
    this.dom.assetSource.title = source;

    this.dom.sceneId.textContent = state.sceneId || '—';
    this.dom.sceneSource.textContent = this._displayUrl(source);
    this.dom.sceneSource.title = source;
    this.dom.sceneAssets.textContent = fmtInt(counts.assetsUsed);
    this.dom.sceneAssets.title = `${fmtInt(counts.authoredAssets)} in manifest`;
    this.dom.sceneInstances.textContent = fmtInt(counts.instances);
    this.dom.sceneInstances.title = `${fmtInt(counts.environmentInstances)} environment + ${fmtInt(counts.propInstances)} props + ${fmtInt(counts.targetInstances)} target assets`;
    this.dom.sceneTargets.textContent = fmtInt(counts.targetSlots);
    this.dom.sceneTargets.title = `${fmtInt(counts.targetSlots)} slots · ${fmtInt(counts.targetInstances)} target GLBs loaded`;
    this.dom.sceneColliders.textContent = fmtInt(counts.colliders);
    this.dom.sceneLights.textContent = fmtInt(counts.lights);
    this.dom.sceneTriangles.textContent = fmtInt(counts.triangles);
    this.dom.sceneTriangles.title = `${fmtInt(counts.meshes)} meshes · ${fmtInt(counts.vertices)} vertices · ${fmtInt(counts.materials)} materials`;
    this.dom.sceneEnvironment.textContent = state.environmentAsset || '—';
    this.dom.sceneEnvironment.title = state.environmentAsset || '';

    const camera = state.camera;
    this.dom.sceneCamera.textContent = camera
      ? `pos ${camera.position.map((value) => Number(value).toFixed(2)).join(', ')} → ${camera.target.map((value) => Number(value).toFixed(2)).join(', ')} · ${Number(camera.fov).toFixed(0)}°`
      : '—';
    this.dom.sceneCamera.title = camera ? `near ${camera.near} · far ${camera.far}` : '';

    const post = state.post;
    this.dom.scenePost.textContent = post
      ? `${post.tonemapping} → ${post.tonemappingApproximation} · bloom ${Number(post.bloom).toFixed(2)}${post.fog ? ` · fog ${post.fog.start}–${post.fog.end}` : ''}`
      : '—';
    this.dom.scenePost.title = post?.bloomPass || '';

    const bounds = state.bounds;
    this.dom.sceneBounds.textContent = bounds && !bounds.empty
      ? `${bounds.size.map((value) => Number(value).toFixed(1)).join(' × ')} m`
      : 'empty';
    this.dom.sceneBounds.title = bounds && !bounds.empty
      ? `min ${bounds.min.join(', ')} · max ${bounds.max.join(', ')}`
      : '';

    const packName = [state.pack, state.packVersion].filter(Boolean).join(' ');
    this.dom.sceneNote.textContent = `${packName || 'unknown pack'} · ${state.origin || 'custom'} · ${fmtInt(counts.meshes)} meshes / ${fmtInt(counts.materials)} materials / ${fmtInt(counts.targetInstances)} target assets`;
    this._renderWarnings(this.dom.sceneWarnings, state.warnings);

    this.dom.sceneHud.hidden = false;
    this.dom.sceneHudTitle.textContent = (state.sceneId || 'SCENE').toUpperCase();
    this.dom.sceneHudAssets.textContent = fmtInt(counts.assetsUsed);
    this.dom.sceneHudInstances.textContent = fmtInt(counts.instances);
    this.dom.sceneHudTargets.textContent = fmtInt(counts.targetSlots);
    this.dom.sceneHudColliders.textContent = fmtInt(counts.colliders);

    this.dom.stageModelName.textContent = (state.sceneId || 'SCENE').toUpperCase();
    this.dom.stageSubreadout.textContent = `${fmtInt(counts.instances)} INSTANCES · ${fmtInt(counts.assetsUsed)} ASSETS · ${fmtInt(counts.triangles)} TRIANGLES`;
    this.setSelection(null);
    document.title = `${state.sceneId || 'Scene'} — NEON RANGE Scene Inspector`;
  }

  setUiSummary(state, { layoutUrl = '' } = {}) {
    this.setMode('ui');
    this.dom.app.classList.add('has-model');
    this.dom.errorState.hidden = true;
    this.dom.emptyState.hidden = true;
    this.hideLoading();
    this.setStatus('ready', 'UI PREVIEW');
    this.setHint('APPROXIMATE UI PREVIEW · BEVY IS AUTHORITATIVE');

    const source = state.layoutUrl || layoutUrl;
    this.dom.assetChip.textContent = 'UI';
    this.dom.assetChip.classList.remove('is-gltf');
    this.dom.assetChip.classList.add('is-glb');
    this.dom.assetFormat.textContent = 'UI SCHEMA / APPROXIMATE';
    this.dom.assetName.textContent = source.split('/').filter(Boolean).pop() || 'UI layout';
    this.dom.assetName.title = source;
    this.dom.assetSource.textContent = this._displayUrl(source);
    this.dom.assetSource.title = source;

    this.dom.uiLayoutPath.textContent = this._displayUrl(source);
    this.dom.uiLayoutPath.title = source;
    this.dom.uiThemePath.textContent = this._displayUrl(state.themeUrl);
    this.dom.uiThemePath.title = state.themeUrl || '';
    this.dom.uiStringsPath.textContent = this._displayUrl(state.stringsUrl);
    this.dom.uiStringsPath.title = state.stringsUrl || '';
    this.updateUiViewport(state);
    this._renderWarnings(this.dom.uiWarnings, state.warnings);

    this.dom.stageModelName.textContent = 'UI PREVIEW';
    this.dom.stageSubreadout.textContent = `${state.screens?.length || 0} SCREENS · DOM/CSS APPROXIMATION`;
    this.setSelection(null);
    document.title = 'NEON RANGE — Coarse UI Preview';
  }

  updateUiViewport(state) {
    if (!state) return;
    this.dom.uiScreens.textContent = (state.screens || []).map((screen) => screen.label || screen.id).join(' · ') || '—';
    this.dom.uiNodes.textContent = `${fmtInt(state.totalNodes)} DOM · ${fmtInt(state.boundNodes)} BOUND`;
    this.dom.uiViewport.textContent = `${state.target?.width}×${state.target?.height} · fit ${Math.round((state.displayScale || 1) * 100)}%`;
    this.dom.uiViewport.title = 'Switch screens and sizes in the preview toolbar.';
  }

  _renderNeonMeta(metadata) {
    if (!metadata) {
      this.dom.neonMeta.hidden = true;
      return;
    }
    this.dom.neonMeta.hidden = false;
    this.dom.neonAssetId.textContent = metadata.asset_id || 'NEON RANGE';
    this.dom.neonNote.textContent = metadata.note || metadata.role || 'NEON RANGE runtime export.';
    this.dom.neonSource.textContent = metadata.source || metadata.units || 'NEON RANGE / asset-export';
    this.dom.neonSource.title = metadata.source || '';
  }

  renderModelTree(root, handlers = {}) {
    const count = renderHierarchy(this.dom.hierarchyTree, root, handlers);
    this.dom.hierarchyCount.textContent = `${fmtInt(count)} OBJECT${count === 1 ? '' : 'S'}`;
  }

  renderModelMaterials(materials, handlers = {}) {
    const count = renderMaterials(this.dom.materialsList, materials, handlers);
    this.dom.materialsCount.textContent = `${fmtInt(count)} FOUND`;
    this.dom.statMaterials.textContent = fmtInt(count);
    this.dom.statMaterials.title = fmtInt(count);
  }

  setSelection(selection) {
    this.dom.hierarchyTree.querySelectorAll('.tree-row.is-selected').forEach((row) => row.classList.remove('is-selected'));
    this.dom.materialsList.querySelectorAll('.material-row.is-selected').forEach((row) => row.classList.remove('is-selected'));

    if (!selection) {
      this.dom.selectionSection.hidden = true;
      this.dom.metricSelected.textContent = '—';
      this.dom.metricSelected.title = '';
      return;
    }

    const row = this.dom.hierarchyTree.querySelector(`.tree-row[data-uuid="${CSS.escape(selection.uuid)}"]`);
    if (row) {
      row.classList.add('is-selected');
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    const materialSet = new Set(selection.materialNames || []);
    for (const materialRow of this.dom.materialsList.querySelectorAll('.material-row')) {
      const materialName = materialRow.querySelector('.mat-name')?.textContent;
      materialRow.classList.toggle('is-selected', Boolean(materialName && materialSet.has(materialName)));
    }

    this.dom.selectionSection.hidden = false;
    this.dom.selectionName.textContent = selection.name;
    this.dom.selectionName.title = selection.name;
    this.dom.selectionType.textContent = `${selection.type} · ${selection.meshes} MESH${selection.meshes === 1 ? '' : 'ES'}`;
    this.dom.selectionTris.textContent = fmtInt(selection.triangles);
    const materialText = selection.materialNames.length
      ? selection.materialNames.length > 1
        ? `${selection.materialNames[0]} +${selection.materialNames.length - 1}`
        : selection.materialNames[0]
      : '—';
    this.dom.selectionMaterials.textContent = materialText;
    this.dom.selectionMaterials.title = selection.materialNames.join(', ');

    this.dom.metricSelected.textContent = truncateMiddle(selection.name, 22);
    this.dom.metricSelected.title = `${selection.name} · ${selection.type}`;
  }

  updateRenderStats(stats) {
    this.dom.metricFps.textContent = stats.fps ? String(stats.fps) : '—';
    this.dom.metricFps.classList.toggle('is-low', Number(stats.fps) > 0 && Number(stats.fps) < 30);
    this.dom.metricCalls.textContent = fmtInt(stats.calls || 0);
    this.dom.metricTris.textContent = fmtInt(stats.triangles || 0);
  }

  setBackground(mode) {
    if (!['dark', 'gradient', 'transparent'].includes(mode)) return;
    this.dom.stage.dataset.bg = mode;
    this.dom.backgroundSeg.querySelectorAll('[data-bgmode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.bgmode === mode);
      button.setAttribute('aria-pressed', String(button.dataset.bgmode === mode));
    });
  }

  setToggle(key, enabled) {
    const id = TOGGLE_IDS[key];
    if (!id) return;
    this.controlState[key] = Boolean(enabled);
    this.dom[id].setAttribute('aria-checked', String(Boolean(enabled)));
  }

  applyControlStates(states) {
    for (const key of Object.keys(TOGGLE_IDS)) this.setToggle(key, Boolean(states[key]));
  }

  /* ------------------------------------------------------------
     Animation
     ------------------------------------------------------------ */

  setAnimationClips(clips, { sourceLabel = '', activeIndex = 0 } = {}) {
    this.dom.animClip.replaceChildren();
    if (!clips || !clips.length) {
      this.dom.animationSection.hidden = true;
      this.dom.animBadge.textContent = '0 CLIPS';
      this._setAnimationSource('—');
      return;
    }
    this.dom.animationSection.hidden = false;
    this.dom.animBadge.textContent = `${clips.length} CLIP${clips.length === 1 ? '' : 'S'}`;
    clips.forEach((clip, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const sourceTag = clip.source === 'neon' ? 'NEON' : 'GLTF';
      option.textContent = `${clip.name}  ·  ${fmtDuration(clip.duration)}  ·  ${sourceTag}`;
      this.dom.animClip.append(option);
    });
    const selected = Math.max(0, Math.min(clips.length - 1, Number(activeIndex) || 0));
    this.dom.animClip.value = String(selected);
    this.dom.animTime.textContent = fmtDuration(0);
    this.dom.animDuration.textContent = fmtDuration(clips[selected]?.duration || 0);
    this.dom.animScrub.value = '0';
    this._updateRangeFill(this.dom.animScrub);
    this._setAnimationSource(sourceLabel);
  }

  _setAnimationSource(label) {
    if (!this.dom.animSource) return;
    const text = label || '—';
    this.dom.animSource.textContent = text;
    this.dom.animSource.classList.toggle('is-neon', /NEON/i.test(text));
    this.dom.animSource.title = text;
  }

  setNeonAnimSummary(label, count) {
    if (!this.dom.animFileNote) return;
    if (label) {
      const plural = count === 1 ? '' : 's';
      this.dom.animFileNote.textContent = `Loaded ${label} · ${count} clip${plural} for the current model.`;
      this.dom.animFileNote.classList.add('is-loaded');
    } else {
      this.dom.animFileNote.textContent = 'Load a NEON RANGE .anims.json library for the current model.';
      this.dom.animFileNote.classList.remove('is-loaded');
    }
  }

  updateAnimationState(state) {
    if (!state || !this.dom.animationSection || this.dom.animationSection.hidden) return;
    this.animationState = state;
    this.dom.animBadge.textContent = `${state.count} CLIP${state.count === 1 ? '' : 'S'}`;
    this._setAnimationSource(state.sourceLabel || '—');
    if (document.activeElement !== this.dom.animClip) {
      const value = String(state.index ?? 0);
      if (this.dom.animClip.value !== value) this.dom.animClip.value = value;
    }
    this.dom.animTime.textContent = fmtDuration(state.time);
    this.dom.animDuration.textContent = fmtDuration(state.duration);
    this.dom.animPlay.classList.toggle('is-paused', !state.playing);
    this.dom.animPlay.setAttribute('aria-label', state.playing ? 'Pause animation' : 'Play animation');
    this.dom.animSpeedReadout.textContent = `${Number(state.speed || 1).toFixed(2)}×`;
    if (!this._scrubbing) {
      const fraction = state.duration > 0 ? (state.time / state.duration) : 0;
      this.dom.animScrub.value = String(Math.round(Math.max(0, Math.min(1, fraction)) * 1000));
      this._updateRangeFill(this.dom.animScrub);
    }
    if (document.activeElement !== this.dom.animSpeed) {
      this.dom.animSpeed.value = String(Number(state.speed || 1).toFixed(2));
      this.dom.animSpeedValue.textContent = `${Number(state.speed || 1).toFixed(2)}×`;
      this._updateRangeFill(this.dom.animSpeed);
    }
  }

  /* ------------------------------------------------------------
     Drop overlay / toasts
     ------------------------------------------------------------ */

  setDragActive(active) {
    this.dom.dropOverlay.hidden = !active;
  }

  toast({ kind = 'info', title = '', message = '', timeout = 5200 } = {}) {
    const toast = document.createElement('div');
    toast.className = `toast${kind !== 'info' ? ` is-${kind}` : ''}`;
    const icon = document.createElement('div');
    icon.className = 'toast-icon';
    icon.textContent = kind === 'error' ? '!' : kind === 'success' ? '✓' : kind === 'warning' ? '!' : 'i';
    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const heading = document.createElement('div');
    heading.className = 'toast-title';
    heading.textContent = title;
    const body = document.createElement('div');
    body.className = 'toast-message';
    body.textContent = message;
    copy.append(heading, body);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.textContent = '×';
    toast.append(icon, copy, close);
    this.dom.toastStack.append(toast);

    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      toast.classList.add('is-leaving');
      window.setTimeout(() => toast.remove(), 180);
    };
    close.addEventListener('click', remove);
    const timer = timeout > 0 ? window.setTimeout(remove, timeout) : null;
    toast.addEventListener('mouseenter', () => timer && window.clearTimeout(timer));
  }
}
