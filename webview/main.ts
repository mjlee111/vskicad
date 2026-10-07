import type { HostMessage, LayerInfo, PageInfo, PreviewKind, Target, WebviewMessage } from '../src/protocol';
import { defaultOpacity, defaultVisible, stackOrder } from './layers';
import { SvgView } from './svgView';
import type { View3D, ViewPreset } from './view3d';

declare function acquireVsCodeApi(): { postMessage(msg: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const kind = (document.body.dataset.kind ?? 'sch') as PreviewKind;
const post = (m: WebviewMessage) => vscode.postMessage(m);

// ---------- DOM helpers ----------

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Record<string, string>> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) if (v !== undefined) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function button(label: string, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', { title, class: `btn ${cls}`.trim(), type: 'button' }, label);
  b.addEventListener('click', onClick);
  return b;
}

// ---------- Layout ----------

const app = document.getElementById('app')!;
const toolbar = h('div', { class: 'toolbar' });
const main = h('div', { class: 'main' });
const statusbar = h('div', { class: 'statusbar' });
app.append(toolbar, main, statusbar);

const sidebar = h('div', { class: 'sidebar hidden' });
const pane2d = h('div', { class: 'pane pane-2d' });
const pane3d = h('div', { class: 'pane pane-3d hidden' });
const viewport2d = h('div', { class: 'viewport viewport-2d' });
const viewport3d = h('div', { class: 'viewport viewport-3d' });
pane2d.append(viewport2d);
pane3d.append(viewport3d);
main.append(sidebar, pane2d, pane3d);
viewport2d.classList.add(kind === 'pcb' ? 'bg-pcb' : 'bg-sch');

const statusFile = h('span', { class: 'status-file' });
const statusMsg = h('span', { class: 'status-msg' });
const statusZoom = h('span', { class: 'status-zoom' });
statusbar.append(statusFile, statusMsg, statusZoom);

/** Busy and error overlays, one set per target pane. */
class Overlay {
  private readonly busy = h('div', { class: 'overlay busy hidden' }, h('div', { class: 'spinner' }), h('span', { class: 'busy-text' }));
  private readonly error = h('div', { class: 'overlay error hidden' });

  constructor(pane: HTMLElement) {
    pane.append(this.busy, this.error);
  }

  showBusy(text: string): void {
    this.error.classList.add('hidden');
    this.busy.querySelector('.busy-text')!.textContent = text;
    this.busy.classList.remove('hidden');
  }

  hideBusy(): void {
    this.busy.classList.add('hidden');
  }

  showError(message: string): void {
    this.hideBusy();
    const actions = h(
      'div',
      { class: 'error-actions' },
      button('Retry', 'Export again', () => post({ type: 'refresh' })),
      button('Show Log', 'Open the KiCad Preview output channel', () => post({ type: 'showLog' })),
      button('Settings', 'Open KiCad Preview settings', () => post({ type: 'openSettings', query: 'vskicad' })),
    );
    this.error.replaceChildren(h('div', { class: 'error-title' }, 'Preview failed'), h('pre', { class: 'error-text' }, message), actions);
    this.error.classList.remove('hidden');
  }

  hideError(): void {
    this.error.classList.add('hidden');
  }
}

const overlays: Record<Target, Overlay> = { '2d': new Overlay(pane2d), '3d': new Overlay(pane3d) };

// ---------- 2D view ----------

const svgView = new SvgView(viewport2d);
svgView.onZoomChange = (p) => {
  if (mode === '2d') statusZoom.textContent = `${p}%`;
};
// Lazily loaded layers get their color swatch once their content is known.
svgView.onLayerLoaded = () => renderLayerList();
svgView.onLayerError = (id, e) => setStatus(`Layer ${id} failed to load: ${e.message}`);

let mode: Target = '2d';
let pages: PageInfo[] = [];
let pageIndex = 0;
let layers: LayerInfo[] = [];
const layerVisible = new Map<string, boolean>();
let flipped = false;

const pageSelect = h('select', { class: 'page-select hidden', title: 'Schematic sheet' });
pageSelect.addEventListener('change', () => {
  pageIndex = pageSelect.selectedIndex;
  void showPage();
});

async function showPage(): Promise<void> {
  const page = pages[pageIndex];
  if (!page) return;
  try {
    await svgView.load([{ id: 'page', uri: page.uri, visible: true }]);
    overlays['2d'].hideBusy();
  } catch (e) {
    overlays['2d'].showError((e as Error).message);
  }
}

function onSchematic(newPages: PageInfo[], fromCache: boolean): void {
  const current = pages[pageIndex]?.name;
  pages = newPages;
  const keep = pages.findIndex((p) => p.name === current);
  pageIndex = keep >= 0 ? keep : 0;
  pageSelect.replaceChildren(...pages.map((p, i) => h('option', { value: String(i) }, `${i + 1}. ${p.name}`)));
  pageSelect.selectedIndex = pageIndex;
  pageSelect.classList.toggle('hidden', pages.length < 2);
  setStatus(`${pages.length} sheet(s)${fromCache ? ' · cached' : ''}`);
  void showPage();
}

function layerColor(id: string): string {
  const g = svgView.root.querySelector(`g[data-layer="${CSS.escape(id)}"]`);
  const styles = Array.from(g?.querySelectorAll('[style]') ?? []).map((e) => e.getAttribute('style') ?? '');
  for (const s of styles) {
    for (const m of s.matchAll(/(?:fill|stroke):\s*(#[0-9a-fA-F]{6})/g)) {
      const c = m[1].toUpperCase();
      if (c !== '#000000' && c !== '#FFFFFF') return c;
    }
  }
  return 'transparent';
}

function renderLayerList(): void {
  const rows = layers.map((l) => {
    const cb = h('input', { type: 'checkbox' }) as HTMLInputElement;
    cb.checked = layerVisible.get(l.name) ?? defaultVisible(l.name);
    cb.addEventListener('change', () => {
      layerVisible.set(l.name, cb.checked);
      svgView.setVisible(l.name, cb.checked);
    });
    const swatch = h('span', { class: svgView.isLoaded(l.name) ? 'swatch' : 'swatch pending', title: svgView.isLoaded(l.name) ? '' : 'Loaded when shown' });
    swatch.style.background = layerColor(l.name);
    const label = l.label === l.name ? l.name : `${l.name} (${l.label})`;
    return h('label', { class: 'layer-row', title: label }, cb, swatch, h('span', { class: 'layer-name' }, label));
  });
  const allOn = button('All', 'Show all layers', () => setAllLayers(true), 'small');
  const allOff = button('None', 'Hide all layers', () => setAllLayers(false), 'small');
  sidebar.replaceChildren(h('div', { class: 'sidebar-head' }, h('span', {}, 'Layers'), allOn, allOff), ...rows);
}

function setAllLayers(on: boolean): void {
  for (const l of layers) {
    layerVisible.set(l.name, on);
    svgView.setVisible(l.name, on);
  }
  renderLayerList();
}

function applyStack(): void {
  svgView.setFlipped(flipped);
  svgView.setOrder(stackOrder(layers.map((l) => l.name), flipped));
}

async function onPcb2d(newLayers: LayerInfo[], fromCache: boolean): Promise<void> {
  layers = newLayers;
  const ordered = stackOrder(layers.map((l) => l.name), flipped);
  const byName = new Map(layers.map((l) => [l.name, l]));
  try {
    // Hidden layers are fetched on first show (fabrication layers can be very large).
    await svgView.load(
      ordered.map((n) => ({ id: n, uri: byName.get(n)!.uri, visible: layerVisible.get(n) ?? defaultVisible(n) })),
    );
  } catch (e) {
    overlays['2d'].showError((e as Error).message);
    return;
  }
  for (const l of layers) svgView.setOpacity(l.name, defaultOpacity(l.name));
  applyStack();
  renderLayerList();
  overlays['2d'].hideBusy();
  setStatus(`${layers.length} layer(s)${fromCache ? ' · cached' : ''}`);
}

// ---------- 3D view ----------

let view3d: View3D | undefined;
let requested3d = false;
const componentsToggle = h('input', { type: 'checkbox', checked: '' }) as HTMLInputElement;
componentsToggle.addEventListener('change', () => view3d?.setComponentsVisible(componentsToggle.checked));
let missingInfo = '';

async function ensureView3d(): Promise<View3D> {
  if (!view3d) {
    // Loaded lazily so schematic previews never initialize WebGL.
    const mod = await import('./view3d');
    view3d = new mod.View3D(viewport3d);
  }
  return view3d;
}

async function onGlb(uri: string, missing: string[], fromCache: boolean): Promise<void> {
  try {
    const v = await ensureView3d();
    overlays['3d'].showBusy('Loading 3D model…');
    await v.load(uri);
    v.setComponentsVisible(componentsToggle.checked);
    overlays['3d'].hideBusy();
    missingInfo = missing.length > 0 ? `${missing.length} 3D model(s) not found (see log)` : '';
    if (mode === '3d') setStatus(`${v.countComponents()} component model(s)${fromCache ? ' · cached' : ''}`);
  } catch (e) {
    overlays['3d'].showError(`Failed to display GLB: ${(e as Error).message}`);
  }
}

function setStatus(text: string): void {
  statusMsg.replaceChildren(text);
  if (mode === '3d' && missingInfo) {
    const link = h('a', { href: '#', class: 'warn', title: 'Show the list in the output log' }, missingInfo);
    link.addEventListener('click', (e) => {
      e.preventDefault();
      post({ type: 'showLog' });
    });
    statusMsg.append(' · ', link);
  }
}

// ---------- Toolbar ----------

const tab2d = button('2D', 'Layer view', () => setMode('2d'), 'tab active');
const tab3d = button('3D', '3D view', () => setMode('3d'), 'tab');
const flipBtn = button('Bottom', 'Toggle bottom-side (mirrored) view', () => {
  flipped = !flipped;
  flipBtn.classList.toggle('active', flipped);
  applyStack();
});
const layersBtn = button('Layers', 'Show or hide the layer list', () => {
  sidebar.classList.toggle('hidden');
  layersBtn.classList.toggle('active', !sidebar.classList.contains('hidden'));
});

const group2d = h(
  'div',
  { class: 'group' },
  button('Fit', 'Fit to window (F or double-click)', () => svgView.fit()),
  button('+', 'Zoom in', () => svgView.zoomBy(1.25)),
  button('−', 'Zoom out', () => svgView.zoomBy(0.8)),
);
if (kind === 'pcb') group2d.append(layersBtn, flipBtn);

const preset = (p: ViewPreset, label: string) => button(label, `${label} view`, () => view3d?.setView(p));
const group3d = h(
  'div',
  { class: 'group hidden' },
  preset('iso', 'Iso'),
  preset('top', 'Top'),
  preset('bottom', 'Bottom'),
  preset('front', 'Front'),
  h('label', { class: 'check', title: 'Show component 3D models' }, componentsToggle, 'Components'),
  button('3D Options', 'Choose what is included in the 3D export (tracks, zones, silkscreen…)', () =>
    post({ type: 'openSettings', query: 'vskicad.3d' }),
  ),
);

// High-quality still from KiCad's raytracer, using the current 3D camera angle and zoom.
const snapshotBtn = button('Snapshot', 'Render this view with KiCad\'s raytracer (high quality image)', () => {
  if (!view3d?.hasModel) return;
  const r = viewport3d.getBoundingClientRect();
  // 1920 px wide at the viewport aspect ratio.
  const width = 1920;
  const height = Math.round((width * Math.max(r.height, 1)) / Math.max(r.width, 1));
  const v = view3d.getKicadView(width, height);
  snapshotBtn.disabled = true;
  snapshotBtn.textContent = 'Rendering…';
  post({ type: 'snapshot', rotate: v.rotate, zoom: v.zoom, width, height });
});
group3d.append(snapshotBtn);

const refreshBtn = button('Refresh', 'Export again with kicad-cli', () => post({ type: 'refresh' }));

if (kind === 'pcb') toolbar.append(h('div', { class: 'group tabs' }, tab2d, tab3d));
else toolbar.append(pageSelect);
toolbar.append(group2d, group3d, h('div', { class: 'spacer' }), refreshBtn);

if (kind === 'pcb') {
  sidebar.classList.remove('hidden');
  layersBtn.classList.add('active');
}

function setMode(m: Target): void {
  if (kind !== 'pcb' || m === mode) return;
  mode = m;
  tab2d.classList.toggle('active', m === '2d');
  tab3d.classList.toggle('active', m === '3d');
  group2d.classList.toggle('hidden', m !== '2d');
  group3d.classList.toggle('hidden', m !== '3d');
  pane2d.classList.toggle('hidden', m !== '2d');
  pane3d.classList.toggle('hidden', m !== '3d');
  sidebar.classList.toggle('hidden', m !== '2d' || !layersBtn.classList.contains('active'));
  statusZoom.textContent = '';
  if (m === '3d') {
    if (!requested3d) {
      requested3d = true;
      overlays['3d'].showBusy('Exporting 3D model with kicad-cli…');
      post({ type: 'request3d' });
    } else {
      view3d?.requestRender();
      setStatus(view3d ? `${view3d.countComponents()} component model(s)` : '');
    }
  } else {
    setStatus(`${layers.length} layer(s)`);
  }
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (mode !== '2d') return;
  if (e.key === 'f' || e.key === 'F') svgView.fit();
  else if (e.key === '+' || e.key === '=') svgView.zoomBy(1.25);
  else if (e.key === '-') svgView.zoomBy(0.8);
});

// ---------- Host messages ----------

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const m = event.data;
  switch (m.type) {
    case 'init':
      statusFile.textContent = m.fileName;
      break;
    case 'busy':
      overlays[m.target].showBusy(m.message);
      break;
    case 'schematic':
      overlays['2d'].hideError();
      onSchematic(m.pages, m.fromCache);
      break;
    case 'pcb2d':
      overlays['2d'].hideError();
      void onPcb2d(m.layers, m.fromCache);
      break;
    case 'glb':
      overlays['3d'].hideError();
      void onGlb(m.uri, m.missingModels, m.fromCache);
      break;
    case 'error':
      overlays[m.target].showError(m.message);
      break;
    case 'show3d':
      setMode('3d');
      break;
    case 'snapshotDone':
      snapshotBtn.disabled = false;
      snapshotBtn.textContent = 'Snapshot';
      break;
  }
});

post({ type: 'ready' });
