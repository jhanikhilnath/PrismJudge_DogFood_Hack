import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export const config = {
  port: parseInt(process.env.PORT || '8080', 10),
  host: process.env.HOST || '0.0.0.0',
  baseUrl: process.env.BASE_URL || 'http://localhost:8080',
  sessionSecret: process.env.SESSION_SECRET || 'dogfood_2026_super_secure_offline_secret_key_99x',
  dbPath: process.env.DB_PATH || path.join(rootDir, 'portal.sqlite'),
  fixturesPath: process.env.FIXTURES_PATH || path.join(rootDir, 'fixtures.json'),
  env: process.env.NODE_ENV || 'production',
  rootDir,
  viewsDir: path.join(__dirname, 'views'),
  publicDir: path.join(__dirname, 'public'),
};
