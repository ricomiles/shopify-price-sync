import express from 'express';
import { getConfigOrExit } from './config.js';
import { pricesRouter } from './routes/prices.js';
import { prisma } from './db.js';

const config = getConfigOrExit();
const app = express();

app.use(express.json());
app.use(express.static('public'));
app.use(pricesRouter);

app.get('/health', (_req, res) => {
  res.json({ ok: true, stores: config.stores.map((s) => s.key) });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('Unhandled error:', message);
  res.status(500).json({ error: 'internal_error', detail: message });
});

const server = app.listen(config.port, () => {
  console.log(`Listening on http://localhost:${config.port}`);
  console.log(`Stores: ${config.stores.map((s) => s.key).join(', ')}`);
});

async function shutdown(signal: string) {
  console.log(`\n${signal} received, shutting down.`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
