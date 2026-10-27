// An advisory lock that keeps two kcmd processes from writing one workspace
// at the same time.
//

import * as fs from 'node:fs';
import * as path from 'node:path';

export const LOCK_FILE = '.kcmd.lock';

// A lock file with no readable process id that is older than this belongs to
// a process that died while taking it. A younger one may be a process that
// has created the file and not yet written its id.
const UNREADABLE_LOCK_GRACE_MS = 5000;


// Runs `fn` while holding the workspace lock: `<basePath>/.kcmd.lock`, created
// exclusively and holding the process id. A lock held by a live process fails
// the call as a whole; one whose process is gone is removed and taken. The
// lock is released when `fn` settles, whether it succeeds or throws.
export async function withWorkspaceLock<T>(
    basePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(basePath, LOCK_FILE);
  acquire(lockPath);
  try {
    return await fn();
  } finally {
    release(lockPath);
  }
}


function acquire(lockPath: string): void {
  for (let attempt = 0;; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return;
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
    }

    const holder = holderOf(lockPath);
    if (attempt > 0 || !isStale(lockPath, holder)) {
      const who = holder === undefined ? 'another kcmd process' :
                                         `kcmd process ${holder}`;
      throw new Error(
          `the workspace is busy: ${who} is writing it (lock file ` +
          `'${lockPath}'). Run the command again when it has finished.`);
    }
    fs.rmSync(lockPath, {force: true});
  }
}


function release(lockPath: string): void {
  // Remove only a lock this process holds.
  if (holderOf(lockPath) === process.pid) fs.rmSync(lockPath, {force: true});
}


function holderOf(lockPath: string): number|undefined {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}


function isStale(lockPath: string, holder: number|undefined): boolean {
  if (holder !== undefined) return !isAlive(holder);
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
  } catch {
    return true;  // removed meanwhile: retry once
  }
}


function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM: the process exists but belongs to another user.
    return err?.code === 'EPERM';
  }
}
