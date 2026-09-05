/**
 * Where uploaded files live.
 *
 * By default they sit in public/uploads, which is fine locally but is inside
 * the deployed directory — a host that rebuilds that directory on every deploy
 * (Hostinger, most PaaS) would erase them. Set UPLOAD_DIR to a path outside
 * the deploy root to keep uploads across releases, e.g.
 *
 *   UPLOAD_DIR=/home/<account>/persistent/uploads
 *
 * A misconfigured path must never stop the site from booting, so an
 * uncreatable UPLOAD_DIR falls back to the in-tree directory with a warning.
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DIR = path.resolve('public/uploads');

function resolveUploadDir() {
  const configured = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : null;
  for (const dir of [configured, DEFAULT_DIR]) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return { dir, fellBack: dir !== configured && configured !== null };
    } catch (err) {
      console.warn(`[uploads] cannot use ${dir}: ${err.message}`);
    }
  }
  return { dir: DEFAULT_DIR, fellBack: true };
}

const resolved = resolveUploadDir();

export const UPLOAD_DIR = resolved.dir;
export const uploadsAreEphemeral = !process.env.UPLOAD_DIR || resolved.fellBack;
