import { buildApp } from './app.js';
import { config } from './config.js';
import { seedDatabase } from './db/seed.js';

async function main(): Promise<void> {
  // 1. Ensure database is initialized & seeded
  try {
    seedDatabase();
  } catch (err) {
    console.error('Database seed error:', err);
  }

  // 2. Build Fastify app
  const app = await buildApp();

  // 3. Start listening
  try {
    await app.listen({ port: config.port, host: config.host });

    // Startup banner as expected by organizers and spec
    console.log(`DOGFOOD 2026 portal listening on ${config.baseUrl}`);
    console.log('seeded. test logins:');
    console.log('  organizer    Cookie: session=org_7f2a');
    console.log('  judge_a      Cookie: session=jdg_a_91bc');
    console.log('  judge_b      Cookie: session=jdg_b_44de');
    console.log('  participant  Cookie: session=prt_2e88');
  } catch (err) {
    console.error('Server startup failed:', err);
    process.exit(1);
  }
}

main();
