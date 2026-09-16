import { test } from 'node:test';
import assert from 'node:assert/strict';

// Полностью в памяти — не трогает реальный data/app.db и не требует
// живого подключения к Telegram или ключа Gemini. database.ts читает
// DB_PATH лениво (внутри getDb()), поэтому достаточно выставить его
// до первого фактического обращения к базе — не обязательно до импортов.
process.env.DB_PATH = ':memory:';
delete process.env.GEMINI_API_KEY;

import { createApp } from '../app';
import { closeDb } from '../db/database';
import { normalizeChannelUsername } from '../db/channelsRepo';
import { IUserBotReader } from '../modules/UserBotModule/IUserBotReader';
import { CollectedMessage } from '../modules/UserBotModule/windowPagination';

test('normalizeChannelUsername: принимает @имя, голое имя и ссылку t.me, отклоняет мусор', () => {
  assert.equal(normalizeChannelUsername('@testchannel'), '@testchannel');
  assert.equal(normalizeChannelUsername('testchannel'), '@testchannel');
  assert.equal(normalizeChannelUsername('https://t.me/testchannel'), '@testchannel');
  assert.equal(normalizeChannelUsername('  testchannel  '), '@testchannel');
  assert.throws(() => normalizeChannelUsername(''));
  assert.throws(() => normalizeChannelUsername('ab')); // слишком короткое
  assert.throws(() => normalizeChannelUsername('имя с пробелом'));
});

/** Фейковый Telegram-клиент: без сети, полностью управляемый из теста. */
class FakeUserBot implements IUserBotReader {
  messagesToReturn: CollectedMessage[] = [];

  async resolveChannel(channel: string) {
    if (channel === '@nonexistent') return null;
    return { title: 'Тестовый канал' };
  }

  async getMessagesInWindow(): Promise<CollectedMessage[]> {
    return this.messagesToReturn;
  }
}

async function startTestServer() {
  const fakeUserBot = new FakeUserBot();
  const app = createApp(fakeUserBot);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as any).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return { server, baseUrl, fakeUserBot };
}

test('HTTP API: полный сценарий работы с каналами и анализом', async (t) => {
  const { server, baseUrl, fakeUserBot } = await startTestServer();

  const api = async (pathname: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}${pathname}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : null;
    return { status: res.status, body };
  };

  await t.test('список каналов изначально пуст', async () => {
    const { status, body } = await api('/api/channels');
    assert.equal(status, 200);
    assert.deepEqual(body, []);
  });

  await t.test('доступно 8 пресетов периода', async () => {
    const { status, body } = await api('/api/time-windows');
    assert.equal(status, 200);
    assert.equal(body.length, 8);
    assert.deepEqual(
      body.map((o: any) => o.minutes),
      [5, 15, 30, 60, 180, 300, 420, 600]
    );
  });

  await t.test('добавление канала без @ нормализуется и резолвится через userBot', async () => {
    const { status, body } = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ username: 'testchannel' }),
    });
    assert.equal(status, 201);
    assert.equal(body.username, '@testchannel');
    assert.equal(body.title, 'Тестовый канал');
    assert.equal(body.isActive, true);
  });

  await t.test('повторное добавление того же канала — конфликт', async () => {
    const { status, body } = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ username: 'https://t.me/testchannel' }),
    });
    assert.equal(status, 409);
    assert.match(body.error, /уже добавлен/);
  });

  await t.test('добавление несуществующего канала — 404 от userBot.resolveChannel', async () => {
    const { status, body } = await api('/api/channels', {
      method: 'POST',
      body: JSON.stringify({ username: '@nonexistent' }),
    });
    assert.equal(status, 404);
    assert.match(body.error, /не найден/);
  });

  await t.test('анализ без темы — понятная ошибка 400', async () => {
    const { status, body } = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ windowMinutes: 60 }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /тему/);
  });

  await t.test(
    'анализ с активным каналом доходит до вызова Gemini и падает именно на отсутствии ключа',
    async () => {
      fakeUserBot.messagesToReturn = [
        { id: 1, text: 'Курс доллара вырос на 2%', date: Math.floor(Date.now() / 1000) - 60 },
        { id: 2, text: 'Сегодня хорошая погода', date: Math.floor(Date.now() / 1000) - 90 },
      ];
      const { status, body } = await api('/api/analyze', {
        method: 'POST',
        body: JSON.stringify({ topic: 'курс доллара', windowMinutes: 60 }),
      });
      // Дошли до реального вызова ИИ (посты получены, сохранены, отфильтрованы) —
      // упало именно на отсутствии GEMINI_API_KEY, а не раньше по цепочке.
      assert.equal(status, 500);
      assert.match(body.error, /GEMINI_API_KEY/);
    }
  );

  await t.test('выключение канала делает его неактивным', async () => {
    const { status, body } = await api('/api/channels/testchannel', {
      method: 'PATCH',
      body: JSON.stringify({ isActive: false }),
    });
    assert.equal(status, 200);
    assert.equal(body.isActive, false);
  });

  await t.test('анализ без активных каналов — понятная ошибка 400', async () => {
    const { status, body } = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ topic: 'курс доллара', windowMinutes: 60 }),
    });
    assert.equal(status, 400);
    assert.match(body.error, /активного канала/);
  });

  await t.test('удаление канала', async () => {
    const del = await api('/api/channels/testchannel', { method: 'DELETE' });
    assert.equal(del.status, 204);

    const list = await api('/api/channels');
    assert.deepEqual(list.body, []);
  });

  await t.test('удаление уже не существующего канала — 404', async () => {
    const { status } = await api('/api/channels/testchannel', { method: 'DELETE' });
    assert.equal(status, 404);
  });

  server.close();
  closeDb();
});
