// Message contract between the extension host and the preview webview.

export type PreviewKind = 'sch' | 'pcb';
export type Target = '2d' | '3d';

export interface PageInfo {
  name: string;
  uri: string;
}

export interface LayerInfo {
  /** Canonical layer name, e.g. "F.Cu". */
  name: string;
  /** Display label (user name if defined). */
  label: string;
  uri: string;
}

export type HostMessage =
  | { type: 'init'; kind: PreviewKind; fileName: string }
  | { type: 'busy'; target: Target; message: string }
  | { type: 'schematic'; pages: PageInfo[]; fromCache: boolean }
  | { type: 'pcb2d'; layers: LayerInfo[]; fromCache: boolean }
  | { type: 'glb'; uri: string; missingModels: string[]; fromCache: boolean }
  | { type: 'error'; target: Target; message: string }
  | { type: 'show3d' }
  | { type: 'snapshotDone' };

export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'request3d' }
  | { type: 'refresh' }
  | { type: 'openSettings'; query: string }
  | { type: 'showLog' }
  /** High-quality KiCad render of the current 3D camera (kicad-cli pcb render). */
  | { type: 'snapshot'; rotate: [number, number, number]; zoom: number; width: number; height: number };
