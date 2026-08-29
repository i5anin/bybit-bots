// Веб-панель результатов и оповещения. Читает файлы бота, ничего в них не пишет.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { collect, readTrades } from './stats.mjs';
import * as telegram from './telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.WEB_PORT || 3004);
const NOTIFY_MS = Number(process.env.NOTIFY_INTERVAL_MS || 60000);
const WEB_URL = process.env.WEB_PUBLIC_URL || '';

const routes = {
  '/api/stats': async () => json(await collect()),
  '/api/health': async () => json({ ok: true, telegram: telegram.enabled }),
};

function json(data) {
  return {
    status: 200,
    type: 'application/json; charset=utf-8',
    body: JSON.stringify(data),
  };
}

async function page() {
  return {
    status: 200,
    type: 'text/html; charset=utf-8',
    body: await readFile(join(HERE, 'index.html'), 'utf8'),
  };
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  try {
    const handler = routes[path];
    const out = handler ? await handler() : path === '/' ? await page() : null;
    if (!out) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Не найдено');
    }
    res.writeHead(out.status, { 'content-type': out.type, 'cache-control': 'no-store' });
    res.end(out.body);
  } catch (err) {
    console.error('[web] ошибка запроса', path, err.message);
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Внутренняя ошибка');
  }
});

server.listen(PORT, () => {
  console.log(`[web] панель на порту ${PORT}`);
  console.log(`[telegram] оповещения ${telegram.enabled ? 'включены' : 'выключены (нет токена)'}`);
});

// Оповещения крутятся здесь же: отдельный процесс ради одного таймера избыточен.
async function notifyLoop() {
  try {
    const [stats, trades] = await Promise.all([collect(), readTrades()]);
    await telegram.tick(stats, trades, WEB_URL);
  } catch (err) {
    console.warn('[telegram] проход не удался:', err.message);
  }
}

if (telegram.enabled) {
  collect()
    .then(stats => telegram.sendStartupNotice(stats, WEB_URL))
    .catch(err => console.warn('[telegram] приветствие не ушло:', err.message));
  setInterval(notifyLoop, NOTIFY_MS);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
