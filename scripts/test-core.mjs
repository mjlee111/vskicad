// Integration tests for the VS Code-free core against an installed kicad-cli and KiCad demo projects.
// Usage: npm run test:core            (uses KiCad demos from the default install location)
//        KICAD_DEMOS=<dir> npm run test:core
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../dist/core.test.js');

const DEMOS =
  process.env.KICAD_DEMOS ??
  (process.platform === 'win32'
    ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'KiCad', '10.0', 'share', 'kicad', 'demos')
    : '/usr/share/kicad/demos');

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`PASS ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name}\n     ${e.stack?.split('\n').slice(0, 3).join('\n     ')}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vskicad-test-'));
// Path with spaces and non-ASCII characters, as seen on real Windows/Ubuntu user folders.
const work = path.join(tmp, '한글 프로젝트 dir');
fs.mkdirSync(work, { recursive: true });
for (const f of fs.readdirSync(path.join(DEMOS, 'complex_hierarchy'))) {
  fs.cpSync(path.join(DEMOS, 'complex_hierarchy', f), path.join(work, f), { recursive: true });
}
const SCH = path.join(work, 'complex_hierarchy.kicad_sch');
const PCB = path.join(work, 'complex_hierarchy.kicad_pcb');
const run = { timeoutMs: 180_000 };
const logs = [];
let cli;

await test('resolveCli auto-detects kicad-cli 10.x', async () => {
  cli = await core.resolveCli('', (l) => logs.push(l));
  assert.equal(cli.major, 10, `got ${cli.version}`);
});

await test('resolveCli with bad configured path fails without fallback', async () => {
  await assert.rejects(core.resolveCli(path.join(tmp, 'no-such-kicad-cli'), () => {}), /Configured kicad-cli could not be run/);
});

await test('autoCandidates for win32 finds Program Files layout', () => {
  const pf = path.join(tmp, 'Program Files');
  for (const v of ['9.0', '10.0']) {
    fs.mkdirSync(path.join(pf, 'KiCad', v, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(pf, 'KiCad', v, 'bin', 'kicad-cli.exe'), '');
  }
  const c = core.autoCandidates('win32', { ProgramFiles: pf, PATH: '' });
  assert.equal(c.length, 2);
  assert.ok(c[0].command.includes(path.join('KiCad', '10.0')), 'highest version first');
});

await test('autoCandidates for linux includes Flatpak wrapper when flatpak exists', () => {
  const c = core.autoCandidates('linux', { PATH: '' });
  if (fs.existsSync('/usr/bin/flatpak')) {
    assert.ok(c.some((x) => x.prefixArgs.includes('org.kicad.KiCad')));
  }
  if (fs.existsSync('/usr/bin/kicad-cli')) assert.ok(c.some((x) => x.command === '/usr/bin/kicad-cli'));
});

await test('exportSchematic: hierarchical sheets from a non-ASCII path', async () => {
  const out = path.join(tmp, 'sch');
  const pages = await core.exportSchematic(cli, SCH, out, '', run);
  assert.equal(pages.length, 3);
  assert.equal(pages[0].name, 'complex_hierarchy', 'root sheet first');
  for (const p of pages) assert.ok(fs.statSync(p.file).size > 1000);
});

await test('parseBoardLayers + selectLayers default set', () => {
  const layers = core.parseBoardLayers(fs.readFileSync(PCB, 'utf8'));
  assert.ok(layers.some((l) => l.name === 'F.Cu' && l.userName === 'top_copper'));
  const sel = core.selectLayers(layers, []).map((l) => l.name);
  assert.deepEqual(sel, ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'F.Mask', 'B.Mask', 'F.Fab', 'B.Fab', 'Edge.Cuts']);
  assert.deepEqual(core.selectLayers(layers, ['In1.Cu', 'B.Cu']).map((l) => l.name), ['B.Cu'], 'undefined layers are skipped');
});

await test('parseBoardLayers accepts legacy unquoted names and user names with spaces', () => {
  const legacy = core.parseBoardLayers('(kicad_pcb (layers (0 F.Cu signal) (31 B.Cu signal) (44 Edge.Cuts user)) (setup))');
  assert.deepEqual(legacy.map((l) => l.name), ['F.Cu', 'B.Cu', 'Edge.Cuts']);
  const named = core.parseBoardLayers('(kicad_pcb (layers (0 "F.Cu" signal "top copper") (2 "B.Cu" signal)) (setup))');
  assert.equal(named[0].userName, 'top copper');
  const m = core.matchLayerFiles(named, ['/o/b-top_copper.svg', '/o/b-B_Cu.svg'], 'b');
  assert.deepEqual(m.map((x) => [x.name, x.file]), [['F.Cu', '/o/b-top_copper.svg'], ['B.Cu', '/o/b-B_Cu.svg']]);
});

await test('exportSchematic: sub-sheet file opened on its own', async () => {
  const pages = await core.exportSchematic(cli, path.join(work, 'ampli_ht.kicad_sch'), path.join(tmp, 'sub'), '', run);
  assert.equal(pages.length, 1);
});

await test('exportPcbLayers maps every file to the right layer', async () => {
  const out = path.join(tmp, 'pcb');
  const imgs = await core.exportPcbLayers(cli, PCB, out, { layers: [], theme: '', drillShape: 'actual' }, run);
  assert.equal(imgs.length, 9);
  const fcu = imgs.find((i) => i.name === 'F.Cu');
  assert.match(path.basename(fcu.file), /top_copper/);
  const silk = imgs.find((i) => i.name === 'B.SilkS');
  assert.match(path.basename(silk.file), /B_Silkscreen/);
  const boxes = new Set(imgs.map((i) => /viewBox="([^"]+)"/.exec(fs.readFileSync(i.file, 'utf8'))[1]));
  assert.equal(boxes.size, 1, 'all layers share one viewBox so they can be stacked');
});

await test('exportGlb default options + missing model report', async () => {
  const out = path.join(tmp, 'glb');
  const r = await core.exportGlb(cli, PCB, out, { substituteModels: true }, run);
  const buf = fs.readFileSync(r.file);
  assert.equal(buf.toString('ascii', 0, 4), 'glTF');
  // The demo references ${KICAD6_3DMODEL_DIR} which is not configured on a fresh install.
  console.log(`     missing models reported: ${r.missingModels.length}`);
});

await test('snapshotArgs builds a raytraced render command with clamped values', () => {
  const a = core.snapshotArgs('/b.kicad_pcb', '/o.png', { rotate: [-45.126, 0, 30], zoom: 200, width: 99999, height: 10 });
  assert.deepEqual(a.slice(0, 4), ['pcb', 'render', '-o', '/o.png']);
  assert.equal(a[a.indexOf('--width') + 1], '7680');
  assert.equal(a[a.indexOf('--height') + 1], '64');
  assert.equal(a[a.indexOf('--rotate') + 1], '-45.13,0,30');
  assert.equal(a[a.indexOf('--zoom') + 1], '50');
  assert.ok(a.includes('--perspective') && a.includes('--floor'));
  assert.equal(a[a.length - 1], '/b.kicad_pcb');
});

await test('renderSnapshot writes a PNG for a rotated view (negative angles)', async () => {
  const out = path.join(tmp, 'snap', 'board-3d.png');
  await core.renderSnapshot(cli, PCB, out, { rotate: [-50, 0, 30], zoom: 1.2, width: 320, height: 200 }, run);
  const buf = fs.readFileSync(out);
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  // kicad-cli 10.0.5 returns a slightly smaller image than requested (320x200 -> 312x168).
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  assert.ok(w > 200 && w <= 320 && h > 100 && h <= 200, `got ${w}x${h}`);
});

await test('runCli honours abort signal', async () => {
  const ac = new AbortController();
  const p = core.exportGlb(cli, PCB, path.join(tmp, 'glb-abort'), { substituteModels: true, includeZones: true, includeTracks: true }, { timeoutMs: 60_000, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e) => e.cancelled === true);
});

await test('kicad-cli error surfaces as CliError with message', async () => {
  const bad = path.join(work, 'broken.kicad_pcb');
  fs.writeFileSync(bad, '(kicad_pcb (version 1) garbage');
  await assert.rejects(core.exportGlb(cli, bad, path.join(tmp, 'bad'), {}, run), (e) => e instanceof Error && e.message.length > 0);
});

await test('cacheKey changes with content and options only', () => {
  const k1 = core.cacheKey(PCB, [], { a: 1 }, '10.0.5');
  assert.equal(k1, core.cacheKey(PCB, [], { a: 1 }, '10.0.5'));
  assert.notEqual(k1, core.cacheKey(PCB, [], { a: 2 }, '10.0.5'));
  fs.appendFileSync(PCB, '\n');
  assert.notEqual(k1, core.cacheKey(PCB, [], { a: 1 }, '10.0.5'));
});

await test('OutputStore prunes old outputs and removes session', () => {
  const store = new core.OutputStore(path.join(tmp, 'store'));
  const s = store.newSession();
  const a = store.entry(s, 'glb', 'aaa');
  store.reset(a.dir);
  store.markDone(a.dir, { x: 1 });
  assert.equal(store.entry(s, 'glb', 'aaa').cached, true);
  const b = store.entry(s, 'glb', 'bbb');
  store.reset(b.dir);
  store.pruneKind(s, 'glb', b.dir);
  assert.equal(fs.existsSync(a.dir), false);
  assert.equal(fs.existsSync(b.dir), true);
  store.removeSession(s);
  assert.equal(fs.readdirSync(store.root).length, 0);
});

await test('OutputStore.purgeStale removes only old inactive sessions', () => {
  const store = new core.OutputStore(path.join(tmp, 'store2'));
  const old = store.newSession();
  const active = store.newSession();
  const past = new Date(Date.now() - 2 * 86400_000);
  fs.utimesSync(path.join(store.root, old), past, past);
  fs.utimesSync(path.join(store.root, active), past, past);
  assert.equal(store.purgeStale(86400_000, new Set([active])), 1);
  assert.deepEqual(fs.readdirSync(store.root), [active]);
});

fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
