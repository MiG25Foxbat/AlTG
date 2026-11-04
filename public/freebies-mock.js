// Примеры из docs/freebies/mock-deals.json (всё выдумано). Нужны, пока адреса /api/feed и /api/freebies/*
// не отвечают: freebies.js берёт их только при ответе 404. Когда адреса заработают — удалить этот файл
// и его <script> в index.html.
window.freebiesMock = (() => {
  // В примерах «сейчас» это 5 ноября 2026, 04:00 МСК. Сдвигаем времена к настоящему «сейчас», чтобы «N мин назад» выглядело живо.
  const shift = Math.floor(Date.now() / 1000) - 1793840400;
  const at = (x) => (x == null ? null : x + shift);

  const stores = [
    { code: 'goldapple', label: 'Золотое яблоко' },
    { code: 'wildberries', label: 'Wildberries' },
    { code: 'ozon', label: 'Ozon' },
    { code: 'other', label: 'Другие магазины' },
  ];
  const categories = [
    { code: 'beauty', label: 'Красота' },
    { code: 'fashion', label: 'Мода' },
    { code: 'pets', label: 'Зоотовары' },
    { code: 'other', label: 'Другое' },
  ];
  const settings = {
    profile: null, alertsEnabled: false, stores: [], categories: [], onlyWithPromo: false, minDiscount: 0,
    breakQuiet: false, quietEnabled: true, quietFrom: '23:00', quietTo: '08:00', maxPerDay: 30,
  };

  const deals = [
    { id: 101, sourceId: 1, sourceTitle: 'Pepper.ru', sourceUrl: 'https://www.pepper.ru/', store: 'goldapple', category: 'beauty',
      title: 'Минус 30% на уходовую косметику по промокоду', url: 'https://goldapple.ru/example-promo', promoCode: 'PRIMER30',
      discountPercent: 30, discountText: '-30%', expiresAt: 1793872800, publishedAt: 1793840100, foundAt: 1793840160, status: 'live' },
    { id: 102, sourceId: 2, sourceTitle: 'Канал Золотого яблока', sourceUrl: 'https://t.me/example_goldapple', store: 'goldapple', category: 'beauty',
      title: 'Подарок к заказу от 3000 ₽', url: 'https://goldapple.ru/example-gift', promoCode: 'PODAROK',
      discountPercent: null, discountText: 'подарок от 3000 ₽', expiresAt: null, publishedAt: 1793838600, foundAt: 1793838650, status: 'maybe_over' },
    { id: 103, sourceId: 1, sourceTitle: 'Pepper.ru', sourceUrl: 'https://www.pepper.ru/', store: 'wildberries', category: 'fashion',
      title: 'Кроссовки со скидкой 55% без промокода', url: 'https://www.wildberries.ru/catalog/0000000/detail.aspx', promoCode: null,
      discountPercent: 55, discountText: '-55%', expiresAt: null, publishedAt: 1793840280, foundAt: 1793840300, status: 'live' },
    { id: 104, sourceId: 3, sourceTitle: 'Пример агрегатора', sourceUrl: 'https://example.org/', store: 'wildberries', category: 'pets',
      title: 'Корм для кошек: 500 ₽ на первый заказ', url: 'https://www.wildberries.ru/example-pets', promoCode: 'KOTIK500',
      discountPercent: null, discountText: '500 ₽ на первый заказ', expiresAt: 1793800000, publishedAt: 1793790000, foundAt: 1793790100, status: 'expired' },
  ].map((d) => ({ ...d, expiresAt: at(d.expiresAt), publishedAt: at(d.publishedAt), foundAt: at(d.foundAt) }));

  const feed = [
    ...deals.map((d) => ({
      kind: 'deal', id: `deal:${d.id}`, at: d.foundAt, title: stores.find((s) => s.code === d.store).label,
      text: d.title, link: d.url, sourceLabel: d.sourceTitle, deal: d,
    })),
    { kind: 'post', id: 'post:@example_news:5123', at: at(1793840200), title: 'Пример новостного канала',
      text: 'Пример поста из канала, который пользователь добавил во вкладке «Каналы».',
      link: 'https://t.me/example_news/5123', sourceLabel: '@example_news' },
  ].sort((a, b) => b.at - a.at);

  return (path, options = {}) => {
    const url = new URL(path, location.origin);
    const q = url.searchParams;
    switch (url.pathname) {
      case '/api/freebies/settings':
        if (options.method === 'PATCH') Object.assign(settings, JSON.parse(options.body));
        return { settings: { ...settings }, stores, categories };
      case '/api/freebies/deals':
        return { deals: deals.filter((d) => (!q.get('store') || d.store === q.get('store')) && (!q.get('category') || d.category === q.get('category'))) };
      case '/api/feed': {
        const kind = q.get('kind');
        return { items: feed.filter((i) => kind === 'all' || (kind === 'channels' ? i.kind === 'post' : i.kind === 'deal')) };
      }
      case '/api/freebies/preview':
        return {
          results: deals.map((d) => ({
            deal: d, wouldSend: d.status !== 'expired', holdUntil: d.status === 'maybe_over' ? Math.floor(Date.now() / 1000) + 3600 : null, message: null,
            reason: d.status === 'live' ? 'ok' : d.status === 'maybe_over' ? 'held' : 'expired',
          })),
          alertsEnabled: settings.alertsEnabled,
          botLinked: false,
        };
      default:
        throw new Error('Ошибка запроса (404)');
    }
  };
})();
