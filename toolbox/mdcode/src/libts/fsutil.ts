// File helpers shared by the local catalog layouts.
//

import {randomUUID} from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';


// Writes `text` to `filePath` through a temporary file in the same folder and
// a rename. A reader never sees a half-written file, and a write that fails
// leaves the previous file as it was.
export async function writeFileAtomic(
    filePath: string, text: string): Promise<void> {
  const temp = path.join(
      path.dirname(filePath),
      `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temp, text, 'utf8');
    await fs.promises.rename(temp, filePath);
  } catch (err) {
    await fs.promises.rm(temp, {force: true});
    throw err;
  }
}


// The absolute path of `relative` inside `root`. Throws, naming `what`, when
// the path would leave `root`: an absolute path, a `..` that climbs out, or a
// path that resolves to `root` itself. Entry names reach the layouts from
// callers such as `kcmd entry save`, so a name must never write elsewhere.
export function pathInside(root: string, relative: string, what: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(base, relative);
  const rel = path.relative(base, resolved);
  if (!relative || path.isAbsolute(relative) || rel === '' ||
      rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`${what} '${relative}' points outside the catalog folder`);
  }
  return resolved;
}


// Reads a file's text, or undefined when there is no such file.
export async function readFileIfExists(filePath: string):
    Promise<string|undefined> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}
