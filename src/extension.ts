import * as path from 'path';
import * as vscode from 'vscode';
import { KicadCli, OutputStore, SUPPORTED_MAJOR, purgeOldFiles, resolveCli } from './core';
import { ControllerRegistry, PreviewProvider, Services } from './preview';

const VIEW_TYPES = { sch: 'vskicad.schematic', pcb: 'vskicad.pcb' } as const;
const STALE_OUTPUT_MS = 24 * 60 * 60 * 1000;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('KiCad Preview');
  const store = new OutputStore(path.join(context.globalStorageUri.fsPath, 'previews'));
  const registry = new ControllerRegistry();
  const snapshotDir = path.join(context.globalStorageUri.fsPath, 'snapshots');

  try {
    const removed = store.purgeStale(STALE_OUTPUT_MS, registry.sessions()) + purgeOldFiles(snapshotDir, STALE_OUTPUT_MS);
    if (removed > 0) log.appendLine(`Removed ${removed} stale preview output(s).`);
  } catch (e) {
    log.appendLine(`Stale output cleanup failed: ${(e as Error).message}`);
  }

  let cliPromise: Promise<KicadCli> | undefined;
  let versionWarned = false;
  let missingNotified = false;

  const getCli = (): Promise<KicadCli> => {
    if (!cliPromise) {
      const configured = vscode.workspace.getConfiguration('vskicad').get<string>('cliPath', '');
      cliPromise = resolveCli(configured, (l) => log.appendLine(l)).then(
        (cli) => {
          if (cli.major !== SUPPORTED_MAJOR && !versionWarned) {
            versionWarned = true;
            void vscode.window.showWarningMessage(
              `KiCad Preview is verified with KiCad ${SUPPORTED_MAJOR}.x only. Found kicad-cli ${cli.version}; previews may fail.`,
            );
          }
          return cli;
        },
        (err: Error) => {
          // Do not cache failures so a later install or setting change is picked up.
          cliPromise = undefined;
          log.appendLine(err.message);
          if (!missingNotified) {
            missingNotified = true;
            void vscode.window.showErrorMessage(err.message.split('\n')[0], 'Open Settings', 'Show Log').then((choice) => {
              if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'vskicad.cliPath');
              if (choice === 'Show Log') log.show(true);
            });
          }
          throw err;
        },
      );
    }
    return cliPromise;
  };

  context.subscriptions.push(
    log,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vskicad.cliPath')) {
        cliPromise = undefined;
        missingNotified = false;
        versionWarned = false;
      }
    }),
  );

  const svc: Services = { extensionUri: context.extensionUri, store, snapshotDir, log, getCli };
  const editorOptions = { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true };
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPES.sch, new PreviewProvider('sch', svc, registry), editorOptions),
    vscode.window.registerCustomEditorProvider(VIEW_TYPES.pcb, new PreviewProvider('pcb', svc, registry), editorOptions),
  );

  const targetUri = (arg?: vscode.Uri): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    return vscode.window.activeTextEditor?.document.uri ?? registry.active?.uri;
  };
  const openWith = async (arg: vscode.Uri | undefined, column: vscode.ViewColumn) => {
    const uri = targetUri(arg);
    const ext = uri ? path.extname(uri.fsPath).toLowerCase() : '';
    if (!uri || (ext !== '.kicad_sch' && ext !== '.kicad_pcb')) {
      void vscode.window.showInformationMessage('Select a .kicad_sch or .kicad_pcb file to preview.');
      return;
    }
    const viewType = ext === '.kicad_sch' ? VIEW_TYPES.sch : VIEW_TYPES.pcb;
    await vscode.commands.executeCommand('vscode.openWith', uri, viewType, column);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('vskicad.openPreview', (uri?: vscode.Uri) => openWith(uri, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('vskicad.openPreviewToSide', (uri?: vscode.Uri) => openWith(uri, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('vskicad.refresh', () => registry.active?.refresh(true)),
    vscode.commands.registerCommand('vskicad.show3D', () => registry.active?.show3d()),
    vscode.commands.registerCommand('vskicad.showCliInfo', async () => {
      try {
        const cli = await getCli();
        const cmd = [cli.command, ...cli.prefixArgs].join(' ');
        void vscode.window.showInformationMessage(`kicad-cli ${cli.version} (${cli.source}): ${cmd}`);
      } catch {
        // Error already reported by getCli.
      }
    }),
  );
}

export function deactivate(): void {
  // Panels dispose their own outputs via PreviewController.dispose.
}
