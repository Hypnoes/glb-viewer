/**
 * Coarse DOM/CSS preview of the NEON RANGE `neon_ui` schema.
 *
 * This is intentionally approximate: it reads `theme.json`, `layout.json` and
 * `strings.en.json` and lays them out in the browser. Bevy remains the source of
 * truth for pixel-accurate spacing, font metrics and rendering. Unknown node
 * types fall back to a labelled flex box instead of failing the whole preview.
 */

const BINDINGS = {
  score: '12,450',
  combo: '×4',
  accuracy: '86%',
  timer: '01:12',
  ammo: '12',
  reserve: '48',
  reload: 'READY',
  crosshair: '',
  lock: 'LOCK 78%',
  hit: 'HIT +100',
  popup: '+100',
  results: 'ROUND COMPLETE',
  menu: 'PAUSED',
  phase: 'PHASE 01 / CALIBRATION',
  hits: 'HITS 37 / SHOTS 43',
  prompt: 'CLICK TO START THE RANGE',
  menu_mode: 'CURRENT // BORDERLESS',
  results_score: 'SCORE 12,450',
  results_stats: 'ACCURACY 86%   HITS 37/43   BEST COMBO x9',
};

const SAMPLE_VALUES = {
  score: '12,450',
  combo: '4',
  accuracy: '86',
  percent: '86',
  best: '9',
  hits: '37',
  shots: '43',
  timer: '01:12',
  ammo: '12',
  mag: '48',
  reserve: '48',
  reload: '100',
  mode: 'BORDERLESS',
  phase: '01',
};

const SIZE_PRESETS = {
  '1600x900': { width: 1600, height: 900, label: '1600 × 900' },
  '2400x1350': { width: 2400, height: 1350, label: '2400 × 1350' },
  '900': { width: 900, height: 506, label: '900 wide' },
  '900x506': { width: 900, height: 506, label: '900 wide' },
};

const FALLBACK_THEME = {
  colors: {
    bg: [0.016, 0.024, 0.043],
    panel: [0.043, 0.071, 0.102, 0.86],
    panelSolid: [0.031, 0.055, 0.078, 0.97],
    text: [0.847, 0.91, 0.937],
    muted: [0.47, 0.557, 0.608],
    cyan: [0.275, 0.902, 1],
    orange: [1, 0.541, 0.165],
    green: [0.553, 1, 0.69],
    red: [1, 0.392, 0.455],
    line: [0.275, 0.902, 1, 0.2],
  },
  font: { sans: 'Segoe UI, system-ui, sans-serif', mono: 'Consolas, monospace', size: {} },
  spacing: {},
};

function collectString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function flattenStrings(source, prefix = '', target = new Map()) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flattenStrings(value, path, target);
    else if (typeof value === 'string' || typeof value === 'number') target.set(path, String(value));
  }
  return target;
}

function flattenColors(source, target = new Map()) {
  if (!source || typeof source !== 'object') return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value) || typeof value === 'string') {
      target.set(key, value);
      target.set(`colors.${key}`, value);
    }
  }
  return target;
}

function toCssColor(value) {
  if (Array.isArray(value)) {
    const channel = (entry) => Math.round(Math.max(0, Math.min(1, toNumber(entry, 0))) * 255);
    const alpha = value.length > 3 ? Math.max(0, Math.min(1, toNumber(value[3], 1))) : 1;
    if (alpha >= 1) return `rgb(${channel(value[0])} ${channel(value[1])} ${channel(value[2])})`;
    return `rgba(${channel(value[0])}, ${channel(value[1])}, ${channel(value[2])}, ${alpha})`;
  }
  if (value && typeof value === 'object') {
    if ('r' in value) return toCssColor([value.r, value.g, value.b, value.a ?? 1]);
    if ('hex' in value) return String(value.hex);
  }
  return typeof value === 'string' ? value : null;
}

function px(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return `${value}px`;
  if (typeof value === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(value)) return `${value}px`;
    return value;
  }
  return null;
}

function spacing(value) {
  if (Array.isArray(value)) {
    const [first, second = first] = value.map((entry) => toNumber(entry, 0));
    return `${second}px ${first}px`;
  }
  return px(value);
}

export class UiPreview {
  constructor({ stage, frame, root, screenTabs, sizeTabs, caption, onChange }) {
    this.stage = stage;
    this.frame = frame;
    this.root = root;
    this.screenTabs = screenTabs;
    this.sizeTabs = sizeTabs;
    this.caption = caption;
    this.onChange = typeof onChange === 'function' ? onChange : null;

    this.theme = FALLBACK_THEME;
    this.colors = flattenColors(FALLBACK_THEME.colors);
    this.strings = new Map();
    this.fontFamily = null;
    this.screens = [];
    this.activeScreen = null;
    this.sizeKey = '1600x900';
    this.target = { ...SIZE_PRESETS[this.sizeKey] };
    this.displayScale = 1;
    this.boundNodes = 0;
    this.totalNodes = 0;
    this.state = {
      ready: false,
      loading: false,
      layoutUrl: null,
      themeUrl: null,
      stringsUrl: null,
      screens: [],
      activeScreen: null,
      size: this.sizeKey,
      target: { width: this.target.width, height: this.target.height },
      displayScale: 1,
      totalNodes: 0,
      boundNodes: 0,
      errors: [],
      warnings: [],
      approximate: true,
    };

    this._onResize = () => this.layout();
    window.addEventListener('resize', this._onResize);
    this._bindControls();
  }

  _bindControls() {
    this.screenTabs?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ui-screen]');
      if (button) this.setScreen(button.dataset.uiScreen);
    });
    this.sizeTabs?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-ui-size]');
      if (button) this.setSize(button.dataset.uiSize);
    });
  }

  _warn(message) {
    if (!this.state.warnings.includes(message)) this.state.warnings.push(message);
  }

  _error(message) {
    if (!this.state.errors.includes(message)) this.state.errors.push(message);
  }

  getState() {
    return {
      ...this.state,
      screens: this.screens.map((screen) => ({ id: screen.id, label: screen.label })),
      target: { ...this.state.target },
      errors: [...this.state.errors],
      warnings: [...this.state.warnings],
    };
  }

  async load({ layoutUrl, themeUrl, stringsUrl } = {}) {
    const resolvedLayout = collectString(layoutUrl);
    if (!resolvedLayout) throw new Error('No UI layout URL was provided.');

    this.state = {
      ready: false,
      loading: true,
      layoutUrl: null,
      themeUrl: null,
      stringsUrl: null,
      screens: [],
      activeScreen: null,
      size: this.sizeKey,
      target: { width: this.target.width, height: this.target.height },
      displayScale: 1,
      totalNodes: 0,
      boundNodes: 0,
      errors: [],
      warnings: [],
      approximate: true,
    };

    try {
      const requestedLayout = resolvedLayout.endsWith('/')
        ? new URL('layout.json', resolvedLayout).href
        : resolvedLayout;
      const absoluteLayout = new URL(requestedLayout, window.location.href).href;
      const layout = await this._fetchJSON(absoluteLayout).catch((error) => {
        throw new Error(`UI layout could not be loaded from ${absoluteLayout}: ${error.message}`);
      });
      const base = new URL('.', absoluteLayout).href;
      this.state.layoutUrl = requestedLayout;

      const themeCandidate = collectString(themeUrl) || new URL('theme.json', base).href;
      const stringsCandidate = collectString(stringsUrl) || new URL('strings.en.json', base).href;

      this.theme = await this._fetchOptionalJSON(themeCandidate, 'theme');
      this.state.themeUrl = themeCandidate;
      this.colors = flattenColors(this.theme.colors || {}, flattenColors(FALLBACK_THEME.colors));
      await this._registerFonts(themeCandidate);
      const stringData = await this._fetchOptionalJSON(stringsCandidate, 'strings');
      this.state.stringsUrl = stringsCandidate;
      this.strings = flattenStrings(stringData?.strings || stringData || {});

      this.screens = this._normalizeScreens(layout);
      if (!this.screens.length) throw new Error('layout.json contains no screens, views, root or hud/menu/results nodes.');
      this.state.screens = this.screens.map((screen) => screen.id);

      this._renderTabs();
      this.setSize(this.sizeKey, { silent: true });
      this.setScreen(this.screens[0].id, { silent: true });

      this.state.loading = false;
      this.state.ready = true;
      return this.getState();
    } catch (error) {
      this.state.loading = false;
      this.state.ready = false;
      const message = error?.message || String(error);
      this._error(message);
      throw error;
    }
  }

  async _fetchJSON(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
    return response.json();
  }

  async _fetchOptionalJSON(url, label) {
    try {
      return await this._fetchJSON(url);
    } catch (error) {
      this._warn(`${label} could not be loaded from ${url} (${error.message}); using built-in fallback tokens.`);
      return label === 'theme' ? FALLBACK_THEME : { strings: {} };
    }
  }

  async _registerFonts(themeUrl) {
    const fonts = this.theme?.fonts;
    if (!fonts || typeof fonts !== 'object') return;
    const first = Object.values(fonts).find((entry) => entry && typeof entry === 'object' && entry.path);
    if (!first) return;
    const themeDir = new URL('.', themeUrl);
    let fontPath = String(first.path);
    if (themeDir.pathname.endsWith('/ui/') && fontPath.startsWith('ui/')) fontPath = fontPath.slice(3);
    const url = new URL(fontPath, themeDir).href;
    try {
      if (!document.fonts?.add || typeof FontFace !== 'function') return;
      const face = new FontFace('NeonUiFont', `url(${url})`);
      await face.load();
      document.fonts.add(face);
      this.fontFamily = "'NeonUiFont', 'Cascadia Mono', Consolas, monospace";
    } catch (error) {
      this._warn(`Theme font could not be loaded from ${url} (${error.message}); using system fallback.`);
    }
  }

  _resolveStyle(style) {
    if (!style) return {};
    if (typeof style === 'string') return { ...(this.theme?.styles?.[style] || {}) };
    return { ...style };
  }

  _resolveSpacing(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) {
      const values = value.map((entry) => this._resolveSpacing(entry) || '0px');
      if (values.length >= 4) {
        // Bevy UiRect order: left, right, top, bottom -> CSS top right bottom left.
        return `${values[2]} ${values[1]} ${values[3]} ${values[0]}`;
      }
      if (values.length === 2) return `${values[1]} ${values[0]}`;
      return values[0];
    }
    if (typeof value === 'number') return `${value}px`;
    if (typeof value === 'string') {
      const token = value.startsWith('$') ? value.slice(1) : value;
      const spacing = this.theme?.spacing?.[token];
      if (spacing !== undefined) return `${toNumber(spacing, 0)}px`;
      return px(value);
    }
    return null;
  }

  _resolveAlign(value) {
    const key = String(value || '').toLowerCase();
    if (key === 'end' || key === 'flex-end' || key === 'right' || key === 'bottom') return 'flex-end';
    if (key === 'start' || key === 'flex-start' || key === 'left' || key === 'top') return 'flex-start';
    if (key === 'center' || key === 'centre') return 'center';
    if (key === 'space-between' || key === 'space-around' || key === 'space-evenly') return key;
    return value || null;
  }

  _applySpacingProperty(element, property, value) {
    if (value === null || value === undefined) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [side, amount] of Object.entries(value)) {
        const cssSide = side.toLowerCase();
        if (!['top', 'right', 'bottom', 'left'].includes(cssSide)) continue;
        element.style[`${property}${cssSide[0].toUpperCase()}${cssSide.slice(1)}`] = this._resolveSpacing(amount) || '';
      }
      return;
    }
    element.style[property] = this._resolveSpacing(value) || '';
  }

  _normalizeScreens(layout) {
    if (!layout || typeof layout !== 'object') return [];

    if (Array.isArray(layout.screens)) {
      return layout.screens
        .map((screen, index) => this._normalizeScreen(screen, index))
        .filter(Boolean);
    }
    if (layout.screens && typeof layout.screens === 'object') {
      return Object.entries(layout.screens)
        .map(([id, screen], index) => this._normalizeScreen({ id, ...(screen || {}) }, index))
        .filter(Boolean);
    }
    if (Array.isArray(layout.views)) {
      return layout.views.map((screen, index) => this._normalizeScreen(screen, index)).filter(Boolean);
    }
    for (const key of ['hud', 'menu', 'results']) {
      if (layout[key] && typeof layout[key] === 'object') {
        this._warn(`layout.${key} is a legacy single-screen shape; rendered as one tab.`);
      }
    }
    const legacy = ['hud', 'menu', 'results']
      .filter((key) => layout[key] && typeof layout[key] === 'object')
      .map((key) => this._normalizeScreen({ id: key, label: key.toUpperCase(), root: layout[key] }, 0));
    if (legacy.length) return legacy;

    if (layout.root || layout.nodes) {
      return [this._normalizeScreen({ id: 'main', label: 'MAIN', root: layout.root || layout }, 0)];
    }
    return [];
  }

  _normalizeScreen(screen, index) {
    if (!screen || typeof screen !== 'object') return null;
    const id = collectString(screen.id) || `screen-${index + 1}`;
    const root = screen.root || screen.node || screen.tree || (screen.children ? screen : null);
    if (!root) return null;
    return {
      id,
      label: collectString(screen.label) || id.toUpperCase(),
      root,
    };
  }

  _renderTabs() {
    if (!this.screenTabs) return;
    this.screenTabs.replaceChildren();
    for (const screen of this.screens) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.uiScreen = screen.id;
      button.textContent = screen.label;
      this.screenTabs.append(button);
    }
  }

  setScreen(id, { silent = false } = {}) {
    const screen = this.screens.find((entry) => entry.id === id) || this.screens[0];
    if (!screen) return;
    this.activeScreen = screen.id;
    this.state.activeScreen = screen.id;
    this.root.replaceChildren();
    this.totalNodes = 0;
    this.boundNodes = 0;
    const wrapper = document.createElement('div');
    wrapper.className = 'ui-screen';
    wrapper.dataset.uiScreenId = screen.id;
    const design = { width: this.target.width, height: this.target.height };
    wrapper.append(this._renderNode(screen.root, { parent: null, design, isRoot: true }));
    this.root.append(wrapper);
    this.state.totalNodes = this.totalNodes;
    this.state.boundNodes = this.boundNodes;

    for (const button of this.screenTabs?.querySelectorAll('[data-ui-screen]') || []) {
      const active = button.dataset.uiScreen === screen.id;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (!silent) this._updateCaption();
    this._notify();
  }

  setSize(key, { silent = false } = {}) {
    const preset = SIZE_PRESETS[key] || SIZE_PRESETS['1600x900'];
    this.sizeKey = key in SIZE_PRESETS ? key : '1600x900';
    this.target = { ...preset };
    this.state.size = this.sizeKey;
    this.state.target = { width: preset.width, height: preset.height };
    if (this.activeScreen) this.setScreen(this.activeScreen, { silent: true });
    this.layout();
    for (const button of this.sizeTabs?.querySelectorAll('[data-ui-size]') || []) {
      const active = button.dataset.uiSize === this.sizeKey;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (!silent) this._updateCaption();
    this._notify();
  }

  _notify() {
    if (!this.onChange) return;
    try {
      this.onChange(this.getState());
    } catch {
      // A preview callback must never break rendering.
    }
  }

  layout() {
    if (!this.stage || !this.frame || !this.root) return;
    const stageRect = this.stage.getBoundingClientRect();
    const availableWidth = Math.max(320, stageRect.width - 48);
    const availableHeight = Math.max(240, stageRect.height - 48);
    const scale = Math.min(1, availableWidth / this.target.width, availableHeight / this.target.height);
    this.displayScale = Math.max(0.05, scale);
    this.state.displayScale = Number(this.displayScale.toFixed(4));
    this.frame.style.width = `${Math.round(this.target.width * this.displayScale)}px`;
    this.frame.style.height = `${Math.round(this.target.height * this.displayScale)}px`;
    this.root.style.width = `${this.target.width}px`;
    this.root.style.height = `${this.target.height}px`;
    this.root.style.transform = `scale(${this.displayScale})`;
    this._updateCaption();
    this._notify();
  }

  _updateCaption() {
    if (!this.caption) return;
    const screen = this.screens.find((entry) => entry.id === this.activeScreen);
    const percent = Math.round(this.displayScale * 100);
    const fit = percent < 100 ? ` · FIT ${percent}%` : '';
    this.caption.textContent = `${screen?.label || this.activeScreen || 'UI'} · ${this.target.label}${fit}`;
  }

  _resolveColor(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const token = value.startsWith('$') ? value.slice(1) : value;
      const found = this.colors.get(token) ?? this.colors.get(value);
      if (found !== undefined) return toCssColor(found);
      return value;
    }
    return toCssColor(value);
  }

  _resolveFontFamily(value) {
    if (!value) return null;
    const token = String(value).startsWith('$') ? String(value).slice(1) : String(value);
    if (this.theme.fonts?.[token]) return this.fontFamily || this.theme.font?.mono || FALLBACK_THEME.font.mono;
    if (token === 'mono' || token === 'monospace') return this.fontFamily || this.theme.font?.mono || FALLBACK_THEME.font.mono;
    if (token === 'sans') return this.theme.font?.sans || FALLBACK_THEME.font.sans;
    if (token === 'family') return this.theme.font?.family || this.theme.font?.sans || FALLBACK_THEME.font.sans;
    return value;
  }

  _resolveFontSize(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return `${value}px`;
    if (typeof value === 'string') {
      const token = value.startsWith('$') ? value.slice(1) : value;
      const size = this.theme.font?.size?.[token] ?? this.theme.fonts?.[token]?.size;
      if (size !== undefined) return px(size);
      return px(value);
    }
    return null;
  }

  _applyStyle(element, style, { isText = false } = {}) {
    if (!style || typeof style !== 'object') return;
    const aliases = {
      bg: 'background',
      border_color: 'borderColor',
      font: 'fontFamily',
      size: 'fontSize',
      flex_grow: 'flexGrow',
      text_justify: 'textAlign',
      z_index: 'zIndex',
      align_items: 'alignItems',
      justify_content: 'justifyContent',
    };
    for (const [rawKey, rawValue] of Object.entries(style)) {
      if (rawValue === null || rawValue === undefined) continue;
      const key = aliases[rawKey] || rawKey.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      switch (key) {
        case 'color':
        case 'background':
        case 'borderColor':
        case 'fillColor':
        case 'outlineColor':
          element.style[key] = this._resolveColor(rawValue) || '';
          break;
        case 'backgroundColor':
          element.style.background = this._resolveColor(rawValue) || '';
          break;
        case 'fontFamily':
          element.style.fontFamily = this._resolveFontFamily(rawValue) || '';
          break;
        case 'fontSize':
          element.style.fontSize = this._resolveFontSize(rawValue) || '';
          break;
        case 'padding':
          this._applySpacingProperty(element, 'padding', rawValue);
          break;
        case 'margin':
          this._applySpacingProperty(element, 'margin', rawValue);
          break;
        case 'gap':
          element.style.gap = this._resolveSpacing(rawValue) || '';
          break;
        case 'borderWidth':
          element.style.borderStyle = 'solid';
          element.style.borderWidth = this._resolveSpacing(rawValue) || '';
          break;
        case 'borderRadius':
          element.style.borderRadius = this._resolveSpacing(rawValue) || '';
          break;
        case 'letterSpacing':
          element.style.letterSpacing = this._resolveSpacing(rawValue) || '';
          break;
        case 'lineHeight':
          element.style.lineHeight = typeof rawValue === 'number' ? String(rawValue) : px(rawValue) || '';
          break;
        case 'width':
        case 'height':
        case 'minWidth':
        case 'minHeight':
        case 'maxWidth':
        case 'maxHeight':
          element.style[key] = px(rawValue) || '';
          break;
        case 'flexGrow':
          element.style.flexGrow = String(rawValue);
          break;
        case 'alignItems':
        case 'align':
          element.style.alignItems = this._resolveAlign(rawValue) || '';
          break;
        case 'justifyContent':
        case 'justify':
          element.style.justifyContent = this._resolveAlign(rawValue) || '';
          break;
        case 'boxShadow':
        case 'backgroundImage':
        case 'backgroundSize':
        case 'backgroundPosition':
        case 'textTransform':
        case 'textAlign':
        case 'fontWeight':
        case 'fontStyle':
        case 'opacity':
        case 'zIndex':
        case 'overflow':
        case 'whiteSpace':
        case 'display':
          element.style[key] = String(rawValue);
          break;
        default:
          if (key === 'border') {
            if (typeof rawValue === 'number') {
              element.style.borderStyle = 'solid';
              element.style.borderWidth = `${rawValue}px`;
            } else {
              element.style.border = String(rawValue);
            }
          }
          break;
      }
    }
    if (isText) element.style.fontFamily ||= this.theme.font?.sans || FALLBACK_THEME.font.sans;
  }

  _resolveText(node) {
    const stringKey = node.text_key ?? node.textKey ?? node.key ?? node.string_key ?? node.stringKey;
    let text = stringKey ? this.strings.get(String(stringKey)) : null;
    if (text === null) {
      const raw = node.text ?? node.label ?? node.value_text;
      if (typeof raw === 'string') {
        const token = raw.startsWith('$') ? raw.slice(1) : raw;
        text = this.strings.get(token) ?? raw;
      } else if (typeof raw === 'number') {
        text = String(raw);
      }
    }

    const binding = node.binding ?? node.bind;
    if (binding) {
      this.boundNodes += 1;
      const template = this.strings.get(`fmt.${binding}`);
      let value = null;
      if (template) {
        value = template.replace(/\{(\w+)\}/g, (match, key) => SAMPLE_VALUES[key] ?? match);
      } else if (binding === 'combo' && this.strings.has('fmt.combo_empty')) {
        value = this.strings.get('fmt.combo_empty');
      } else if (binding === 'reload' && this.strings.has('hud.reload.ready')) {
        value = this.strings.get('hud.reload.ready');
      } else if (binding === 'prompt' && this.strings.has('hud.prompt.start')) {
        value = this.strings.get('hud.prompt.start');
      } else {
        value = BINDINGS[binding] ?? null;
      }

      if (value !== null && value !== undefined) {
        if (text && text.includes(`{${binding}}`)) text = text.replaceAll(`{${binding}}`, value);
        else text = value;
      } else if (text) {
        text = text.replaceAll(`{${binding}}`, `{${binding}}`);
      } else {
        text = `{${binding}}`;
      }
    }
    return text ?? '';
  }

  _applyPosition(element, node) {
    const rect = Array.isArray(node.rect) ? node.rect : null;
    if (rect && rect.length >= 4) {
      element.style.position = 'absolute';
      element.style.left = px(rect[0]);
      element.style.top = px(rect[1]);
      element.style.width = px(rect[2]);
      element.style.height = px(rect[3]);
      return;
    }

    const size = Array.isArray(node.size) ? node.size : null;
    const anchor = collectString(node.anchor);
    const rawOffset = node.offset;
    const offset = Array.isArray(rawOffset)
      ? rawOffset
      : typeof rawOffset === 'number'
        ? [rawOffset, rawOffset]
        : [0, 0];
    const x = toNumber(offset[0], 0);
    const y = toNumber(offset[1], 0);
    if (anchor) {
      element.style.position = 'absolute';
      if (anchor === 'top-left' || anchor === 'left-top') {
        element.style.left = px(x);
        element.style.top = px(y);
      } else if (anchor === 'top-right' || anchor === 'right-top') {
        element.style.right = px(x);
        element.style.top = px(y);
      } else if (anchor === 'bottom-left' || anchor === 'left-bottom') {
        element.style.left = px(x);
        element.style.bottom = px(y);
      } else if (anchor === 'bottom-right' || anchor === 'right-bottom') {
        element.style.right = px(x);
        element.style.bottom = px(y);
      } else if (anchor === 'top-center' || anchor === 'top') {
        element.style.left = '50%';
        element.style.top = px(y);
        element.style.transform = `translateX(calc(-50% + ${x}px))`;
      } else if (anchor === 'bottom-center' || anchor === 'bottom') {
        element.style.left = '50%';
        element.style.bottom = px(y);
        element.style.transform = `translateX(calc(-50% + ${x}px))`;
      } else if (anchor === 'left-center' || anchor === 'left') {
        element.style.left = px(x);
        element.style.top = '50%';
        element.style.transform = `translateY(calc(-50% + ${y}px))`;
      } else if (anchor === 'right-center' || anchor === 'right') {
        element.style.right = px(x);
        element.style.top = '50%';
        element.style.transform = `translateY(calc(-50% + ${y}px))`;
      } else {
        element.style.left = '50%';
        element.style.top = '50%';
        element.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
      }
    } else if (typeof node.position === 'string' && ['absolute', 'relative', 'fixed', 'static'].includes(node.position)) {
      element.style.position = node.position;
      if (node.left !== undefined) element.style.left = px(node.left);
      if (node.right !== undefined) element.style.right = px(node.right);
      if (node.top !== undefined) element.style.top = px(node.top);
      if (node.bottom !== undefined) element.style.bottom = px(node.bottom);
    } else if (Array.isArray(node.position)) {
      element.style.position = 'absolute';
      element.style.left = px(node.position[0]);
      element.style.top = px(node.position[1]);
    } else if (node.position && typeof node.position === 'object') {
      element.style.position = 'absolute';
      element.style.left = px(node.position.x);
      element.style.top = px(node.position.y);
    }

    if (node.left !== undefined && !element.style.left) element.style.left = px(node.left);
    if (node.right !== undefined && !element.style.right) element.style.right = px(node.right);
    if (node.top !== undefined && !element.style.top) element.style.top = px(node.top);
    if (node.bottom !== undefined && !element.style.bottom) element.style.bottom = px(node.bottom);

    if (size && size.length >= 2) {
      element.style.width = px(size[0]);
      element.style.height = px(size[1]);
    } else {
      if (node.width !== undefined) element.style.width = px(node.width);
      if (node.height !== undefined) element.style.height = px(node.height);
    }
  }

  _renderNode(node, context = {}) {
    if (!node || typeof node !== 'object' || node.visible === false || node.hidden) {
      const empty = document.createElement('div');
      empty.hidden = true;
      return empty;
    }
    const isRoot = Boolean(context.isRoot);
    if (node.display === 'none' && !isRoot) {
      const empty = document.createElement('div');
      empty.hidden = true;
      return empty;
    }

    this.totalNodes += 1;
    const type = String(node.type ?? node.kind ?? 'panel').toLowerCase();
    const element = document.createElement('div');
    element.className = `ui-node ui-node-${type}`;
    if (node.name || node.id) element.dataset.uiName = String(node.name ?? node.id);
    if (node.binding || node.bind) element.dataset.uiBinding = String(node.binding ?? node.bind);

    const style = this._resolveStyle(node.style ?? node.styles ?? {});
    this._applyPosition(element, node);
    this._applyStyle(element, style, { isText: type === 'text' || type === 'label' });
    if (node.width !== undefined && !element.style.width) element.style.width = px(node.width);
    if (node.height !== undefined && !element.style.height) element.style.height = px(node.height);
    if (node.background !== undefined) element.style.background = this._resolveColor(node.background) || '';
    if (node.margin !== undefined) this._applySpacingProperty(element, 'margin', node.margin);
    if (node.text_justify || node.text_align) element.style.textAlign = node.text_justify || node.text_align;
    if (node.z_index !== undefined) element.style.zIndex = String(node.z_index);
    this._applyBorder(element, node.border ?? node.borders, style);

    const containerTypes = new Set(['overlay', 'fullscreen', 'panel', 'row', 'column', 'group', 'stack', 'spacer', 'button', 'bar']);
    if (containerTypes.has(type)) {
      element.style.display = 'flex';
      element.style.flexDirection = type === 'row' ? 'row' : 'column';
      if (type === 'overlay' || type === 'fullscreen') {
        element.style.position = 'absolute';
        element.style.inset = '0';
        element.style.width = '100%';
        element.style.height = '100%';
      }
      if (type === 'button') {
        element.style.alignItems = 'center';
        element.style.justifyContent = 'center';
      }
      if (node.direction === 'row' || node.direction === 'horizontal') element.style.flexDirection = 'row';
      if (node.direction === 'column' || node.direction === 'vertical') element.style.flexDirection = 'column';
      if (node.gap !== undefined) element.style.gap = this._resolveSpacing(node.gap) || '';
      if (node.padding !== undefined) this._applySpacingProperty(element, 'padding', node.padding);
      if (node.align || node.alignItems) element.style.alignItems = this._resolveAlign(node.align || node.alignItems) || '';
      if (node.justify || node.justifyContent) element.style.justifyContent = this._resolveAlign(node.justify || node.justifyContent) || '';
      if (node.flex_grow !== undefined || node.flexGrow !== undefined) {
        element.style.flexGrow = String(node.flex_grow ?? node.flexGrow);
      }
      if (type === 'spacer') {
        element.style.flex = node.height !== undefined ? `0 0 ${px(node.height)}` : '1 1 auto';
        element.style.minWidth = '0';
        element.style.minHeight = '0';
      }
    }

    if (type === 'crosshair') {
      this._renderCrosshair(element, node, style);
      return element;
    }

    if (type === 'bar' || type === 'progress') {
      const track = document.createElement('div');
      track.className = 'ui-bar-track';
      const fill = document.createElement('div');
      fill.className = 'ui-bar-fill';
      const binding = node.binding ?? node.bind;
      const value = binding ? (binding === 'accuracy' ? 0.86 : binding === 'score' ? 0.62 : 0.5) : toNumber(node.value, 0.5);
      fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
      this._applyStyle(track, { background: node.trackColor ?? style.trackColor ?? '$line' });
      this._applyStyle(fill, { background: node.fillColor ?? style.fillColor ?? style.color ?? '$cyan' });
      track.append(fill);
      element.append(track);
      return element;
    }

    if (type === 'text' || type === 'label') {
      element.textContent = this._resolveText(node);
      element.style.whiteSpace = style.whiteSpace || node.whiteSpace || 'pre-wrap';
      return element;
    }

    if (type === 'button') {
      const label = document.createElement('span');
      label.textContent = this._resolveText(node);
      element.append(label);
    }

    const children = Array.isArray(node.children)
      ? node.children
      : Array.isArray(node.nodes)
        ? node.nodes
        : [];
    for (const child of children) {
      element.append(this._renderNode(child, { ...context, isRoot: false, parent: element }));
    }

    if (!element.childNodes.length && node.text !== undefined) {
      element.textContent = this._resolveText(node);
    }
    return element;
  }

  _applyBorder(element, border, style) {
    if (border === null || border === undefined) return;
    const color = this._resolveColor(style.borderColor ?? style.border_color ?? '$line') || '#46e6ff';
    if (typeof border === 'number') {
      element.style.borderStyle = 'solid';
      element.style.borderWidth = `${border}px`;
      if (!style.borderColor && !style.border_color) element.style.borderColor = color;
      return;
    }
    if (Array.isArray(border) && border.length >= 4) {
      // Bevy UiRect order: left, right, top, bottom.
      element.style.borderStyle = 'solid';
      element.style.borderColor = color;
      element.style.borderWidth = `${border[2]}px ${border[1]}px ${border[3]}px ${border[0]}px`;
      return;
    }
    if (typeof border === 'object') {
      element.style.borderStyle = 'solid';
      if (!style.borderColor && !style.border_color) element.style.borderColor = color;
      for (const [side, width] of Object.entries(border)) {
        const cssSide = side.toLowerCase();
        if (!['top', 'right', 'bottom', 'left'].includes(cssSide)) continue;
        element.style[`border${cssSide[0].toUpperCase()}${cssSide.slice(1)}Width`] = px(width) || '0px';
      }
    }
  }

  _renderCrosshair(element, node, style) {
    const config = node.crosshair && typeof node.crosshair === 'object' ? node.crosshair : {};
    const size = toNumber(config.size ?? style.size ?? node.size ?? 20, 20);
    const gap = toNumber(config.gap ?? style.gap ?? node.gap ?? 8, 8);
    const length = toNumber(config.tick_length ?? style.tickLength ?? Math.round(size * 0.5), Math.round(size * 0.5));
    const thickness = toNumber(config.tick_thickness ?? style.thickness ?? node.thickness ?? 2, 2);
    const dotSize = toNumber(config.dot_size ?? style.dotSize ?? 3, 3);
    const color = this._resolveColor(style.color ?? node.color ?? '$cyan') || '#46e6ff';
    element.innerHTML = '';
    element.style.position = 'relative';
    element.style.width = `${size}px`;
    element.style.height = `${size}px`;
    element.style.flex = '0 0 auto';
    element.style.overflow = 'visible';
    element.style.pointerEvents = 'none';

    const ticks = [
      ['top', thickness, length, '50%', '50%', `translate(-50%, calc(-100% - ${gap}px))`],
      ['bottom', thickness, length, '50%', '50%', `translate(-50%, ${gap}px)`],
      ['left', length, thickness, '50%', '50%', `translate(calc(-100% - ${gap}px), -50%)`],
      ['right', length, thickness, '50%', '50%', `translate(${gap}px, -50%)`],
    ];
    for (const [name, width, height, left, top, transform] of ticks) {
      const bar = document.createElement('i');
      bar.className = `ui-xhair-bar ui-xhair-${name}`;
      Object.assign(bar.style, {
        position: 'absolute',
        width: `${width}px`,
        height: `${height}px`,
        left,
        top,
        background: color,
        transform,
        boxShadow: `0 0 8px ${color}`,
        opacity: '0.9',
      });
      element.append(bar);
    }

    if (dotSize > 0) {
      const dot = document.createElement('i');
      Object.assign(dot.style, {
        position: 'absolute',
        left: '50%',
        top: '50%',
        width: `${dotSize}px`,
        height: `${dotSize}px`,
        background: color,
        transform: 'translate(-50%, -50%)',
        borderRadius: '50%',
      });
      element.append(dot);
    }

    const hitMarker = config.hit_marker;
    if (hitMarker && typeof hitMarker === 'object') {
      const marker = document.createElement('span');
      marker.className = 'ui-xhair-hit';
      marker.textContent = this.strings.get('crosshair.hit_marker') || 'X';
      Object.assign(marker.style, {
        position: 'absolute',
        left: px(hitMarker.left ?? 26),
        top: px(hitMarker.top ?? 23),
        width: px(hitMarker.width ?? 28),
        height: px(hitMarker.height ?? 28),
        color: this._resolveColor(style.hitColor ?? style.color ?? 'hit_marker') || '#ffb833',
        fontFamily: this.fontFamily || 'monospace',
        fontSize: '25px',
        lineHeight: px(hitMarker.height ?? 28),
        textAlign: 'center',
        opacity: '0.92',
      });
      element.append(marker);
    }

    const lock = config.lock;
    if (lock && typeof lock === 'object') {
      const lockLabel = document.createElement('span');
      lockLabel.className = 'ui-xhair-lock';
      lockLabel.textContent = this.strings.get('crosshair.lock') || 'LOCK';
      Object.assign(lockLabel.style, {
        position: 'absolute',
        left: px(lock.left ?? 0),
        top: px(lock.top ?? 65),
        width: px(lock.width ?? 80),
        height: px(lock.height ?? 15),
        color: this._resolveColor('lock') || '#ff8a26',
        fontFamily: this.fontFamily || 'monospace',
        fontSize: '9px',
        lineHeight: px(lock.height ?? 15),
        textAlign: 'center',
        letterSpacing: '2px',
      });
      element.append(lockLabel);
    }

    const popup = config.popup;
    if (popup && typeof popup === 'object') {
      const popupLabel = document.createElement('span');
      popupLabel.className = 'ui-xhair-popup';
      popupLabel.textContent = '+100';
      Object.assign(popupLabel.style, {
        position: 'absolute',
        left: px(popup.left ?? -70),
        top: px(popup.top ?? 92),
        width: px(popup.width ?? 220),
        height: px(popup.height ?? 22),
        color: this._resolveColor('popup_hit') || '#ffb833',
        fontFamily: this.fontFamily || 'monospace',
        fontSize: '15px',
        lineHeight: px(popup.height ?? 22),
        textAlign: 'center',
      });
      element.append(popupLabel);
    }
  }

  dispose() {
    window.removeEventListener('resize', this._onResize);
    this.root?.replaceChildren();
  }
}
