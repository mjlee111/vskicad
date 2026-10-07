import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { KicadCli, RunOptions, runCli } from './cli';

export interface SheetPage {
  name: string;
  file: string;
}

export interface BoardLayer {
  /** Untranslated canonical name, e.g. "F.Cu". */
  name: string;
  /** User-defined name if set, e.g. "top_copper". */
  userName?: string;
  type: string;
}

export interface LayerImage extends BoardLayer {
  file: string;
}

export interface Glb3dResult {
  file: string;
  missingModels: string[];
}

export interface PcbSvgOptions {
  layers: string[];
  theme: string;
  drillShape: 'none' | 'small' | 'actual';
}

export interface GlbOptions {
  substituteModels: boolean;
  includeTracks: boolean;
  includePads: boolean;
  includeZones: boolean;
  includeSilkscreen: boolean;
  includeSoldermask: boolean;
}

const COPPER_TYPES = new Set(['signal', 'power', 'mixed', 'jumper']);
const DEFAULT_NON_COPPER = ['F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'F.Fab', 'B.Fab', 'Edge.Cuts'];

/** Extracts the "Plotted to '<file>'" paths kicad-cli prints, preserving order. */
export function parsePlottedFiles(stdout: string): string[] {
  const out: string[] = [];
  const re = /'([^'\r\n]+\.(?:svg|glb))'/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout))) out.push(m[1]);
  return out;
}

/** Returns files of the given extension in dir, ordered by the CLI output and then by name. */
function collectOutputs(dir: string, ext: string, stdout: string): string[] {
  const present = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => path.join(dir, f));
  const byName = new Map(present.map((p) => [path.basename(p), p]));
  const ordered: string[] = [];
  for (const p of parsePlottedFiles(stdout)) {
    const hit = byName.get(path.basename(p));
    if (hit && !ordered.includes(hit)) ordered.push(hit);
  }
  for (const p of present.sort()) if (!ordered.includes(p)) ordered.push(p);
  return ordered;
}

export async function exportSchematic(cli: KicadCli, input: string, outDir: string, theme: string, run: RunOptions): Promise<SheetPage[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['sch', 'export', 'svg', '-o', outDir];
  if (theme) args.push('--theme', theme);
  args.push(input);
  const r = await runCli(cli, args, { ...run, cwd: path.dirname(input) });

  const stem = path.basename(input, path.extname(input));
  const files = collectOutputs(outDir, '.svg', r.stdout);
  if (files.length === 0) throw new Error(`kicad-cli produced no SVG.\n${(r.stderr || r.stdout).trim()}`);
  return files.map((file) => {
    const base = path.basename(file, '.svg');
    const name = base === stem ? stem : base.startsWith(stem + '-') ? base.slice(stem.length + 1) : base;
    return { name, file };
  });
}

/** Parses the board's "(layers ...)" table. Works on KiCad 6+ board files. */
export function parseBoardLayers(boardText: string): BoardLayer[] {
  const start = boardText.search(/\(\s*layers\s*\(/);
  if (start < 0) return [];
  // Walk parentheses to find the end of the layers block.
  let depth = 0;
  let end = start;
  for (let i = start; i < boardText.length; i++) {
    const ch = boardText[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = boardText.slice(start, end);
  const out: BoardLayer[] = [];
  // Layer names are quoted since KiCad 6 and bare in older files: (0 F.Cu signal) / (0 "F.Cu" signal "top").
  const re = /\(\s*\d+\s+(?:"([^"]+)"|([^\s()"]+))\s+([A-Za-z_]+)(?:\s+"([^"]*)")?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) out.push({ name: m[1] ?? m[2], type: m[3], userName: m[4] || undefined });
  return out;
}

/** Chooses the layers to export: configured list (filtered) or a default set. */
export function selectLayers(board: BoardLayer[], configured: string[]): BoardLayer[] {
  const byName = new Map(board.map((l) => [l.name, l]));
  if (configured.length > 0) {
    return configured.map((n) => byName.get(n)).filter((l): l is BoardLayer => !!l);
  }
  const copper = board.filter((l) => COPPER_TYPES.has(l.type) && l.name.endsWith('.Cu'));
  const other = DEFAULT_NON_COPPER.map((n) => byName.get(n)).filter((l): l is BoardLayer => !!l);
  return [...copper, ...other];
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** Maps exported files to layers by file-name suffix, falling back to output order. */
export function matchLayerFiles(layers: BoardLayer[], files: string[], stem: string): LayerImage[] {
  const remaining = [...files];
  const result: LayerImage[] = [];
  const unmatched: BoardLayer[] = [];
  for (const layer of layers) {
    const keys = [layer.userName, layer.name].filter((k): k is string => !!k).map(normalize);
    const idx = remaining.findIndex((f) => {
      const base = path.basename(f, '.svg');
      const suffix = normalize(base.startsWith(stem + '-') ? base.slice(stem.length + 1) : base);
      return keys.includes(suffix);
    });
    if (idx >= 0) {
      result.push({ ...layer, file: remaining[idx] });
      remaining.splice(idx, 1);
    } else {
      unmatched.push(layer);
    }
  }
  // Positional fallback only when counts line up, to avoid mislabeling layers.
  if (unmatched.length > 0 && unmatched.length === remaining.length) {
    unmatched.forEach((l, i) => result.push({ ...l, file: remaining[i] }));
  }
  const order = new Map(layers.map((l, i) => [l.name, i]));
  return result.sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0));
}

const DRILL_SHAPE = { none: '0', small: '1', actual: '2' } as const;

export async function exportPcbLayers(cli: KicadCli, input: string, outDir: string, opts: PcbSvgOptions, run: RunOptions): Promise<LayerImage[]> {
  fs.mkdirSync(outDir, { recursive: true });
  const board = parseBoardLayers(fs.readFileSync(input, 'utf8'));
  const layers = selectLayers(board, opts.layers);
  if (layers.length === 0) throw new Error('No exportable layers found in the board file.');

  const args = [
    'pcb', 'export', 'svg',
    '--mode-multi',
    '--page-size-mode', '2',
    '--exclude-drawing-sheet',
    '--drill-shape-opt', DRILL_SHAPE[opts.drillShape] ?? '2',
    '--layers', layers.map((l) => l.name).join(','),
    '-o', outDir,
  ];
  if (opts.theme) args.push('--theme', opts.theme);
  args.push(input);
  const r = await runCli(cli, args, { ...run, cwd: path.dirname(input) });

  const files = collectOutputs(outDir, '.svg', r.stdout);
  const stem = path.basename(input, path.extname(input));
  const images = matchLayerFiles(layers, files, stem);
  if (images.length === 0) throw new Error(`kicad-cli produced no layer SVG.\n${(r.stderr || r.stdout).trim()}`);
  return images;
}

/** Extracts unresolved 3D model messages ("Could not add 3D model for X") from kicad-cli output. */
export function parseMissingModels(output: string): string[] {
  const refs = new Set<string>();
  const re = /Could not add 3D model for ([^\s.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output))) refs.add(m[1]);
  return [...refs];
}

export async function exportGlb(cli: KicadCli, input: string, outDir: string, opts: GlbOptions, run: RunOptions): Promise<Glb3dResult> {
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'board.glb');
  const args = ['pcb', 'export', 'glb', '--force', '-o', out];
  if (opts.substituteModels) args.push('--subst-models');
  if (opts.includeTracks) args.push('--include-tracks');
  if (opts.includePads) args.push('--include-pads');
  if (opts.includeZones) args.push('--include-zones');
  if (opts.includeSilkscreen) args.push('--include-silkscreen');
  if (opts.includeSoldermask) args.push('--include-soldermask');
  args.push(input);
  const r = await runCli(cli, args, { ...run, cwd: path.dirname(input) });
  if (!fs.existsSync(out)) throw new Error(`kicad-cli produced no GLB.\n${(r.stderr || r.stdout).trim()}`);
  return { file: out, missingModels: parseMissingModels(r.stdout + '\n' + r.stderr) };
}

export interface SnapshotOptions {
  /** `--rotate` angles in degrees (board-to-view rotation Rx * Ry * Rz). */
  rotate: [number, number, number];
  zoom: number;
  width: number;
  height: number;
}

/** Builds kicad-cli arguments for a raytraced render (quality high, floor and shadows). */
export function snapshotArgs(input: string, output: string, o: SnapshotOptions): string[] {
  const clampInt = (v: number, lo: number, hi: number) => String(Math.round(Math.min(Math.max(v, lo), hi)));
  const num = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(2)) : 0).toString();
  return [
    'pcb', 'render',
    '-o', output,
    '--width', clampInt(o.width, 64, 7680),
    '--height', clampInt(o.height, 64, 4320),
    '--quality', 'high',
    '--floor',
    '--perspective',
    '--background', 'opaque',
    '--rotate', o.rotate.map(num).join(','),
    '--zoom', num(Math.min(Math.max(o.zoom, 0.1), 50)),
    input,
  ];
}

export async function renderSnapshot(cli: KicadCli, input: string, output: string, o: SnapshotOptions, run: RunOptions): Promise<string> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const r = await runCli(cli, snapshotArgs(input, output, o), { ...run, cwd: path.dirname(input) });
  if (!fs.existsSync(output)) throw new Error(`kicad-cli produced no image.\n${(r.stderr || r.stdout).trim()}`);
  return output;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.history']);

/** Lists files with the given extension under dir (bounded depth), used to track hierarchical sheets. */
export function listFilesByExt(dir: string, ext: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !SKIP_DIRS.has(e.name) && !e.name.endsWith('-backups')) walk(p, depth + 1);
      } else if (e.name.toLowerCase().endsWith(ext)) {
        out.push(p);
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

/**
 * Cache key over the input file content, the stat of related files, export options and CLI version.
 * Any change produces a new output directory.
 */
export function cacheKey(input: string, related: string[], options: unknown, cliVersion: string): string {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(input));
  for (const f of related) {
    try {
      const st = fs.statSync(f);
      h.update(`${f}\0${st.size}\0${st.mtimeMs}\n`);
    } catch {
      h.update(`${f}\0missing\n`);
    }
  }
  h.update(JSON.stringify(options));
  h.update(cliVersion);
  return h.digest('hex').slice(0, 16);
}
