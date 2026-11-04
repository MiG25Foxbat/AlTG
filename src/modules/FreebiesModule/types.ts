/** Сырые записи разборщика (docs/freebies/CONTRACT.md, раздел 1). Текст в базу не пишется. */
export interface RawDeal {
  externalId: string | null;
  title: string;
  /** Весь текст записи; слова из <code> обёрнуты в обратные кавычки */
  text: string;
  url: string;
  publishedAt: number | null;
  /** Хосты ссылок из текста (без t.me): подсказка, о каком магазине речь */
  hosts?: string[];
}

/** Чистая функция, тестируется на сохранённых примерах из src/tests/fixtures/freebies/. */
export interface SourceAdapter {
  key: string;
  parse(body: string, contentType: string): RawDeal[];
}
