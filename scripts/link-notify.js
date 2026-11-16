// Local plugin packages import `cosplaying/...`. This link resolves that name
// to this repo during development. A published install resolves it from
// node_modules/cosplaying itself.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const directories = [
  path.join(root, 'examples', 'notify'),
  path.join(root, 'plugins', 'git'),
  path.join(root, 'plugins', 'gh'),
];

for (const packageDir of directories) {
  const example = path.join(packageDir, 'package.json');
  if (!existsSync(example)) continue;
  const directory = path.join(packageDir, 'node_modules');
  const link = path.join(directory, 'cosplaying');
  const target = path.relative(directory, root);
  mkdirSync(directory, { recursive: true });
  let current;
  try {
    current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch {
    current = null;
  }
  if (current === target) continue;
  if (current !== null || existsSync(link)) rmSync(link, { recursive: true, force: true });
  symlinkSync(target, link, 'dir');
}
