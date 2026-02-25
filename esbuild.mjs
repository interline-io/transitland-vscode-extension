import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const baseOptions = {
  bundle: true,
  sourcemap: true,
  minify: false,
  platform: 'node',
  target: 'node22',
  logLevel: 'info',
};

// VS Code extension bundle — vscode is provided by the host, not bundled
const extensionBuild = esbuild.build({
  ...baseOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'out/extension.js',
  external: ['vscode'],
  format: 'cjs',
});

// Standalone MCP server — no vscode dependency
const mcpBuild = esbuild.build({
  ...baseOptions,
  entryPoints: ['src/mcp-server.ts'],
  outfile: 'out/mcp-server.js',
  format: 'cjs',
  banner: { js: '#!/usr/bin/env node' },
});

if (watch) {
  // In watch mode, rebuild on changes
  const [extCtx, mcpCtx] = await Promise.all([
    esbuild.context({ ...baseOptions, entryPoints: ['src/extension.ts'], outfile: 'out/extension.js', external: ['vscode'], format: 'cjs' }),
    esbuild.context({ ...baseOptions, entryPoints: ['src/mcp-server.ts'], outfile: 'out/mcp-server.js', format: 'cjs', banner: { js: '#!/usr/bin/env node' } }),
  ]);
  await Promise.all([extCtx.watch(), mcpCtx.watch()]);
  console.log('Watching for changes...');
} else {
  await Promise.all([extensionBuild, mcpBuild]);
}
