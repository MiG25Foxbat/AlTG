import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateReportItems, extractNumbers, maxUrgency } from '../modules/AiModule/reportValidator';

const posts = [
  { id: 'a', text: 'ЦБ повысил ключевую ставку до 21,5% годовых. Решение вступает в силу с понедельника.' },
  { id: 'b', text: 'Минфин: дефицит бюджета составил 1 000 000 рублей, сообщает ведомство.' },
  { id: 'c', text: 'Курс доллара на бирже достиг 105 рублей впервые с весны.' },
];

const item = (over: object = {}) => ({
  text: 'ЦБ повысил ставку до 21.5%',
  source_ids: [0],
  quote: 'повысил ключевую ставку до 21,5%',
  urgency: 'important',
  ...over,
});

test('валидный пункт проходит, источники сопоставлены по индексам, дубли id схлопываются', () => {
  const { valid, rejected } = validateReportItems([item({ source_ids: [0, 0] })], posts);
  assert.equal(rejected.length, 0);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].urgency, 'important');
  assert.deepEqual(valid[0].sources.map((p) => p.id), ['a']);
});

test('source_ids: чужие, пустые, дробные и строковые — пункт выкидывается', () => {
  for (const source_ids of [[3], [-1], [0.5], ['0'], [], undefined, [0, 7]]) {
    const { valid, rejected } = validateReportItems([item({ source_ids })], posts);
    assert.equal(valid.length, 0, `source_ids=${JSON.stringify(source_ids)}`);
    assert.equal(rejected.length, 1);
  }
});

test('числа сравниваются по значению: 1,5 = 1.5, разряды через пробел и неразрывный пробел', () => {
  const ok = [
    item({ text: 'Ставка — 21,5%' }),
    item({ text: 'Дефицит — 1000000 рублей', source_ids: [1], quote: 'дефицит бюджета составил' }),
    item({ text: 'Дефицит — 1 000 000 рублей', source_ids: [1], quote: 'дефицит бюджета составил' }),
  ];
  assert.equal(validateReportItems(ok, posts).valid.length, 3);
});

test('число, которого нет в постах-источниках, — пункт выкидывается (даже если оно есть в другом посте)', () => {
  const invented = item({ text: 'ЦБ повысил ставку до 22%' });
  const fromOtherPost = item({ text: 'ЦБ повысил ставку до 21,5%, доллар по 105' }); // 105 — из поста c, а цитируется только a
  const { valid, rejected } = validateReportItems([invented, fromOtherPost], posts);
  assert.equal(valid.length, 0);
  assert.match(rejected[0].reason, /22/);
  assert.match(rejected[1].reason, /105/);
});

test('пункт с двумя источниками видит числа обоих', () => {
  const both = item({ text: 'Ставка 21,5%, доллар 105 рублей', source_ids: [0, 2] });
  assert.equal(validateReportItems([both], posts).valid.length, 1);
});

test('цитата: регистр и пробелы не важны, пересказ и цитата из чужого поста — нет', () => {
  const ok = item({ quote: '  ПОВЫСИЛ   ключевую\nставку  ' });
  const paraphrase = item({ quote: 'поднял ключевую ставку' });
  const fromOtherPost = item({ quote: 'курс доллара на бирже' });
  const missing = item({ quote: '' });
  const { valid, rejected } = validateReportItems([ok, paraphrase, fromOtherPost, missing], posts);
  assert.equal(valid.length, 1);
  assert.equal(rejected.length, 3);
});

test('цитата из пары символов не подтверждает ничего, кроме совсем короткого поста целиком', () => {
  assert.equal(validateReportItems([item({ quote: 'цб' })], posts).valid.length, 0);
  const tiny = [{ text: 'Шторм!' }];
  assert.equal(validateReportItems([{ text: 'Шторм', source_ids: [0], quote: 'шторм!', urgency: 'urgent' }], tiny).valid.length, 1);
});

test('пустой текст и мусор вместо пункта выкидываются, неизвестная срочность → normal', () => {
  const { valid, rejected } = validateReportItems(
    [item({ text: '   ' }), null, 'строка', item({ urgency: 'panic' })],
    posts
  );
  assert.equal(rejected.length, 3);
  assert.equal(valid[0].urgency, 'normal');
});

test('ни один пункт не прошёл — валидных нет (отчёт не шлём)', () => {
  const { valid } = validateReportItems([item({ source_ids: [9] }), item({ text: 'ставка 99%' })], posts);
  assert.deepEqual(valid, []);
});

test('extractNumbers: разряды, дроби, «2025 году 3 000», время, слипшиеся группы', () => {
  assert.deepEqual(extractNumbers('12 345,6 и 0.25'), [12345.6, 0.25]);
  assert.deepEqual(extractNumbers('в 2025 году 3 000 человек'), [2025, 3000]);
  assert.deepEqual(extractNumbers('1 2345'), [1, 2345]);
  assert.deepEqual(extractNumbers('в 15:30'), [15, 30]);
  assert.deepEqual(extractNumbers('без чисел'), []);
});

test('maxUrgency: максимум по уровням, пустой список — normal', () => {
  assert.equal(maxUrgency(['normal', 'urgent', 'important']), 'urgent');
  assert.equal(maxUrgency(['normal', 'important']), 'important');
  assert.equal(maxUrgency([]), 'normal');
});
