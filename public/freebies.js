// Халява: общая лента, вкладка «Халява», её настройки и выбор профиля при первом входе.
// Данные с сервера недоверенные: тексты только через el()/textContent, ссылки через safeHref().
// Хелперы el, api, byId, formatMsk, switchTab, switchControl, checkboxEl — из app.js.
(() => {
  const fr = { settings: null, stores: [], categories: [], kind: 'all', store: '', bound: false };

  const KIND_LABELS = { all: 'Все', channels: 'Каналы', freebies: 'Халява' };
  const FEED_EMPTY = {
    all: 'За сутки ничего не нашлось. Каналы добавляются во вкладке «Каналы», а акции появляются сами, загляните позже.',
    channels: 'Постов из ваших каналов за сутки нет. Добавьте каналы во вкладке «Каналы».',
    freebies: 'Акций за сутки пока нет. Они появляются сами, загляните позже. Если вы отметили магазины или категории в настройках халявы, показываю только их.',
  };
  const DEAL_STATUS = { live: ['Живая', 'live'], maybe_over: ['Могла закончиться', 'maybe'], expired: ['Закончилась', 'over'] };
  const REASON = {
    ok: 'Пришла бы сейчас',
    held: 'Придержали бы',
    filtered: 'Не подходит под ваши настройки',
    expired: 'Уже устарела',
    already_sent: 'Уже присылали',
    muted: 'Нашлась при первой проверке источника, такие не рассылаем',
  };

  const safeHref = (url) => (/^https?:\/\//i.test(url) ? url : '#');
  const labelOf = (list, code) => (list.find((x) => x.code === code) || {}).label || code;
  const clock = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const showBanner = (id, message) => {
    byId(id).textContent = message;
    byId(id).hidden = !message;
  };

  function agoText(unix) {
    const min = Math.max(0, Math.floor((Date.now() / 1000 - unix) / 60));
    if (min < 1) return 'только что';
    if (min < 60) return `${min} мин назад`;
    return min < 1440 ? `${Math.floor(min / 60)} ч назад` : `${Math.floor(min / 1440)} дн назад`;
  }

  // Пока адрес не готов (404), берём примеры из freebies-mock.js и говорим об этом на странице.
  async function fapi(path, options) {
    try {
      return await api(path, options);
    } catch (error) {
      if (!window.freebiesMock || !/\(404\)/.test(error.message)) throw error;
      document.querySelectorAll('.mock-note').forEach((n) => (n.hidden = false));
      return window.freebiesMock(path, options);
    }
  }

  const chip = (text, selected, onclick) =>
    el('button', { class: 'chip' + (selected ? ' is-selected' : ''), type: 'button', role: 'radio', 'aria-checked': String(selected), onclick }, text);

  // ---------- карточки: у поста и акции одна рамка, у каждой метка вида ----------

  function cardHead(kind, title, at) {
    return el('div', { class: 'item-card__head' }, [
      el('span', {}, [el('span', { class: `kind kind--${kind}`, text: kind === 'deal' ? 'Акция' : 'Пост канала' }), el('span', { class: 'item-card__channel', text: title })]),
      el('span', { text: agoText(at) }),
    ]);
  }

  const sourceLink = (url, text) => el('a', { class: 'item-card__link', href: safeHref(url), target: '_blank', rel: 'noopener', text });

  function postCard(item) {
    return el('div', { class: 'item-card' }, [
      cardHead('post', item.title, item.at),
      el('p', { class: 'item-card__gist', text: item.text }),
      el('div', { class: 'item-card__foot' }, [el('span', { text: `Откуда: ${item.sourceLabel}` }), sourceLink(item.link, 'Открыть в Telegram →')]),
    ]);
  }

  function promoRow(code) {
    const button = el('button', { class: 'btn btn--secondary btn--small', type: 'button' }, 'Копировать');
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = 'Скопировано';
      } catch (_) {
        button.textContent = 'Выделите и скопируйте'; // нет доступа к буферу обмена: код выделяется по клику
      }
      setTimeout(() => (button.textContent = 'Копировать'), 2000);
    });
    return el('div', { class: 'promo' }, [el('code', { class: 'promo__code', text: code }), button]);
  }

  function dealCard(deal) {
    const [statusText, statusClass] = DEAL_STATUS[deal.status] || DEAL_STATUS.maybe_over;
    const store = labelOf(fr.stores, deal.store);
    return el('div', { class: 'item-card item-card--deal' + (deal.status === 'expired' ? ' is-over' : '') }, [
      cardHead('deal', deal.discountText ? `${store} · ${deal.discountText}` : store, deal.publishedAt),
      el('p', { class: 'item-card__gist', text: deal.title }),
      deal.promoCode ? promoRow(deal.promoCode) : el('p', { class: 'item-card__snippet', text: 'Промокод не нужен' }),
      el('div', { class: 'deal-meta' }, [
        el('span', { class: `status status--${statusClass}`, text: statusText }),
        deal.expiresAt ? el('span', { text: `до ${formatMsk(deal.expiresAt)} МСК` }) : null,
        deal.status === 'maybe_over' ? el('span', { text: 'срока нет, прошло больше 15 минут' }) : null,
      ]),
      el('div', { class: 'item-card__foot' }, [
        el('span', {}, ['Откуда: ', sourceLink(deal.sourceUrl, deal.sourceTitle)]),
        el('a', { class: 'btn btn--primary btn--small', href: safeHref(deal.url), target: '_blank', rel: 'noopener' }, 'Открыть'),
      ]),
    ]);
  }

  // ---------- профиль: что показывать ----------

  function applyProfile() {
    const profile = fr.settings.profile;
    const unchosen = profile === null;
    byId('profileScreen').hidden = !unchosen;
    document.querySelector('.app').hidden = unchosen;
    byId('profileSelect').value = profile || 'both';
    document.querySelector('[data-tab="freebies"]').hidden = profile === 'news';
    byId('feedSwitcher').hidden = profile === 'news';
  }

  async function chooseProfile(profile) {
    try {
      const { settings } = await fapi('/api/freebies/settings', { method: 'PATCH', body: JSON.stringify({ profile }) });
      fr.settings = settings;
      fr.kind = profile === 'freebies' ? 'freebies' : 'all';
      if (profile === 'news' && byId('tab-freebies').classList.contains('is-active')) switchTab('feed');
      renderSwitcher();
      loadFeed();
    } catch (error) {
      showBanner('profileError', error.message);
      showBanner('feedError', error.message);
    }
    applyProfile();
  }

  // ---------- общая лента ----------

  const feedKind = () => (fr.settings.profile === 'news' ? 'channels' : fr.kind);

  function renderSwitcher() {
    byId('feedSwitcher').replaceChildren(
      ...Object.entries(KIND_LABELS).map(([kind, text]) => chip(text, fr.kind === kind, () => { fr.kind = kind; renderSwitcher(); loadFeed(); }))
    );
  }

  async function loadFeed() {
    const kind = feedKind();
    showBanner('feedError', '');
    try {
      const { items } = await fapi(`/api/feed?kind=${kind}&limit=50`);
      byId('feedList').replaceChildren(...items.map((i) => (i.kind === 'deal' && i.deal ? dealCard(i.deal) : postCard(i))));
      byId('feedEmpty').textContent = FEED_EMPTY[kind];
      byId('feedEmpty').hidden = items.length > 0;
      byId('feedUpdated').textContent = `За последние сутки · обновлено в ${clock()}`;
    } catch (error) {
      showBanner('feedError', error.message);
    }
  }

  // ---------- вкладка «Халява» ----------

  async function loadSettings() {
    const data = await fapi('/api/freebies/settings');
    fr.settings = data.settings;
    fr.stores = data.stores;
    fr.categories = data.categories;
  }

  async function loadDeals() {
    byId('storeFilter').replaceChildren(
      ...[{ code: '', label: 'Все магазины' }, ...fr.stores].map((s) => chip(s.label, fr.store === s.code, () => { fr.store = s.code; loadDeals(); }))
    );
    showBanner('dealsError', '');
    try {
      const { deals } = await fapi(`/api/freebies/deals?limit=50${fr.store ? `&store=${encodeURIComponent(fr.store)}` : ''}`);
      byId('dealsList').replaceChildren(...deals.map(dealCard));
      byId('dealsEmpty').hidden = deals.length > 0;
    } catch (error) {
      showBanner('dealsError', error.message);
    }
  }

  async function loadBotHint() {
    const status = byId('frBotStatus');
    try {
      const bot = await api('/api/alerts/bot');
      const ok = bot.configured && bot.linked && bot.status === 'active';
      byId('frBotBtn').hidden = ok || !bot.configured;
      status.textContent = !bot.configured
        ? 'Бот не настроен на сервере: акции пока не отправляются.'
        : ok
          ? `Бот подключён: акции приходят в @${bot.botUsername}.`
          : 'Бот не подключён (не привязан или заблокирован), акциям некуда приходить. Во вкладке «Алерты» нажмите «Получать алерты» и запустите бота, потом вернитесь сюда.';
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function readSettings(form) {
    const f = (name) => form.querySelector(`[data-f="${name}"]`);
    const picked = (kind) => [...form.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((i) => i.value);
    return {
      alertsEnabled: f('alertsEnabled').checked,
      stores: picked('store'),
      categories: picked('category'),
      onlyWithPromo: f('onlyWithPromo').checked,
      minDiscount: Number(f('minDiscount').value),
      breakQuiet: f('breakQuiet').checked,
      quietEnabled: f('quietEnabled').checked,
      quietFrom: f('quietFrom').value,
      quietTo: f('quietTo').value,
      maxPerDay: Number(f('maxPerDay').value),
    };
  }

  function renderSettings() {
    const s = fr.settings;
    const hint = (text) => el('p', { class: 'field__hint', text });
    const check = (f, checked, text) => checkboxEl({ 'data-f': f }, checked, text);
    const checks = (kind, list, picked) =>
      el('div', { class: 'checks checks--row' }, list.map((x) => checkboxEl({ 'data-kind': kind, value: x.code }, picked.includes(x.code), x.label)));
    const num = (f, value, min, max) => el('input', { class: 'text-input text-input--num', type: 'number', 'data-f': f, value: String(value), min, max });
    const time = (f, value, label) => el('input', { class: 'text-input text-input--time', type: 'time', 'data-f': f, value, 'aria-label': label });
    const inline = (label, control) => el('div', { class: 'field field--inline' }, [el('span', { class: 'field__label', text: label }), control]);

    const alertsSwitch = switchControl(s.alertsEnabled, 'Присылать акции в Telegram', () => {});
    alertsSwitch.querySelector('input').dataset.f = 'alertsEnabled';
    const botButton = el('button', { id: 'frBotBtn', class: 'btn btn--secondary', type: 'button', hidden: 'hidden', onclick: () => switchTab('alerts') }, 'Привязать бота');
    const saveStatus = el('span', { class: 'actions__status', role: 'status' });

    const form = el('div', {}, [
      el('div', { class: 'setting-row' }, [
        el('div', {}, [el('div', { class: 'setting-row__title', text: 'Присылать акции в Telegram' }), el('p', { id: 'frBotStatus', class: 'field__hint', text: 'Проверяю…' }), botButton]),
        alertsSwitch,
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: 'Магазины' }),
        checks('store', fr.stores, s.stores),
        hint('Ничего не отмечено: присылаю из всех магазинов.'),
      ]),
      el('div', { class: 'field' }, [
        el('span', { class: 'field__label', text: 'Категории' }),
        checks('category', fr.categories, s.categories),
        hint('Ничего не отмечено: присылаю из всех категорий.'),
      ]),
      el('div', { class: 'field' }, [check('onlyWithPromo', s.onlyWithPromo, 'Только акции с промокодом')]),
      inline('Скидка не меньше, % (0: любая)', num('minDiscount', s.minDiscount, 0, 90)),
      el('div', { class: 'field' }, [
        el('label', { class: 'checkbox' }, [
          el('input', { type: 'checkbox', 'data-f': 'quietEnabled', ...(s.quietEnabled ? { checked: 'checked' } : {}) }),
          ' Тихие часы с ',
          time('quietFrom', s.quietFrom, 'Начало тихих часов'),
          ' до ',
          time('quietTo', s.quietTo, 'Конец тихих часов'),
        ]),
        hint('Время московское. Ночью халява не копится, утром придёт только то, у чего срок ещё не вышел.'),
      ]),
      el('div', { class: 'field' }, [
        check('breakQuiet', s.breakQuiet, 'Халява пробивает тихие часы'),
        hint('Включите, и акции придут даже ночью. Пауза в боте всё равно останавливает всё.'),
      ]),
      inline('Не больше акций в день', num('maxPerDay', s.maxPerDay, 1, 100)),
      saveStatus,
    ]);

    // Автосохранение через 400 мс, как в темах алертов; числа возвращаем в форму такими, какими их принял сервер.
    let timer = null;
    form.addEventListener('change', () => {
      saveStatus.textContent = '';
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const { settings } = await fapi('/api/freebies/settings', { method: 'PATCH', body: JSON.stringify(readSettings(form)) });
          fr.settings = settings;
          form.querySelector('[data-f="minDiscount"]').value = settings.minDiscount;
          form.querySelector('[data-f="maxPerDay"]').value = settings.maxPerDay;
          saveStatus.textContent = 'Сохранено';
        } catch (error) {
          saveStatus.textContent = `Не сохранилось: ${error.message}`;
        }
      }, 400);
    });
    byId('freebiesSettings').replaceChildren(form);
  }

  async function loadFreebiesTab() {
    try {
      await loadSettings();
      renderSettings();
    } catch (error) {
      showBanner('dealsError', error.message);
    }
    loadDeals();
    loadBotHint();
  }

  async function runPreview(event) {
    const button = event.currentTarget;
    const out = byId('frPreviewOut');
    out.replaceChildren();
    button.disabled = true;
    button.textContent = 'Проверяю…';
    try {
      const { results, alertsEnabled, botLinked } = await fapi('/api/freebies/preview', { method: 'POST', body: JSON.stringify({ minutes: 60 }) });
      const notes = [];
      if (!alertsEnabled) notes.push('Алерты халявы выключены: на самом деле ничего не придёт.');
      if (!botLinked) notes.push('Бот не привязан: отправлять некуда.');
      out.replaceChildren(
        ...notes.map((text) => el('div', { class: 'banner banner--warn', text })),
        results.length ? null : el('p', { class: 'empty-state', text: 'За последний час акций не нашлось.' }),
        ...results.map((r) => {
          const reason = r.reason === 'held' && r.holdUntil ? `${REASON.held} до ${formatMsk(r.holdUntil)} МСК` : REASON[r.reason] || r.reason;
          return el('div', { class: 'preview' }, [
            el('div', { class: 'preview__head' }, [
              el('span', { class: 'preview__topic', text: `${labelOf(fr.stores, r.deal.store)}: ${r.deal.title}` }),
              el('span', { class: 'preview__status' + (r.wouldSend ? ' is-yes' : ''), text: reason }),
            ]),
          ]);
        })
      );
    } catch (error) {
      out.replaceChildren(el('div', { class: 'banner banner--error', text: error.message }));
    } finally {
      button.disabled = false;
      button.textContent = 'Проверить сейчас';
    }
  }

  // ---------- старт: вызывается из showApp() после входа ----------

  function bindOnce() {
    if (fr.bound) return;
    fr.bound = true;
    document.querySelector('[data-tab="feed"]').addEventListener('click', loadFeed);
    document.querySelector('[data-tab="freebies"]').addEventListener('click', loadFreebiesTab);
    byId('feedRefreshBtn').addEventListener('click', loadFeed);
    byId('profileSelect').addEventListener('change', (e) => chooseProfile(e.target.value));
    document.querySelectorAll('[data-profile]').forEach((b) => b.addEventListener('click', () => chooseProfile(b.dataset.profile)));
    byId('frPreviewBtn').addEventListener('click', runPreview);
    // Вернулись из Telegram после привязки бота — обновить статус.
    window.addEventListener('focus', () => {
      if (byId('tab-freebies').classList.contains('is-active')) loadBotHint();
    });
  }

  window.initFreebies = async function initFreebies() {
    bindOnce();
    try {
      await loadSettings();
    } catch (error) {
      showBanner('feedError', error.message);
      return;
    }
    fr.kind = fr.settings.profile === 'freebies' ? 'freebies' : 'all';
    applyProfile();
    renderSwitcher();
    if (fr.settings.profile !== null) loadFeed();
  };
})();
