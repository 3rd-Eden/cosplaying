import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../plugins', import.meta.url));

/**
 * Directories of shipped plugins that are present in this package.
 * @returns {Record<string, string>}
 */
export function bundledPlugins() {
  /** @type {Record<string, string>} */
  const bundled = Object.create(null);
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return bundled;
  }
  for (const name of names) {
    const directory = path.join(root, name);
    if (existsSync(path.join(directory, 'package.json'))) bundled[name] = directory;
  }
  return bundled;
}
