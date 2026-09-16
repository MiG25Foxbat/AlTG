import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeywords, keywordPreFilter } from '../modules/FilterModule/keywordFilter';

test('extractKeywords: убирает стоп-слова и короткие обрубки, приводит к нижнему регистру', () => {
  const keywords = extractKeywords('Что такое рост Доллара и курс USD?');
  assert.ok(keywords.includes('доллара'));
  assert.ok(keywords.includes('курс'));
  assert.ok(keywords.includes('usd'));
  assert.ok(!keywords.includes('что'), 'стоп-слово "что" не должно попасть в список');
  assert.ok(!keywords.includes('и'), 'однобуквенное слово не должно попасть в список');
});

test('extractKeywords: пустая/бессмысленная тема даёт пустой список', () => {
  assert.deepEqual(extractKeywords(''), []);
  assert.deepEqual(extractKeywords('и в но да'), []);
});

test('keywordPreFilter: находит пост хотя бы по одному ключевому слову (логика ИЛИ)', () => {
  const posts = [
    { text: 'Курс доллара обновил максимум за месяц' },
    { text: 'Новый мультфильм вышел в прокат' },
    { text: 'Bitcoin вырос на 5% за сутки' },
  ];
  const matched = keywordPreFilter(posts, ['доллар', 'bitcoin']);
  assert.equal(matched.length, 2);
  assert.ok(matched.some((p) => p.text.includes('доллара')));
  assert.ok(matched.some((p) => p.text.includes('Bitcoin')));
});

test('keywordPreFilter: регистр не важен', () => {
  const posts = [{ text: 'СРОЧНО: акции Газпрома упали' }];
  const matched = keywordPreFilter(posts, ['газпрома']);
  assert.equal(matched.length, 1);
});

test('keywordPreFilter: без ключевых слов или без совпадений возвращает пустой список', () => {
  const posts = [{ text: 'Курс доллара вырос' }];
  assert.deepEqual(keywordPreFilter(posts, []), []);
  assert.deepEqual(keywordPreFilter(posts, ['биткоин']), []);
});
