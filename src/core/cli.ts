import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** Resolved kicad-cli invocation. Flatpak installs need a wrapper command plus prefix args. */
export interface KicadCli {
  command: string;
  prefixArgs: string[];
  /** Human readable description of where the CLI was found. */
  source: string;
  version: string;
  major: number;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly stdout = '',
    readonly stderr = '',
    readonly cancelled = false,
  ) {
    super(message);
  }
}

export const SUPPORTED_MAJOR = 10;
const FLATPAK_APP_ID = 'org.kicad.KiCad';
const VERSION_TIMEOUT_MS = 20000;

/** Runs a process without a shell so paths with spaces or non-ASCII characters are passed verbatim. */
export function runProcess(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        signal: opts.signal,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (e.name === 'AbortError' || opts.signal?.aborted) {
          reject(new CliError('Export cancelled.', stdout, stderr, true));
        } else if (e.killed) {
          reject(new CliError(`Timed out after ${Math.round(opts.timeoutMs / 1000)} s.`, stdout, stderr));
        } else if (e.code === 'ENOENT') {
          reject(new CliError(`Executable not found: ${command}`, stdout, stderr));
        } else {
          const detail = (stderr || stdout).trim().split(/\r?\n/).slice(-5).join('\n');
          reject(new CliError(`kicad-cli exited with code ${e.code}.${detail ? '\n' + detail : ''}`, stdout, stderr));
        }
      },
    );
  });
}

export function runCli(cli: KicadCli, args: string[], opts: RunOptions): Promise<RunResult> {
  return runProcess(cli.command, [...cli.prefixArgs, ...args], opts);
}

interface Candidate {
  command: string;
  prefixArgs: string[];
  source: string;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function listDirs(p: string): string[] {
  try {
    return fs
      .readdirSync(p, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Sorts version-like folder names ("10.0", "9.0") highest first. */
function compareVersionDesc(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] ?? 0) - (pa[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function searchPath(exe: string, env: NodeJS.ProcessEnv): string[] {
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  return dirs.map((d) => path.join(d, exe)).filter(isFile);
}

/** Auto-detection candidates in priority order. Exported for tests. */
export function autoCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): Candidate[] {
  const out: Candidate[] = [];
  const add = (command: string, source: string) => {
    if (!out.some((c) => c.command.toLowerCase() === command.toLowerCase())) {
      out.push({ command, prefixArgs: [], source });
    }
  };

  if (platform === 'win32') {
    for (const p of searchPath('kicad-cli.exe', env)) add(p, 'PATH');
    const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
    for (const root of roots) {
      if (!root) continue;
      const base = path.join(root, 'KiCad');
      for (const ver of listDirs(base).sort(compareVersionDesc)) {
        const exe = path.join(base, ver, 'bin', 'kicad-cli.exe');
        if (isFile(exe)) add(exe, `install folder (${ver})`);
      }
    }
    return out;
  }

  for (const p of searchPath('kicad-cli', env)) add(p, 'PATH');
  for (const p of ['/usr/bin/kicad-cli', '/usr/local/bin/kicad-cli']) {
    if (isFile(p)) add(p, 'system');
  }
  if (platform === 'linux') {
    for (const flatpak of ['/usr/bin/flatpak', ...searchPath('flatpak', env)]) {
      if (isFile(flatpak)) {
        out.push({ command: flatpak, prefixArgs: ['run', `--command=kicad-cli`, FLATPAK_APP_ID], source: `Flatpak (${FLATPAK_APP_ID})` });
        break;
      }
    }
  }
  return out;
}

export function parseVersion(text: string): { version: string; major: number } | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return undefined;
  return { version: m[0], major: parseInt(m[1], 10) };
}

async function probe(c: Candidate): Promise<KicadCli> {
  const r = await runProcess(c.command, [...c.prefixArgs, 'version'], { timeoutMs: VERSION_TIMEOUT_MS });
  const v = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  if (!v) throw new CliError(`Unexpected 'version' output from ${c.command}: ${r.stdout.trim()}`);
  return { ...c, ...v };
}

/**
 * Resolves kicad-cli. A configured path is used exclusively (no silent fallback),
 * otherwise auto-detected candidates are probed in order.
 */
export async function resolveCli(configuredPath: string, log: (line: string) => void): Promise<KicadCli> {
  const configured = configuredPath.trim();
  if (configured) {
    try {
      const cli = await probe({ command: configured, prefixArgs: [], source: 'setting vskicad.cliPath' });
      log(`kicad-cli ${cli.version} from setting: ${configured}`);
      return cli;
    } catch (e) {
      throw new CliError(`Configured kicad-cli could not be run: ${configured}\n${(e as Error).message}`);
    }
  }

  const tried: string[] = [];
  for (const c of autoCandidates()) {
    const label = [c.command, ...c.prefixArgs].join(' ');
    try {
      const cli = await probe(c);
      log(`kicad-cli ${cli.version} found via ${c.source}: ${label}`);
      return cli;
    } catch (e) {
      tried.push(`${label}: ${(e as Error).message.split('\n')[0]}`);
      log(`kicad-cli candidate rejected (${c.source}): ${label}`);
    }
  }
  const detail = tried.length ? `\nTried:\n${tried.join('\n')}` : '';
  throw new CliError(`kicad-cli was not found. Install KiCad ${SUPPORTED_MAJOR}.x or set 'vskicad.cliPath'.${detail}`);
}
