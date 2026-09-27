import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function resolveExistingDir(candidates: string[]): string {
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0]!;
}

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'http://localhost:8080',
  sessionSecret: process.env.SESSION_SECRET || 'dogfood_2026_super_secure_offline_secret_key_99x',
  dbPath: process.env.DB_PATH || path.join(rootDir, 'portal.sqlite'),
  fixturesPath: process.env.FIXTURES_PATH || path.join(rootDir, 'fixtures.json'),
  env: process.env.NODE_ENV || 'production',
  rootDir,
  viewsDir: resolveExistingDir([path.join(__dirname, 'views'), path.join(rootDir, 'src', 'views')]),
  publicDir: resolveExistingDir([path.join(__dirname, 'public'), path.join(rootDir, 'src', 'public')]),
};
