import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));

/** Shipped plugins. They stay off until a config plugins entry names them. */
const SHIPPED = ['git', 'gh'];

/**
 * Directories of shipped plugins that are present in this package.
 * @returns {Record<string, string>}
 */
export function bundledPlugins() {
  /** @type {Record<string, string>} */
  const bundled = {};
  for (const name of SHIPPED) {
    const directory = path.join(root, 'plugins', name);
    if (existsSync(path.join(directory, 'package.json'))) bundled[name] = directory;
  }
  return bundled;
}
