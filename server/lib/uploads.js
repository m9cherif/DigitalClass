/**
 * Where uploaded files live.
 *
 * By default they sit in public/uploads, which is fine locally but is inside
 * the deployed directory — a host that rebuilds that directory on every deploy
 * (Hostinger, most PaaS) would erase them. Set UPLOAD_DIR to a path outside
 * the deploy root to keep uploads across releases, e.g.
 *
 *   UPLOAD_DIR=/home/<account>/persistent/uploads
 */
import fs from 'node:fs';
import path from 'node:path';

export const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.resolve('public/uploads');

export const uploadsAreEphemeral = !process.env.UPLOAD_DIR;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
