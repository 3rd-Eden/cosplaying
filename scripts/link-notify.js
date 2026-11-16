// examples/notify has its own package.json. This link lets that package
// resolve `cosplaying/plugin` to this repo during development.
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = path.join(root, 'examples', 'notify', 'package.json');
if (!existsSync(example)) process.exit(0);

const directory = path.join(root, 'examples', 'notify', 'node_modules');
const link = path.join(directory, 'cosplaying');
const target = path.relative(directory, root);

mkdirSync(directory, { recursive: true });

let current;
try {
  current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
} catch {
  current = null;
}
if (current === target) process.exit(0);
if (current !== null || existsSync(link)) rmSync(link, { recursive: true, force: true });
symlinkSync(target, link, 'dir');
