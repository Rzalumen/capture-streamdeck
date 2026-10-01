// "Is this module the program Node was started with?" — safe when the path goes through a symlink.
//
// Why not `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`: Node resolves symlinks for the main
// module, so import.meta.url is the REAL path while argv[1] is the path as typed. On macOS the temp dir is
// /var/folders/... and /var is a symlink to /private/var, so the comparison was false, the script silently did
// nothing, and the mode-probe end-to-end test then failed with ENOENT on the report it never wrote.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}
