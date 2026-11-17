import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../plugins', import.meta.url));

/**
 * Finds the plugin directories that ship inside this package.
 *
 * `plugin enable` loads these directories. A name is included only when that directory contains `package.json`. A missing plugins directory returns an empty map.
 *
 * @returns {Record<string, string>} Map of plugin name to absolute directory. The map has no prototype.
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
