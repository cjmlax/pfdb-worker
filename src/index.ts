import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { config } from './config';
import { migrate } from './db';
import { seedAutoBadges } from './users';
import { clientIp } from './clientIp';
import { registerLinkRoutes } from './routes/links';
import { registerPublicRoutes } from './routes/public';
import { registerAdminRoutes } from './routes/admin';
import { registerAdminBadgeRoutes } from './routes/adminBadges';
import { registerAdminAlertRoutes } from './routes/adminAlerts';
import { registerImageRoutes } from './routes/image';
import { registerModPairRoutes } from './routes/modPairs';
import { registerZitadelActionRoutes } from './routes/zitadelActions';
import { registerVersionPoller } from './tasks/versionPoller';
import { registerWeeklySetsPoller } from './tasks/weeklySetsPoller';
import { registerFrogStatsCache } from './tasks/frogStatsCache';
import { registerDailyFrog } from './tasks/dailyFrog';

async function main() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: true, // behind cloudflared + HAProxy; see clientIp for the visitor's address
  });

  await migrate();
  await seedAutoBadges();

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.upload.maxBytes, files: 1 } });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: clientIp });
  await app.register(cors, {
    origin: config.allowedOrigin.includes('*') ? true : config.allowedOrigin,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  });

  app.get('/healthz', async () => ({ ok: true }));

  await registerPublicRoutes(app);
  await registerAdminRoutes(app);
  await registerAdminBadgeRoutes(app);
  await registerAdminAlertRoutes(app);
  await registerImageRoutes(app);
  await registerModPairRoutes(app);
  await registerLinkRoutes(app);
  await registerZitadelActionRoutes(app);

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `pfdb-worker up — site=${config.siteUrl}, origins=${config.allowedOrigin.join(',')}`,
  );
  registerVersionPoller(app.log);
  registerWeeklySetsPoller(app.log);
  registerFrogStatsCache(app.log);
  registerDailyFrog(app.log);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
