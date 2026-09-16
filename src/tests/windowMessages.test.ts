import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectMessagesInWindow, PageFetcher, RawMessage } from '../modules/UserBotModule/windowPagination';

/**
 * Имитирует client.getMessages(channel, {limit, offsetId}): messages должен
 * быть отсортирован от новых к старым (по убыванию id) — как отдаёт реальный
 * GramJS. Возвращает счётчик вызовов, чтобы проверять, что пагинация
 * останавливается вовремя, а не вычитывает всю историю канала.
 */
function makeFakeFetcher(all: RawMessage[], pageSize: number): PageFetcher & { calls: number } {
  const fetcher: any = async (offsetId: number) => {
    fetcher.calls += 1;
    const startIndex = offsetId === 0 ? 0 : all.findIndex((m) => m.id === offsetId) + 1;
    if (offsetId !== 0 && startIndex === 0) return [];
    return all.slice(startIndex, startIndex + pageSize);
  };
  fetcher.calls = 0;
  return fetcher;
}

test('collectMessagesInWindow: все сообщения одной страницы попадают в окно', async () => {
  const now = 1_000_000;
  const messages: RawMessage[] = [
    { id: 105, message: 'E', date: now - 10 },
    { id: 104, message: 'D', date: now - 20 },
    { id: 103, message: 'C', date: now - 30 },
    { id: 102, message: 'B', date: now - 40 },
    { id: 101, message: 'A', date: now - 50 },
  ];
  const fetcher = makeFakeFetcher(messages, 100);
  const result = await collectMessagesInWindow(fetcher, now - 1000, 500);
  assert.deepEqual(result.map((r) => r.id), [105, 104, 103, 102, 101]);
  // после первой (неполной) страницы граница окна не пройдена, поэтому
  // потребуется ещё один запрос, который вернёт пустую страницу и подтвердит конец истории
  assert.equal(fetcher.calls, 2);
});

test('collectMessagesInWindow: останавливается на границе окна и не читает более старые страницы', async () => {
  const base = 1_000_000;
  const messages: RawMessage[] = Array.from({ length: 10 }, (_, i) => {
    const id = 110 - i;
    return { id, message: `msg-${id}`, date: base - i * 60 };
  }); // id 110..101, самый новый первый

  const cutoff = base - 5 * 60 - 1; // должны попасть id 110..105 (6 штук)
  const fetcher = makeFakeFetcher(messages, 3);
  const result = await collectMessagesInWindow(fetcher, cutoff, 500);

  assert.deepEqual(result.map((r) => r.id), [110, 109, 108, 107, 106, 105]);
  assert.equal(fetcher.calls, 3, 'не должен запрашивать страницы за пределами окна');
});

test('collectMessagesInWindow: сообщения без текста (альбомы) отбрасываются', async () => {
  const now = 1_000_000;
  const messages: RawMessage[] = [
    { id: 103, message: '   ', date: now - 10 }, // фото без подписи
    { id: 102, message: '', date: now - 20 }, // ещё одно фото из альбома
    { id: 101, message: 'Подпись к альбому', date: now - 30 },
  ];
  const fetcher = makeFakeFetcher(messages, 100);
  const result = await collectMessagesInWindow(fetcher, now - 1000, 500);
  assert.deepEqual(result.map((r) => r.id), [101]);
});

test('collectMessagesInWindow: уважает maxMessages, даже если в окне есть ещё посты', async () => {
  const now = 1_000_000;
  const messages: RawMessage[] = [
    { id: 103, message: 'C', date: now - 10 },
    { id: 102, message: 'B', date: now - 20 },
    { id: 101, message: 'A', date: now - 30 },
  ];
  const fetcher = makeFakeFetcher(messages, 100);
  const result = await collectMessagesInWindow(fetcher, now - 1000, 2);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.id), [103, 102]);
});

test('collectMessagesInWindow: корректно доходит до начала истории канала (пустая страница)', async () => {
  const now = 1_000_000;
  const messages: RawMessage[] = [
    { id: 104, message: 'D', date: now - 10 },
    { id: 103, message: 'C', date: now - 20 },
    { id: 102, message: 'B', date: now - 30 },
    { id: 101, message: 'A', date: now - 40 },
  ];
  const fetcher = makeFakeFetcher(messages, 3);
  const result = await collectMessagesInWindow(fetcher, now - 1000, 500);
  assert.equal(result.length, 4);
  // страница [104,103,102] + страница [101] + пустая страница, на которой пагинация останавливается
  assert.equal(fetcher.calls, 3);
});

test('collectMessagesInWindow: пустой канал (нет сообщений вообще)', async () => {
  const fetcher = makeFakeFetcher([], 100);
  const result = await collectMessagesInWindow(fetcher, 0, 500);
  assert.deepEqual(result, []);
  assert.equal(fetcher.calls, 1);
});
