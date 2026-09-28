import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Load .env automatically if present (Node.js 20.6+ native loadEnvFile)
if (typeof (process as any).loadEnvFile === 'function') {
  try {
    const envPath = path.join(rootDir, '.env');
    if (fs.existsSync(envPath)) {
      (process as any).loadEnvFile(envPath);
    }
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      console.warn('[config] Warning loading .env file:', err.message);
    }
  }
}

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
  shrinkageWeight: parseFloat(process.env.SHRINKAGE_WEIGHT_M || '3.0'),
  pairwiseAlpha: parseFloat(process.env.BRADLEY_TERRY_ALPHA || '0.10'),
  rootDir,
  viewsDir: resolveExistingDir([path.join(__dirname, 'views'), path.join(rootDir, 'src', 'views')]),
  publicDir: resolveExistingDir([path.join(__dirname, 'public'), path.join(rootDir, 'src', 'public')]),
};
