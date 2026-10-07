import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const configs = [
  // Extension host bundle (Node, CommonJS). 'vscode' is provided at runtime.
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['vscode'],
  },
  // VS Code-free core, bundled separately so it can be tested with plain Node.
  {
    ...common,
    entryPoints: ['src/core/index.ts'],
    outfile: 'dist/core.test.js',
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: false,
  },
  // Webview bundle (browser). three.js is bundled so the preview works offline.
  {
    ...common,
    entryPoints: ['webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

if (watch) {
  for (const c of configs) {
    const ctx = await esbuild.context(c);
    await ctx.watch();
  }
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
