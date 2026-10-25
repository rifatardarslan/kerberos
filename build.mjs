// Bundles src/ (JSX included) into a single ESM file. Dependencies stay external
// so they resolve from node_modules at runtime.
import fs from 'node:fs';
import { build } from 'esbuild';

const { version } = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

await build({
  entryPoints: ['src/index.js'],
  outfile: 'dist/kerberos.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  packages: 'external',
  jsx: 'automatic',
  loader: { '.js': 'jsx' },
  sourcemap: true,
  define: { __KERBEROS_VERSION__: JSON.stringify(version) },
  logLevel: 'info',
});
