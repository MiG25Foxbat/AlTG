import { SourceDef } from '../../db/dealsRepo';
import { ParseDefaults } from './parse';
import { tmeAdapter } from './tmeAdapter';
import { SourceAdapter } from './types';

/**
 * Источники первого захода (docs/freebies/SOURCES.md): три публичных Telegram-канала через веб-превью t.me/s.
 * Список лежит в коде и при старте вписывается в deal_sources по key. Все три на одном хосте,
 * раннер ходит к хосту по очереди. Пикабу, hl.ru и Pepper.ru не подключены (условия, капча).
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
];

/** Описание источника для записи в deal_sources (без разборщика). */
export const sourceDefs = (): SourceDef[] =>
  SOURCES.map(({ key, kind, title, url, siteUrl, intervalSec }) => ({ key, kind, title, url, siteUrl, intervalSec }));
