#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.join(here, '..', 'dist', 'kerberos.js');

if (!existsSync(bundle)) {
  console.error('[kerberos] dist/kerberos.js bulunamadı. Önce derleyin: npm run build');
  process.exit(1);
}

const { main } = await import(pathToFileURL(bundle).href);
await main(process.argv.slice(2));
