import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  CliError,
  KicadCli,
  LayerImage,
  OutputStore,
  SheetPage,
  cacheKey,
  exportGlb,
  exportPcbLayers,
  exportSchematic,
  listFilesByExt,
  renderSnapshot,
} from './core';
import { HostMessage, PreviewKind, Target, WebviewMessage } from './protocol';

export interface Services {
  extensionUri: vscode.Uri;
  store: OutputStore;
  /** Folder for rendered snapshot images (outside per-panel outputs so tabs stay valid). */
  snapshotDir: string;
  log: vscode.OutputChannel;
  getCli(): Promise<KicadCli>;
}

const REFRESH_DEBOUNCE_MS = 600;

interface GlbMeta {
  file: string;
  missingModels: string[];
}

/** Drives one preview panel: runs exports, feeds the webview and cleans up outputs on close. */
export class PreviewController implements vscode.Disposable {
  private readonly session: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly aborts: Partial<Record<Target, AbortController>> = {};
  private want3d = false;
  private debounce: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    readonly kind: PreviewKind,
    readonly uri: vscode.Uri,
    readonly panel: vscode.WebviewPanel,
    private readonly svc: Services,
  ) {
    this.session = svc.store.newSession();
    const webview = panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(svc.extensionUri, 'dist'),
        vscode.Uri.joinPath(svc.extensionUri, 'media'),
        vscode.Uri.file(svc.store.root),
      ],
    };
    webview.html = buildHtml(webview, svc.extensionUri, kind);

    this.disposables.push(
      webview.onDidReceiveMessage((m: WebviewMessage) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('vskicad', this.uri)) this.scheduleRefresh(true);
      }),
    );
    this.watchFiles();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  get sessionId(): string {
    return this.session;
  }

  /** Re-exports the 2D view (and 3D if it was requested). force bypasses the cache. */
  refresh(force: boolean): void {
    void this.render2d(force);
    if (this.want3d) void this.render3d(force);
  }

  show3d(): void {
    if (this.kind !== 'pcb') return;
    this.post({ type: 'show3d' });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.debounce);
    for (const a of Object.values(this.aborts)) a?.abort();
    for (const d of this.disposables) d.dispose();
    try {
      this.svc.store.removeSession(this.session);
    } catch (e) {
      this.svc.log.appendLine(`Failed to remove preview outputs: ${(e as Error).message}`);
    }
  }

  private onMessage(m: WebviewMessage): void {
    switch (m.type) {
      case 'ready':
        this.post({ type: 'init', kind: this.kind, fileName: path.basename(this.uri.fsPath) });
        void this.render2d(false);
        break;
      case 'request3d':
        this.want3d = true;
        void this.render3d(false);
        break;
      case 'refresh':
        this.refresh(true);
        break;
      case 'openSettings':
        void vscode.commands.executeCommand('workbench.action.openSettings', m.query);
        break;
      case 'showLog':
        this.svc.log.show(true);
        break;
      case 'snapshot':
        void this.snapshot(m).finally(() => this.post({ type: 'snapshotDone' }));
        break;
    }
  }

  /** Renders the current 3D camera with KiCad's raytracer and opens the image. */
  private async snapshot(m: Extract<WebviewMessage, { type: 'snapshot' }>): Promise<void> {
    if (this.kind !== 'pcb') return;
    const t0 = Date.now();
    let input: string;
    let cli: KicadCli;
    try {
      input = this.inputPath();
      cli = await this.svc.getCli();
    } catch (e) {
      void vscode.window.showErrorMessage(`KiCad snapshot failed: ${(e as Error).message.split('\n')[0]}`);
      return;
    }
    const stem = path.basename(input, path.extname(input));
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const output = path.join(this.svc.snapshotDir, `${stem}-3d-${stamp}.png`);
    const ac = new AbortController();
    this.disposables.push({ dispose: () => ac.abort() });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Rendering ${stem} with KiCad…`, cancellable: true },
        (_progress, token) => {
          token.onCancellationRequested(() => ac.abort());
          return renderSnapshot(cli, input, output, m, this.runOptions(ac));
        },
      );
    } catch (e) {
      if (e instanceof CliError && e.cancelled) return;
      this.fail('3d', e, false);
      void vscode.window.showErrorMessage(`KiCad snapshot failed: ${(e as Error).message.split('\n')[0]}`, 'Show Log').then((c) => {
        if (c === 'Show Log') this.svc.log.show(true);
      });
      return;
    }
    this.svc.log.appendLine(`Snapshot ${stem}: rotate ${m.rotate.join(',')} zoom ${m.zoom} in ${Date.now() - t0} ms -> ${output}`);
    const uri = vscode.Uri.file(output);
    await vscode.commands.executeCommand('vscode.open', uri, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    const choice = await vscode.window.showInformationMessage(`KiCad snapshot rendered: ${path.basename(output)}`, 'Save As…');
    if (choice !== 'Save As…') return;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(path.dirname(input), `${stem}-3d.png`)),
      filters: { 'PNG image': ['png'] },
    });
    if (target) {
      await vscode.workspace.fs.copy(uri, target, { overwrite: true });
      this.svc.log.appendLine(`Snapshot saved to ${target.fsPath}`);
    }
  }

  private watchFiles(): void {
    if (this.uri.scheme !== 'file') return;
    const dir = vscode.Uri.file(path.dirname(this.uri.fsPath));
    // Schematics may span several sheet files; a PCB preview depends on the board file only.
    const glob = this.kind === 'sch' ? '**/*.kicad_sch' : path.basename(this.uri.fsPath);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, glob));
    const onChange = () => this.scheduleRefresh(false);
    watcher.onDidChange(onChange, null, this.disposables);
    watcher.onDidCreate(onChange, null, this.disposables);
    watcher.onDidDelete(onChange, null, this.disposables);
    this.disposables.push(watcher);
  }

  /** Settings changes always refresh; file changes only when auto refresh is enabled. */
  private scheduleRefresh(settingsChanged: boolean): void {
    if (!settingsChanged && !vscode.workspace.getConfiguration('vskicad', this.uri).get<boolean>('autoRefresh', true)) return;
    clearTimeout(this.debounce);
    // Cache keys include file content and options, so unchanged inputs are not re-exported.
    this.debounce = setTimeout(() => this.refresh(false), REFRESH_DEBOUNCE_MS);
  }

  private post(msg: HostMessage): void {
    if (!this.disposed) void this.panel.webview.postMessage(msg);
  }

  private toWebviewUri(file: string): string {
    return this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
  }

  private begin(target: Target): AbortController {
    this.aborts[target]?.abort();
    const ac = new AbortController();
    this.aborts[target] = ac;
    return ac;
  }

  private runOptions(ac: AbortController) {
    const cfg = vscode.workspace.getConfiguration('vskicad', this.uri);
    return { timeoutMs: Math.max(10, cfg.get<number>('timeoutSeconds', 180)) * 1000, signal: ac.signal };
  }

  private inputPath(): string {
    if (this.uri.scheme !== 'file') {
      throw new Error(`Only files on disk can be previewed (scheme '${this.uri.scheme}').`);
    }
    const p = this.uri.fsPath;
    if (!fs.existsSync(p)) throw new Error(`File not found: ${p}`);
    return p;
  }

  private async render2d(force: boolean): Promise<void> {
    const ac = this.begin('2d');
    const t0 = Date.now();
    this.post({ type: 'busy', target: '2d', message: 'Exporting with kicad-cli…' });
    try {
      const input = this.inputPath();
      const cli = await this.svc.getCli();
      const cfg = vscode.workspace.getConfiguration('vskicad', this.uri);
      const run = this.runOptions(ac);
      const store = this.svc.store;

      if (this.kind === 'sch') {
        const options = { theme: cfg.get<string>('schematic.theme', '') };
        const related = listFilesByExt(path.dirname(input), '.kicad_sch');
        const { dir, cached } = store.entry(this.session, 'sch', cacheKey(input, related, options, cli.version));
        let pages = cached && !force ? store.readMeta<SheetPage[]>(dir) : undefined;
        const fromCache = !!pages;
        if (!pages) {
          store.reset(dir);
          pages = await exportSchematic(cli, input, dir, options.theme, run);
          store.markDone(dir, pages);
        }
        if (ac.signal.aborted) return;
        store.pruneKind(this.session, 'sch', dir);
        this.post({ type: 'schematic', fromCache, pages: pages.map((p) => ({ name: p.name, uri: this.toWebviewUri(p.file) })) });
        this.svc.log.appendLine(`Schematic ${path.basename(input)}: ${pages.length} sheet(s) in ${Date.now() - t0} ms${fromCache ? ' (cached)' : ''}`);
      } else {
        const options = {
          layers: cfg.get<string[]>('pcb.layers', []),
          theme: cfg.get<string>('pcb.theme', ''),
          drillShape: cfg.get<'none' | 'small' | 'actual'>('pcb.drillShape', 'actual'),
        };
        const { dir, cached } = store.entry(this.session, 'pcb2d', cacheKey(input, [], options, cli.version));
        let layers = cached && !force ? store.readMeta<LayerImage[]>(dir) : undefined;
        const fromCache = !!layers;
        if (!layers) {
          store.reset(dir);
          layers = await exportPcbLayers(cli, input, dir, options, run);
          store.markDone(dir, layers);
        }
        if (ac.signal.aborted) return;
        store.pruneKind(this.session, 'pcb2d', dir);
        this.post({
          type: 'pcb2d',
          fromCache,
          layers: layers.map((l) => ({ name: l.name, label: l.userName ?? l.name, uri: this.toWebviewUri(l.file) })),
        });
        this.svc.log.appendLine(`PCB 2D ${path.basename(input)}: ${layers.length} layer(s) in ${Date.now() - t0} ms${fromCache ? ' (cached)' : ''}`);
      }
    } catch (e) {
      this.fail('2d', e);
    }
  }

  private async render3d(force: boolean): Promise<void> {
    if (this.kind !== 'pcb') return;
    const ac = this.begin('3d');
    const t0 = Date.now();
    this.post({ type: 'busy', target: '3d', message: 'Exporting 3D model with kicad-cli…' });
    try {
      const input = this.inputPath();
      const cli = await this.svc.getCli();
      const cfg = vscode.workspace.getConfiguration('vskicad', this.uri);
      const options = {
        substituteModels: cfg.get<boolean>('3d.substituteModels', true),
        includeTracks: cfg.get<boolean>('3d.includeTracks', false),
        includePads: cfg.get<boolean>('3d.includePads', false),
        includeZones: cfg.get<boolean>('3d.includeZones', false),
        includeSilkscreen: cfg.get<boolean>('3d.includeSilkscreen', false),
        includeSoldermask: cfg.get<boolean>('3d.includeSoldermask', false),
      };
      const store = this.svc.store;
      const { dir, cached } = store.entry(this.session, 'glb', cacheKey(input, [], options, cli.version));
      let meta = cached && !force ? store.readMeta<GlbMeta>(dir) : undefined;
      const fromCache = !!meta;
      if (!meta) {
        store.reset(dir);
        meta = await exportGlb(cli, input, dir, options, this.runOptions(ac));
        store.markDone(dir, meta);
      }
      if (ac.signal.aborted) return;
      store.pruneKind(this.session, 'glb', dir);
      // Cache-busting query: a forced refresh rewrites the same path.
      const uri = `${this.toWebviewUri(meta.file)}?v=${Date.now()}`;
      this.post({ type: 'glb', uri, missingModels: meta.missingModels, fromCache });
      this.svc.log.appendLine(`PCB 3D ${path.basename(input)}: ${Date.now() - t0} ms${fromCache ? ' (cached)' : ''}`);
      if (meta.missingModels.length > 0) {
        this.svc.log.appendLine(`  3D models not found for: ${meta.missingModels.join(', ')}`);
      }
    } catch (e) {
      this.fail('3d', e);
    }
  }

  private fail(target: Target, e: unknown, showInView = true): void {
    if (e instanceof CliError && e.cancelled) return;
    const err = e as Error;
    this.svc.log.appendLine(`[${target}] ${path.basename(this.uri.fsPath)}: ${err.message}`);
    if (e instanceof CliError && e.stderr.trim()) this.svc.log.appendLine(e.stderr.trim());
    if (showInView) this.post({ type: 'error', target, message: err.message });
  }
}

function buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri, kind: PreviewKind): string {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const style = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'preview.css'));
  const src = webview.cspSource;
  // Inline style attributes are required by KiCad's SVG output; scripts are nonce-restricted.
  const csp = [
    `default-src 'none'`,
    `img-src ${src} data: blob:`,
    `style-src ${src} 'unsafe-inline'`,
    `font-src ${src}`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${src} data: blob:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>KiCad Preview</title>
</head>
<body data-kind="${kind}">
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

/** Custom read-only editor for one file kind. */
export class PreviewProvider implements vscode.CustomReadonlyEditorProvider {
  constructor(
    private readonly kind: PreviewKind,
    private readonly svc: Services,
    private readonly registry: ControllerRegistry,
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel): void {
    const c = new PreviewController(this.kind, document.uri, panel, this.svc);
    this.registry.add(c);
  }
}

/** Tracks open controllers and which one is active, for commands. */
export class ControllerRegistry {
  private readonly all = new Set<PreviewController>();
  private current: PreviewController | undefined;

  add(c: PreviewController): void {
    this.all.add(c);
    if (c.panel.active) this.current = c;
    c.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) this.current = c;
    });
    c.panel.onDidDispose(() => {
      this.all.delete(c);
      if (this.current === c) this.current = undefined;
    });
  }

  get active(): PreviewController | undefined {
    return this.current;
  }

  sessions(): Set<string> {
    return new Set([...this.all].map((c) => c.sessionId));
  }
}
