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
 * Летуаль не подключён: без JS сайт отдаёт оболочку без акций (проверено 12.11.2026).
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
  // с зарубежного адреса не открываются (проверено 12.11.2026 из Германии), работают только с российского; раннер сам отключит и раз в сутки перепроверит
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
  // с зарубежного адреса не открываются (проверено 12.11.2026 из Германии), работают только с российского; раннер сам отключит и раз в сутки перепроверит
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
