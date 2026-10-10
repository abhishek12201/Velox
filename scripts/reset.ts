import { lstat, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceData = resolve(workspace, 'data');
const targets = new Set([
  workspaceData,
  ...(process.env.VELOX_DATA_DIR ? [resolve(process.env.VELOX_DATA_DIR)] : []),
]);

for (const target of targets) {
  if (
    target === dirname(target) ||
    target === workspace ||
    target === resolve(homedir()) ||
    (target.startsWith(`${workspace}${sep}`) && target !== workspaceData && !target.startsWith(`${workspaceData}${sep}`)) ||
    workspace.startsWith(`${target}${sep}`)
  ) throw new Error(`Refusing unsafe data directory: ${target}`);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic-link data directory: ${target}`);
  if (!info.isDirectory()) throw new Error(`Configured data path is not a directory: ${target}`);
  const entries = await readdir(target);
  await Promise.all(entries.map((entry) => rm(join(target, entry), { recursive: true, force: true })));
  console.log(`Cleared ${target}`);
}
