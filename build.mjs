// Bundles src/ (JSX included) into a single ESM file. Dependencies stay external
// so they resolve from node_modules at runtime.
import { build } from 'esbuild';

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
  logLevel: 'info',
});
