// 2D vector viewer: merges one or more KiCad SVG documents into a single inline <svg>
// and implements pan/zoom by rewriting the viewBox, so output stays sharp at any zoom.
// Hidden layers are fetched lazily. For heavy drawings, interaction uses a cheap CSS
// transform and the exact viewBox is committed once input pauses.

const SVG_NS = 'http://www.w3.org/2000/svg';
const MIN_SCALE_FACTOR = 1 / 200; // relative to fit scale: max zoom-in
const MAX_SCALE_FACTOR = 8; // relative to fit scale: max zoom-out
const HEAVY_ELEMENT_COUNT = 30000;
const COMMIT_DELAY_MS = 140;

export interface SvgLayerSource {
  id: string;
  uri: string;
  visible: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface View {
  cx: number;
  cy: number;
  k: number;
}

interface LayerSlot {
  group: SVGGElement;
  uri: string;
  loaded: boolean;
  loading?: Promise<void>;
}

export class SvgView {
  readonly root: SVGSVGElement;
  // Wrapper that receives interim CSS transforms; transforming the <svg> itself repaints it.
  private readonly stage: HTMLDivElement;
  private readonly content: SVGGElement;
  private readonly slots = new Map<string, LayerSlot>();
  private doc: Box | undefined;
  // Live view: center in document units and document units per CSS pixel.
  private view: View = { cx: 0, cy: 0, k: 1 };
  // View currently encoded in the viewBox attribute.
  private committed: View = { cx: 0, cy: 0, k: 1 };
  private fitK = 1;
  private flipped = false;
  private heavy = false;
  private commitTimer: number | undefined;
  private drag: { x: number; y: number; id: number } | undefined;
  private loadSeq = 0;
  // Set when fit() runs while the pane is hidden (zero size); applied on the next resize.
  private pendingFit = false;
  onZoomChange: (percent: number) => void = () => undefined;
  onLayerLoaded: (id: string) => void = () => undefined;
  onLayerError: (id: string, err: Error) => void = () => undefined;

  constructor(private readonly host: HTMLElement) {
    this.root = document.createElementNS(SVG_NS, 'svg');
    this.root.setAttribute('preserveAspectRatio', 'none');
    this.root.classList.add('svg-root');
    this.content = document.createElementNS(SVG_NS, 'g');
    this.root.appendChild(this.content);
    this.stage = document.createElement('div');
    this.stage.className = 'svg-stage';
    this.stage.appendChild(this.root);
    host.appendChild(this.stage);

    host.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    host.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    host.addEventListener('pointermove', (e) => this.onPointerMove(e));
    host.addEventListener('pointerup', (e) => this.onPointerUp(e));
    host.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    host.addEventListener('dblclick', () => this.fit());
    new ResizeObserver(() => {
      if (this.pendingFit) this.fit();
      else this.commit();
    }).observe(host);
  }

  /**
   * Loads SVG files as stacked layers (first = bottom). Only visible layers are fetched now.
   * The current view is kept when the document size is unchanged, so refresh does not reset zoom.
   */
  async load(sources: SvgLayerSource[]): Promise<void> {
    const seq = ++this.loadSeq;
    // At least one layer must be loaded to know the document extents.
    const eager = sources.filter((s) => s.visible);
    if (eager.length === 0 && sources.length > 0) eager.push(sources[0]);
    const parsed = new Map<string, SVGSVGElement>();
    await Promise.all(eager.map(async (s) => parsed.set(s.id, await fetchSvg(s.uri))));
    if (seq !== this.loadSeq) return; // A newer load superseded this one.

    const box = parseViewBox(parsed.values().next().value);
    const sameDoc = !!this.doc && !!box && Math.abs(this.doc.w - box.w) < 1e-3 && Math.abs(this.doc.h - box.h) < 1e-3;
    this.doc = box ?? { x: 0, y: 0, w: 100, h: 100 };

    this.content.replaceChildren();
    this.slots.clear();
    for (const s of sources) {
      const group = document.createElementNS(SVG_NS, 'g');
      group.dataset.layer = s.id;
      const svg = parsed.get(s.id);
      if (svg) appendSvgChildren(group, svg);
      if (!s.visible) group.style.display = 'none';
      this.slots.set(s.id, { group, uri: s.uri, loaded: !!svg });
      this.content.appendChild(group);
    }
    this.updateHeavy();
    this.applyFlipTransform();
    if (sameDoc) this.commit();
    else this.fit();
  }

  /**
   * Heavy drawings keep a persistent compositor layer so pan/zoom transforms do not
   * re-rasterize; toggling will-change per gesture would force a full raster each time.
   */
  private updateHeavy(): void {
    this.heavy = this.root.getElementsByTagName('*').length > HEAVY_ELEMENT_COUNT;
    this.stage.style.willChange = this.heavy ? 'transform' : '';
  }

  isLoaded(id: string): boolean {
    return this.slots.get(id)?.loaded ?? false;
  }

  /** Shows or hides a layer, fetching it on first show. */
  setVisible(id: string, visible: boolean): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.group.style.display = visible ? '' : 'none';
    if (visible && !slot.loaded && !slot.loading) {
      const seq = this.loadSeq;
      slot.loading = fetchSvg(slot.uri)
        .then((svg) => {
          if (seq !== this.loadSeq) return;
          appendSvgChildren(slot.group, svg);
          slot.loaded = true;
          this.updateHeavy();
          this.onLayerLoaded(id);
        })
        .catch((e: Error) => this.onLayerError(id, e))
        .finally(() => {
          slot.loading = undefined;
        });
    }
  }

  setOpacity(id: string, opacity: number): void {
    const slot = this.slots.get(id);
    if (slot) slot.group.style.opacity = String(opacity);
  }

  /** Re-stacks layer groups; ids not listed keep their relative order at the end. */
  setOrder(ids: string[]): void {
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (slot) this.content.appendChild(slot.group);
    }
  }

  /** Mirrors the drawing horizontally (bottom-side view). */
  setFlipped(flipped: boolean): void {
    this.flipped = flipped;
    this.applyFlipTransform();
  }

  fit(): void {
    if (!this.doc) return;
    const rect = this.host.getBoundingClientRect();
    this.pendingFit = rect.width < 2 || rect.height < 2;
    if (this.pendingFit) return;
    this.fitK = Math.max(this.doc.w / rect.width, this.doc.h / rect.height) * 1.04;
    this.view = { cx: this.doc.x + this.doc.w / 2, cy: this.doc.y + this.doc.h / 2, k: this.fitK };
    this.commit();
  }

  zoomBy(factor: number, clientX?: number, clientY?: number): void {
    if (!this.doc) return;
    const rect = this.host.getBoundingClientRect();
    const px = (clientX ?? rect.left + rect.width / 2) - rect.left - rect.width / 2;
    const py = (clientY ?? rect.top + rect.height / 2) - rect.top - rect.height / 2;
    const v = this.view;
    // Keep the document point under the cursor fixed.
    const sx = v.cx + px * v.k;
    const sy = v.cy + py * v.k;
    const k = clamp(v.k / factor, this.fitK * MIN_SCALE_FACTOR, this.fitK * MAX_SCALE_FACTOR);
    this.view = { cx: sx - px * k, cy: sy - py * k, k };
    this.update();
  }

  private viewportSize(): { w: number; h: number } {
    const r = this.host.getBoundingClientRect();
    return { w: Math.max(1, r.width), h: Math.max(1, r.height) };
  }

  private applyFlipTransform(): void {
    if (this.flipped && this.doc) {
      this.content.setAttribute('transform', `translate(${2 * this.doc.x + this.doc.w} 0) scale(-1 1)`);
    } else {
      this.content.removeAttribute('transform');
    }
  }

  /** Applies the live view: immediately for light drawings, via CSS transform for heavy ones. */
  private update(): void {
    this.onZoomChange(Math.round((this.fitK / this.view.k) * 100));
    if (!this.heavy) {
      this.commit();
      return;
    }
    // Map the committed raster onto the live view: p_live = a * p_committed + t.
    const { w, h } = this.viewportSize();
    const c = this.committed;
    const v = this.view;
    const a = c.k / v.k;
    const tx = (c.cx - v.cx) / v.k + (w / 2) * (1 - a);
    const ty = (c.cy - v.cy) / v.k + (h / 2) * (1 - a);
    this.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${a})`;
    window.clearTimeout(this.commitTimer);
    this.commitTimer = window.setTimeout(() => this.commit(), COMMIT_DELAY_MS);
  }

  private commit(): void {
    window.clearTimeout(this.commitTimer);
    const { w, h } = this.viewportSize();
    const v = this.view;
    const vw = w * v.k;
    const vh = h * v.k;
    this.root.setAttribute('viewBox', `${v.cx - vw / 2} ${v.cy - vh / 2} ${vw} ${vh}`);
    this.stage.style.transform = '';
    this.committed = { ...v };
    this.onZoomChange(Math.round((this.fitK / v.k) * 100));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Normalize line/page deltas to pixels.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.zoomBy(Math.exp(-dy * 0.0015), e.clientX, e.clientY);
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1) return;
    this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.host.setPointerCapture(e.pointerId);
    this.host.classList.add('dragging');
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    const v = this.view;
    this.view = { cx: v.cx - (e.clientX - this.drag.x) * v.k, cy: v.cy - (e.clientY - this.drag.y) * v.k, k: v.k };
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    this.update();
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.drag || e.pointerId !== this.drag.id) return;
    this.drag = undefined;
    this.host.releasePointerCapture(e.pointerId);
    this.host.classList.remove('dragging');
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function appendSvgChildren(target: SVGGElement, svg: SVGSVGElement): void {
  for (const child of Array.from(svg.childNodes)) {
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const name = (child as Element).localName;
    if (name === 'title' || name === 'desc') continue;
    target.appendChild(document.importNode(child, true));
  }
}

async function fetchSvg(uri: string): Promise<SVGSVGElement> {
  const res = await fetch(uri);
  if (!res.ok) throw new Error(`Failed to load ${uri}: HTTP ${res.status}`);
  const text = await res.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`Invalid SVG: ${err.textContent?.slice(0, 200) ?? ''}`);
  const svg = doc.documentElement as unknown as SVGSVGElement;
  sanitize(svg);
  return svg;
}

/** Defense in depth on top of the CSP: drop active content KiCad never emits. */
function sanitize(root: Element): void {
  root.querySelectorAll('script, foreignObject, iframe, object, embed').forEach((n) => n.remove());
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const isHref = name === 'href' || name === 'xlink:href';
      if (name.startsWith('on') || (isHref && !attr.value.startsWith('#') && !attr.value.startsWith('data:image/'))) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

function parseViewBox(svg: SVGSVGElement | undefined): Box | undefined {
  const vb = svg?.getAttribute('viewBox');
  if (!vb) return undefined;
  const [x, y, w, h] = vb.trim().split(/[\s,]+/).map(Number);
  if ([x, y, w, h].some((n) => !Number.isFinite(n)) || w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}
