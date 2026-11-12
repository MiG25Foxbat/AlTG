import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { extractDeals, selectDeals } from '../modules/FreebiesModule/parse';
import { decodeEntities } from '../modules/FreebiesModule/tmeAdapter';
import { parseRobots } from '../modules/FreebiesModule/robots';
import { SOURCES } from '../modules/FreebiesModule/sources';
import {
  iledebeauteAdapter,
  lapyAdapter,
  podrygkaAdapter,
  proactionsAdapter,
  probnickAdapter,
} from '../modules/FreebiesModule/webAdapters';

/** Урезанные куски живых страниц (src/tests/fixtures/freebies/web-*), собранные 11 ноября 2026. */
const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'freebies', name), 'utf8');
const ts = (iso: string) => Date.parse(iso) / 1000;
const msk = (date: string) => ts(`${date}T23:59:59+03:00`);
const NOW = ts('2026-11-11T10:00:00Z');
const defaultsOf = (key: string) => SOURCES.find((s) => s.key === key)!.defaults;

test('Иль де Ботэ: акции из __NEXT_DATA__, пункт меню не берётся, срок из dateTo, бессрочная без срока', () => {
  const deals = iledebeauteAdapter.parse(fixture('web-iledebeaute.html'), 'text/html');
  assert.equal(deals.length, 3);
  assert.equal(deals.some((d) => d.title.startsWith('Столбец')), false);
  assert.equal(deals[0].title, 'GOLD FRIDAY: Золотой сезон набирает обороты');
  assert.equal(deals[0].url, 'https://iledebeaute.ru/promotions/actions/gold-friday-zolotoj-sezon-nabiraet-oboroty/');
  assert.equal(deals.some((d) => d.url.includes('evil.example')), false, 'ссылка на чужой хост не берётся');
  assert.deepEqual([deals[0].publishedAt, deals[0].expiresAt, deals[2].expiresAt], [null, ts('2026-11-15T20:59:00Z'), null]);
  assert.throws(() => iledebeauteAdapter.parse('<html>заглушка</html>', 'text/html'), /__NEXT_DATA__/);
});

test('Четыре Лапы: закрытая акция не берётся, ссылка по коду, срок - конец дня по Москве', () => {
  const deals = lapyAdapter.parse(fixture('web-4lapy.html'), 'text/html');
  assert.equal(deals.length, 3);
  assert.equal(deals.some((d) => d.title.includes('ловушка')), false);
  assert.equal(deals[0].url, 'https://4lapy.ru/shares/shopping-day/');
  assert.equal(deals[0].expiresAt, msk('2026-11-15'));
  assert.equal(deals[0].text, deals[0].title, 'плашка скидки не копируется');
  assert.equal(deals[0].title, 'Скидки до 60% на корма, одежду и другие аксессуары для питомцев');
});

test('Подружка: дубли по ссылке убраны, каталог и чужие хосты не берутся', () => {
  const deals = podrygkaAdapter.parse(fixture('web-podrygka.html'), 'text/html');
  assert.deepEqual(deals.map((d) => d.url.replace('https://www.podrygka.ru/actions/', '')), ['kd_vivienne_sabo_dekor_nov2026/', 'kd_influence_nov2026/', 'kd_stellary_nov2026/']);
  assert.equal(deals[0].title, 'Клиентские дни VIVIENNE SABO: скидка -50%!');
  assert.equal(deals.some((d) => d.title.includes('Мусор')), false, 'битая ссылка пропущена, страница разобрана');
});

test('Proactions RSS: title, link, pubDate; дубль по guid убран; описание в текст не попадает', () => {
  const deals = proactionsAdapter.parse(fixture('web-proactions.xml'), 'application/rss+xml');
  assert.equal(deals.length, 2);
  assert.equal(deals[0].title, 'M&M\'s: «Акция в M&M\'s в магазинах «Магнит»');
  assert.equal(deals[0].url, 'https://proactions.ru/actions/food/mms/akciya-v-mms-v-magazinah-magnit.html');
  assert.equal(deals[0].publishedAt, ts('2026-11-03T12:52:08+03:00'));
  assert.equal(deals.some((d) => d.text.includes('Описание')), false);
  assert.equal(deals.some((d) => d.url.includes('evil.example')), false, 'ссылка на чужой хост не берётся');
  // HTML-заглушка с кодом 200 и лента с незакрытыми item - ошибка разбора, а не пустой успех.
  assert.throws(() => proactionsAdapter.parse('<html><body>Доступ ограничен</body></html>', 'text/html'), /нет карточек/);
  assert.throws(() => proactionsAdapter.parse('<item><title>x</title>'.repeat(1000), 'text/xml'), /нет карточек/);
});

test('Пробник.ру: название, ссылка, дата без времени = конец дня по Москве, срок из названия', () => {
  const deals = probnickAdapter.parse(fixture('web-probnick.html'), 'text/html');
  assert.equal(deals.length, 3);
  assert.equal(deals[0].title, 'Потрясающие призы от M&M’s и Skittles до 18 января 2027 года');
  assert.equal(deals[0].url, 'https://probnick.ru/potryasayushhie-prizy-ot-mms-i-skittles-do-18-yanvarya-2027-goda/');
  assert.equal(deals[0].publishedAt, msk('2026-11-10'));
  assert.equal(extractDeals(deals[0], defaultsOf('web-probnick'), NOW)[0].expiresAt, msk('2027-01-18'));
  // Запись от 9 ноября отбрасывается обычным правилом «старше суток».
  assert.equal(selectDeals(deals, defaultsOf('web-probnick'), NOW + 7200).length, 2);
});

test('фильтр: доверенный без скидки проходит, недоверенный other отбрасывается, недоверенный распознанный магазин со скидкой проходит', () => {
  const raw = (text: string) => ({ title: text, text, url: 'https://example.ru/x', publishedAt: NOW - 60 });
  const trusted = selectDeals([raw('Новая акция без цифр')], { store: 'letual', category: 'beauty', trusted: true }, NOW);
  assert.deepEqual(trusted.map((d) => [d.store, d.category, d.promoCode, d.discountPercent, d.discountText]), [['letual', 'beauty', null, null, null]]);
  assert.deepEqual(selectDeals([raw('Скидка 30% на всё')], {}, NOW), []);
  assert.deepEqual(selectDeals([raw('Новая акция без цифр в Летуаль')], {}, NOW), []);
  assert.deepEqual(selectDeals([raw('Скидка 30% в Летуаль')], {}, NOW).map((d) => d.store), ['letual']);
  assert.deepEqual(selectDeals([raw('Скидка 30% на Ozon')], {}, NOW).map((d) => d.store), ['ozon']);
  // Доверенному источнику магазин и категория из defaults, а не из слов в названии.
  const contest = selectDeals([raw('Конкурс косметики в Золотом яблоке')], { store: 'other', category: 'contests', trusted: true }, NOW);
  assert.deepEqual(contest.map((d) => [d.store, d.category]), [['other', 'contests']]);
  assert.equal(decodeEntities('a&#99999999999;b&#x110000;c&amp;'), 'a&#99999999999;b&#x110000;c&');
  assert.equal(SOURCES.filter((s) => s.defaults.trusted).length, 5);
});

test('официальный канал магазина: пост без названия магазина со скидкой проходит как магазин и категория источника', () => {
  const raw = { title: 'Скидка 20% на конструкторы', text: 'Скидка 20% на конструкторы', url: 'https://t.me/detmir_shop/1', publishedAt: NOW - 60 };
  const [d] = selectDeals([raw], defaultsOf('tg-detmir-official'), NOW);
  assert.deepEqual([d.store, d.category, d.discountPercent], ['detmir', 'kids', 20]);
  assert.deepEqual(selectDeals([{ ...raw, text: 'Новая коллекция' }], defaultsOf('tg-detmir-official'), NOW), [], 'недоверенный: без скидки и кода не проходит');
});

test('robots Подружки: шаблоны * и $, /actions/ разрешён, закрытое закрыто', () => {
  const r = parseRobots('User-agent: *\nDisallow: /*?*\nDisallow: *promotion*\nDisallow: /promo/\nAllow: */actions/aktsiya_promkodyi_2026/\n', 'gram-pervonah-freebies/1.0');
  assert.equal(r.allows('/actions/'), true);
  assert.equal(r.allows('/actions/kd_influence_nov2026/'), true);
  assert.equal(r.allows('/actions/?PAGEN_1=2'), false);
  assert.equal(r.allows('/catalog/promotion_x/'), false);
  assert.equal(r.allows('/promo/a'), false);
});
