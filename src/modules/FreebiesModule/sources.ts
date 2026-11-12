import { SourceDef } from '../../db/dealsRepo';
import { ParseDefaults } from './parse';
import { tmeAdapter } from './tmeAdapter';
import { iledebeauteAdapter, lapyAdapter, podrygkaAdapter, probnickAdapter, proactionsAdapter } from './webAdapters';
import { SourceAdapter } from './types';

/**
 * Источники первого захода (docs/freebies/SOURCES.md): три публичных Telegram-канала через веб-превью t.me/s.
 * Список лежит в коде и при старте вписывается в deal_sources по key. Все три на одном хосте,
 * раннер ходит к хосту по очереди. Пикабу, hl.ru и Pepper.ru не подключены (условия, капча).
 * Пять веб-источников второго захода (docs/freebies/SOURCES_WEB.md) - доверенные: каждая запись это акция.
 * Летуаль-сайт не подключён: без JS отдаёт оболочку без акций (проверено 12.11.2026).
 * Официальные Telegram-каналы магазинов (tg-…-official, закрытые для ботов или не открывающиеся с части адресов сайты)
 * читаются тем же tmeAdapter и недоверенные: нужен промокод или скидка.
 */
export interface SourceConfig extends SourceDef {
  adapter: SourceAdapter;
  defaults: ParseDefaults;
}

export const SOURCES: SourceConfig[] = [
  {
    key: 'tg-promokodi-beauty',
    kind: 'html',
    title: 'Вот это скидка! (Telegram)',
    url: 'https://t.me/s/promokodi_skidki_beauty',
    siteUrl: 'https://t.me/promokodi_skidki_beauty',
    intervalSec: 120,
    adapter: tmeAdapter,
    defaults: {},
  },
  {
    key: 'tg-promokodi-goldapple',
    kind: 'html',
    title: 'Промокоды Золотое Яблоко (Telegram)',
    url: 'https://t.me/s/Promokodi_zolotoe_yabloko',
    siteUrl: 'https://t.me/Promokodi_zolotoe_yabloko',
    intervalSec: 120,
    adapter: tmeAdapter,
    defaults: { store: 'goldapple', category: 'beauty' },
  },
  {
    key: 'tg-wildberries',
    kind: 'html',
    title: 'Wildberries, официальный канал',
    url: 'https://t.me/s/wildberriesru_official',
    siteUrl: 'https://t.me/wildberriesru_official',
    intervalSec: 300,
    adapter: tmeAdapter,
    defaults: { store: 'wildberries' },
  },
  {
    key: 'tg-goldapple-official',
    kind: 'html',
    title: 'Золотое яблоко, официальный канал',
    url: 'https://t.me/s/goldapple',
    siteUrl: 'https://t.me/goldapple',
    intervalSec: 300,
    adapter: tmeAdapter,
    defaults: { store: 'goldapple', category: 'beauty' },
  },
  {
    key: 'tg-letual-official',
    kind: 'html',
    title: 'Летуаль, официальный канал',
    url: 'https://t.me/s/letoileofficial',
    siteUrl: 'https://t.me/letoileofficial',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'letual', category: 'beauty' },
  },
  {
    key: 'tg-iledebeaute-official',
    kind: 'html',
    title: 'Иль де Ботэ, официальный канал',
    url: 'https://t.me/s/iledebeaute_ru',
    siteUrl: 'https://t.me/iledebeaute_ru',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'iledebeaute', category: 'beauty' },
  },
  {
    key: 'tg-rivegauche-official',
    kind: 'html',
    title: 'Рив Гош, официальный канал',
    url: 'https://t.me/s/rivegaucheru',
    siteUrl: 'https://t.me/rivegaucheru',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'rivegauche', category: 'beauty' },
  },
  {
    key: 'tg-ozon-official',
    kind: 'html',
    title: 'Ozon, официальный канал',
    url: 'https://t.me/s/ozonru',
    siteUrl: 'https://t.me/ozonru',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'ozon' },
  },
  {
    key: 'tg-yandexmarket-official',
    kind: 'html',
    title: 'Яндекс Маркет, официальный канал',
    url: 'https://t.me/s/yndx_market',
    siteUrl: 'https://t.me/yndx_market',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'yandexmarket' },
  },
  {
    key: 'tg-4lapy-official',
    kind: 'html',
    title: 'Четыре Лапы, официальный канал',
    url: 'https://t.me/s/zoo_4lapy',
    siteUrl: 'https://t.me/zoo_4lapy',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: '4lapy', category: 'pets' },
  },
  {
    key: 'tg-detmir-official',
    kind: 'html',
    title: 'Детский мир, официальный канал',
    url: 'https://t.me/s/detmir_shop',
    siteUrl: 'https://t.me/detmir_shop',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'detmir', category: 'kids' },
  },
  {
    key: 'tg-lamoda-official',
    kind: 'html',
    title: 'Lamoda, официальный канал',
    url: 'https://t.me/s/lamoda_na_svyazi',
    siteUrl: 'https://t.me/lamoda_na_svyazi',
    intervalSec: 600,
    adapter: tmeAdapter,
    defaults: { store: 'lamoda', category: 'fashion' },
  },
  // 12.11.2026: открывается из России и из дата-центров в Германии, Нидерландах, США (check-host.net), но не с адреса VPN разработчика;
  // если адрес сервера окажется закрыт, раннер отключит источник после 5 неудач и будет перепроверять раз в сутки, акции придут через официальный канал.
  {
    key: 'web-iledebeaute',
    kind: 'html',
    title: 'Иль де Ботэ, акции',
    url: 'https://iledebeaute.ru/promotions/actions/',
    siteUrl: 'https://iledebeaute.ru/promotions/actions/',
    intervalSec: 1800,
    adapter: iledebeauteAdapter,
    defaults: { store: 'iledebeaute', category: 'beauty', trusted: true },
  },
  // 12.11.2026: открывается из России и из дата-центров в Германии, Нидерландах, США (check-host.net), но не с адреса VPN разработчика;
  // если адрес сервера окажется закрыт, раннер отключит источник после 5 неудач и будет перепроверять раз в сутки, акции придут через официальный канал.
  {
    key: 'web-4lapy',
    kind: 'html',
    title: 'Четыре Лапы, акции',
    url: 'https://4lapy.ru/shares/',
    siteUrl: 'https://4lapy.ru/shares/',
    intervalSec: 900,
    adapter: lapyAdapter,
    defaults: { store: '4lapy', category: 'pets', trusted: true },
  },
  {
    key: 'web-podrygka',
    kind: 'html',
    title: 'Подружка, акции',
    url: 'https://www.podrygka.ru/actions/',
    siteUrl: 'https://www.podrygka.ru/actions/',
    intervalSec: 1800,
    adapter: podrygkaAdapter,
    defaults: { store: 'podrygka', category: 'beauty', trusted: true },
  },
  {
    key: 'web-proactions',
    kind: 'rss',
    title: 'Proactions, акции с призами',
    url: 'https://proactions.ru/rss/',
    siteUrl: 'https://proactions.ru/',
    intervalSec: 1800,
    adapter: proactionsAdapter,
    defaults: { store: 'other', category: 'contests', trusted: true },
  },
  {
    key: 'web-probnick',
    kind: 'html',
    title: 'Пробник.ру, конкурсы',
    url: 'https://probnick.ru/',
    siteUrl: 'https://probnick.ru/',
    intervalSec: 1800,
    adapter: probnickAdapter,
    defaults: { store: 'other', category: 'contests', trusted: true },
  },
];

/** Описание источника для записи в deal_sources (без разборщика). */
export const sourceDefs = (): SourceDef[] =>
  SOURCES.map(({ key, kind, title, url, siteUrl, intervalSec }) => ({ key, kind, title, url, siteUrl, intervalSec }));
