// Ванильный JS без зависимостей — страница может позже переехать в Telegram
// мини-апп без переписывания. Все данные с сервера и из Telegram считаются
// недоверенными: везде используется textContent, а не innerHTML с подстановкой.

const state = {
  windowOptions: [],
  selectedWindowMinutes: null,
  channels: [],
  searching: false,
  authMode: 'login', // 'login' | 'register' — один и тот же экран/форма на оба режима
  groups: [],
  channelQuery: '',
};

// ---------- маленький DOM-хелпер ----------

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {
    // тело может быть пустым, например у DELETE (204)
  }
  if (!res.ok) {
    const message = (data && data.error) || `Ошибка запроса (${res.status})`;
    if (res.status === 401) showAuthScreen(); // сессия истекла/не залогинен — вернуть на вход
    throw new Error(message);
  }
  return data;
}

// ---------- вход/регистрация ----------

function showAuthScreen() {
  document.getElementById('authScreen').hidden = false;
  document.querySelector('.app').hidden = true;
}

function showApp(username) {
  document.getElementById('authScreen').hidden = true;
  document.querySelector('.app').hidden = false;
  document.getElementById('accountUsername').textContent = username;
}

function setAuthMode(mode) {
  state.authMode = mode;
  document.getElementById('authSubmitBtn').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
  document.getElementById('authToggleBtn').textContent =
    mode === 'login' ? 'Нет аккаунта? Зарегистрироваться' : 'Уже есть аккаунт? Войти';
  document.getElementById('authError').hidden = true;
}

document.getElementById('authToggleBtn').addEventListener('click', () => {
  setAuthMode(state.authMode === 'login' ? 'register' : 'login');
});

async function submitAuth() {
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const errorEl = document.getElementById('authError');
  const btn = document.getElementById('authSubmitBtn');
  errorEl.hidden = true;

  btn.disabled = true;
  try {
    const user = await api(`/api/${state.authMode === 'login' ? 'login' : 'register'}`, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    document.getElementById('authPassword').value = '';
    showApp(user.username);
    await Promise.all([loadWindowOptions(), loadChannels()]);
    await loadTelegramAccountStatus();
  } catch (error) {
    errorEl.textContent = error.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('authSubmitBtn').addEventListener('click', submitAuth);
document.getElementById('authPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitAuth();
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
  showAuthScreen();
});

// ---------- вкладки ----------

document.querySelectorAll('.tabs__btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  document.querySelectorAll('.tabs__btn').forEach((b) => {
    const active = b.dataset.tab === name;
    b.classList.toggle('is-active', active);
    b.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.id === `tab-${name}`));
  if (name === 'alerts') loadAlerts();
}

// ---------- период (чипы) ----------

async function loadWindowOptions() {
  state.windowOptions = await api('/api/time-windows');
  const container = document.getElementById('windowOptions');
  container.innerHTML = '';
  state.windowOptions.forEach((opt) => {
    const chip = el('button', {
      class: 'chip',
      type: 'button',
      role: 'radio',
      'aria-checked': 'false',
      onclick: () => selectWindow(opt.minutes),
    }, opt.label);
    chip.dataset.minutes = String(opt.minutes);
    container.appendChild(chip);
  });
  const defaultOption = state.windowOptions.find((o) => o.minutes === 60) || state.windowOptions[0];
  if (defaultOption) selectWindow(defaultOption.minutes);
}

function selectWindow(minutes) {
  state.selectedWindowMinutes = minutes;
  document.querySelectorAll('#windowOptions .chip').forEach((chip) => {
    const isSelected = Number(chip.dataset.minutes) === minutes;
    chip.classList.toggle('is-selected', isSelected);
    chip.setAttribute('aria-checked', String(isSelected));
  });
}

// ---------- каналы и группы ----------

const groupById = (id) => state.groups.find((g) => g.id === id);

// Тот же смысл, что и view monitored_channels на сервере: канал включён
// и он либо без группы, либо его группа включена.
function isMonitored(channel) {
  const group = channel.groupId != null ? groupById(channel.groupId) : null;
  return channel.isActive && (!group || group.isActive);
}

async function loadChannels() {
  [state.channels, state.groups] = await Promise.all([api('/api/channels'), api('/api/groups')]);
  renderChannels();
  updateSearchAvailability();
}

const channelPath = (username) => `/api/channels/${encodeURIComponent(username.replace('@', ''))}`;
const jsonBody = (data) => ({ body: JSON.stringify(data) });

/** Любое изменение каналов/групп: выполнить, показать ошибку если была, перечитать список. */
async function mutateChannels(action) {
  const banner = document.getElementById('channelsError');
  banner.hidden = true;
  try {
    await action();
  } catch (error) {
    banner.textContent = error.message;
    banner.hidden = false;
  }
  await loadChannels();
}

function switchControl(checked, label, onChange) {
  return el('label', { class: 'switch' }, [
    el('input', {
      type: 'checkbox',
      'aria-label': label,
      ...(checked ? { checked: 'checked' } : {}),
      onchange: (e) => onChange(e.target.checked),
    }),
    el('span', { class: 'switch__track' }),
  ]);
}

// Удаление в два клика вместо блокирующего confirm(): первый клик просит
// подтвердить, второй в течение 3 секунд — выполняет.
function confirmButton(label, action) {
  const button = el('button', { class: 'btn btn--danger', type: 'button' }, label);
  let timer = null;
  button.addEventListener('click', () => {
    if (!timer) {
      button.textContent = 'Точно?';
      timer = setTimeout(() => {
        timer = null;
        button.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    action();
  });
  return button;
}

const includesText = (text, query) => (text || '').toLowerCase().includes(query);

function renderChannels() {
  const tree = document.getElementById('channelsTree');
  const query = state.channelQuery.trim().toLowerCase();
  document.getElementById('channelsCount').textContent = state.channels.length ? `(${state.channels.length})` : '';
  tree.innerHTML = '';

  const sections = [
    ...state.groups.map((group) => ({ group, channels: state.channels.filter((c) => c.groupId === group.id) })),
    { group: null, channels: state.channels.filter((c) => c.groupId == null) },
  ];

  let shown = 0;
  for (const { group, channels } of sections) {
    if (!group && channels.length === 0) continue; // пустой раздел «Без группы» не показываем
    // Поиск по названию группы показывает её целиком, иначе — только совпавшие каналы.
    const groupMatched = !query || (group && includesText(group.name, query));
    const visible = groupMatched
      ? channels
      : channels.filter((c) => includesText(c.title, query) || includesText(c.username, query));
    if (!groupMatched && visible.length === 0) continue;
    tree.appendChild(renderGroup(group, visible, channels.length));
    shown++;
  }

  const hasAnything = state.channels.length > 0 || state.groups.length > 0;
  document.getElementById('channelsEmpty').hidden = hasAnything;
  document.getElementById('channelsNoMatch').hidden = !query || shown > 0;
}

function renderGroup(group, channels, total) {
  const off = Boolean(group && !group.isActive);
  const head = group
    ? el('div', { class: 'group__head' }, [
        el('button', {
          class: 'group__name',
          type: 'button',
          title: 'Переименовать',
          onclick: (e) => startRename(e.currentTarget, group),
        }, group.name),
        el('span', { class: 'group__count', text: String(total) }),
        switchControl(group.isActive, `Мониторинг группы «${group.name}»`, (on) =>
          mutateChannels(() => api(`/api/groups/${group.id}`, { method: 'PATCH', ...jsonBody({ isActive: on }) }))
        ),
        confirmButton('Удалить', () => mutateChannels(() => api(`/api/groups/${group.id}`, { method: 'DELETE' }))),
      ])
    : el('div', { class: 'group__head' }, [el('span', { class: 'group__name group__name--plain', text: 'Без группы' })]);

  const list = el('ul', { class: 'channels-list' }, channels.map((c) => renderChannelRow(c, off)));
  if (group && total === 0) {
    list.appendChild(el('li', { class: 'group__note', text: 'Пусто. Выберите эту группу в строке нужного канала.' }));
  }
  return el('section', { class: 'group' + (off ? ' is-off' : '') }, [
    head,
    off ? el('p', { class: 'group__note', text: 'Группа выключена — её каналы не мониторятся.' }) : null,
    list,
  ]);
}

function renderChannelRow(channel, groupOff) {
  const name = channel.title || channel.username;
  const groupSelect = el('select', {
    class: 'select',
    'aria-label': `Группа канала ${name}`,
    onchange: (e) =>
      mutateChannels(() =>
        api(channelPath(channel.username), {
          method: 'PATCH',
          ...jsonBody({ groupId: e.target.value ? Number(e.target.value) : null }),
        })
      ),
  }, [
    el('option', { value: '' }, 'Без группы'),
    ...state.groups.map((g) =>
      el('option', { value: String(g.id), ...(g.id === channel.groupId ? { selected: 'selected' } : {}) }, g.name)
    ),
  ]);

  return el('li', { class: 'channel-row' + (channel.isActive && !groupOff ? '' : ' is-off') }, [
    el('div', { class: 'channel-row__info' }, [
      el('div', { class: 'channel-row__title', text: name }),
      el('div', { class: 'channel-row__username', text: channel.isPrivate ? 'приватный канал' : channel.username }),
    ]),
    el('div', { class: 'channel-row__actions' }, [
      state.groups.length ? groupSelect : null,
      switchControl(channel.isActive, `Мониторинг канала ${name}`, (on) =>
        mutateChannels(() => api(channelPath(channel.username), { method: 'PATCH', ...jsonBody({ isActive: on }) }))
      ),
      confirmButton('Удалить', () => mutateChannels(() => api(channelPath(channel.username), { method: 'DELETE' }))),
    ]),
  ]);
}

function startRename(button, group) {
  const input = el('input', {
    class: 'text-input text-input--inline',
    value: group.name,
    maxlength: '60',
    'aria-label': 'Новое название группы',
  });
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== group.name) {
      mutateChannels(() => api(`/api/groups/${group.id}`, { method: 'PATCH', ...jsonBody({ name }) }));
    } else {
      renderChannels();
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  button.replaceWith(input);
  input.focus();
  input.select();
}

document.getElementById('channelSearch').addEventListener('input', (e) => {
  state.channelQuery = e.target.value;
  renderChannels();
});

document.getElementById('newGroupBtn').addEventListener('click', (e) => {
  const form = document.getElementById('groupForm');
  form.hidden = !form.hidden;
  e.currentTarget.setAttribute('aria-expanded', String(!form.hidden));
  if (!form.hidden) document.getElementById('groupNameInput').focus();
});

async function addGroup() {
  const input = document.getElementById('groupNameInput');
  const error = document.getElementById('groupError');
  error.hidden = true;
  try {
    await api('/api/groups', { method: 'POST', ...jsonBody({ name: input.value }) });
    input.value = '';
    document.getElementById('groupForm').hidden = true;
    document.getElementById('newGroupBtn').setAttribute('aria-expanded', 'false');
    await loadChannels();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
}
document.getElementById('addGroupBtn').addEventListener('click', addGroup);
document.getElementById('groupNameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addGroup();
});

const addChannelBtn = document.getElementById('addChannelBtn');
const channelInput = document.getElementById('channelInput');
const addChannelError = document.getElementById('addChannelError');

addChannelBtn.addEventListener('click', addChannel);
channelInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addChannel();
});

async function addChannel() {
  const value = channelInput.value.trim();
  addChannelError.hidden = true;
  if (!value) return;

  addChannelBtn.disabled = true;
  addChannelBtn.textContent = 'Добавляю…';
  try {
    await api('/api/channels', { method: 'POST', ...jsonBody({ username: value }) });
    channelInput.value = '';
    await loadChannels();
  } catch (error) {
    addChannelError.textContent = error.message;
    addChannelError.hidden = false;
  } finally {
    addChannelBtn.disabled = false;
    addChannelBtn.textContent = 'Добавить';
  }
}

// ---------- личный Telegram-аккаунт (приватные каналы) ----------

function tgShowStep(step) {
  document.getElementById('tgStepPhone').hidden = step !== 'phone';
  document.getElementById('tgStepCode').hidden = step !== 'code';
  document.getElementById('tgStepPassword').hidden = step !== 'password';
  document.getElementById('tgError').hidden = true;
}

async function loadTelegramAccountStatus() {
  const { connected } = await api('/api/telegram/status');
  document.getElementById('tgNotConnected').hidden = connected;
  document.getElementById('tgConnected').hidden = !connected;
  if (connected) {
    await loadPrivateDialogs();
  } else {
    tgShowStep('phone');
  }
}

function tgError(message) {
  const el = document.getElementById('tgError');
  el.textContent = message;
  el.hidden = false;
}

document.getElementById('tgSendCodeBtn').addEventListener('click', async () => {
  const phone = document.getElementById('tgPhone').value.trim();
  try {
    await api('/api/telegram/connect/start', { method: 'POST', body: JSON.stringify({ phone }) });
    tgShowStep('code');
  } catch (error) {
    tgError(error.message);
  }
});

async function tgSubmitCode() {
  const code = document.getElementById('tgCode').value.trim();
  try {
    const result = await api('/api/telegram/connect/code', { method: 'POST', body: JSON.stringify({ code }) });
    if (result.status === 'needs_password') {
      tgShowStep('password');
    } else {
      await loadTelegramAccountStatus();
    }
  } catch (error) {
    tgError(error.message);
  }
}
document.getElementById('tgConfirmCodeBtn').addEventListener('click', tgSubmitCode);

async function tgSubmitPassword() {
  const password = document.getElementById('tgPassword').value;
  try {
    await api('/api/telegram/connect/password', { method: 'POST', body: JSON.stringify({ password }) });
    await loadTelegramAccountStatus();
  } catch (error) {
    tgError(error.message);
  }
}
document.getElementById('tgConfirmPasswordBtn').addEventListener('click', tgSubmitPassword);

async function tgCancel() {
  await api('/api/telegram/connect/cancel', { method: 'POST' });
  document.getElementById('tgPhone').value = '';
  document.getElementById('tgCode').value = '';
  document.getElementById('tgPassword').value = '';
  tgShowStep('phone');
}
document.getElementById('tgCancelBtn').addEventListener('click', tgCancel);
document.getElementById('tgCancelBtn2').addEventListener('click', tgCancel);

document.getElementById('tgDisconnectBtn').addEventListener('click', async () => {
  await api('/api/telegram/disconnect', { method: 'POST' });
  await loadTelegramAccountStatus();
});

async function loadPrivateDialogs() {
  const dialogs = await api('/api/telegram/private-dialogs');
  const list = document.getElementById('privateDialogsList');
  const empty = document.getElementById('privateDialogsEmpty');
  const alreadyAdded = new Set(state.channels.map((c) => c.username));
  const available = dialogs.filter((d) => !alreadyAdded.has(d.id));

  list.innerHTML = '';
  empty.hidden = available.length > 0;
  for (const dialog of available) {
    const addBtn = el('button', { class: 'btn btn--primary', type: 'button' }, 'Добавить');
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      try {
        await api('/api/channels/private', { method: 'POST', body: JSON.stringify({ id: dialog.id, title: dialog.title }) });
        await loadChannels();
        await loadPrivateDialogs();
      } catch (error) {
        alert(error.message);
        addBtn.disabled = false;
      }
    });
    list.appendChild(
      el('li', { class: 'channel-row' }, [
        el('div', { class: 'channel-row__info' }, [el('div', { class: 'channel-row__title', text: dialog.title })]),
        el('div', { class: 'channel-row__actions' }, [addBtn]),
      ])
    );
  }
}

function updateSearchAvailability() {
  const hasActive = state.channels.some(isMonitored);
  const hint = document.getElementById('searchHint');
  const btn = document.getElementById('searchBtn');
  if (!hasActive) {
    hint.hidden = false;
    hint.textContent = 'Нет ни одного включённого канала — добавьте канал во вкладке «Каналы»';
    btn.disabled = true;
  } else {
    hint.hidden = true;
    btn.disabled = state.searching;
  }
}

// ---------- поиск/анализ ----------

const searchBtn = document.getElementById('searchBtn');
const topicInput = document.getElementById('topicInput');

searchBtn.addEventListener('click', runSearch);
topicInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') runSearch();
});

async function runSearch() {
  const topic = topicInput.value.trim();
  const errorBanner = document.getElementById('errorBanner');
  errorBanner.hidden = true;

  if (!topic) {
    errorBanner.textContent = 'Введите тему запроса';
    errorBanner.hidden = false;
    return;
  }
  if (!state.selectedWindowMinutes) {
    errorBanner.textContent = 'Выберите период';
    errorBanner.hidden = false;
    return;
  }

  setSearching(true);
  clearResults();

  try {
    const result = await api('/api/analyze', {
      method: 'POST',
      body: JSON.stringify({ topic, windowMinutes: state.selectedWindowMinutes }),
    });
    renderResult(result);
  } catch (error) {
    errorBanner.textContent = error.message;
    errorBanner.hidden = false;
  } finally {
    setSearching(false);
  }
}

function setSearching(isSearching) {
  state.searching = isSearching;
  document.getElementById('loading').hidden = !isSearching;
  searchBtn.disabled = isSearching;
  searchBtn.textContent = isSearching ? 'Ищу…' : 'Найти новости';
}

function clearResults() {
  document.getElementById('resultMeta').hidden = true;
  document.getElementById('summaryCard').hidden = true;
  document.getElementById('itemsList').innerHTML = '';
  document.getElementById('emptyState').hidden = true;
}

function renderResult(result) {
  const meta = document.getElementById('resultMeta');
  const metaParts = [
    `Проверено каналов: ${result.channelsChecked}`,
    `постов за период: ${result.postsInWindow}`,
    `отправлено в ИИ: ${result.postsSentToAi}`,
  ];
  if (result.usedKeywordFallback && result.postsInWindow > 0) {
    metaParts.push('точных совпадений по словам не нашлось — ИИ проверил все посты за период');
  }
  meta.textContent = metaParts.join(' · ');
  meta.hidden = false;

  if (result.channelErrors && result.channelErrors.length > 0) {
    const banner = document.getElementById('errorBanner');
    const text = result.channelErrors.map((e) => `${e.channel}: ${e.error}`).join('; ');
    banner.textContent = `Не удалось прочитать некоторые каналы — ${text}`;
    banner.hidden = false;
  }

  const items = result.items || [];
  if (items.length === 0) {
    document.getElementById('emptyState').hidden = false;
    document.getElementById('summaryCard').hidden = true;
    return;
  }

  document.getElementById('summaryText').textContent = result.summary;
  document.getElementById('summaryCard').hidden = false;

  const list = document.getElementById('itemsList');
  list.innerHTML = '';
  for (const item of items) {
    const card = el('div', { class: 'item-card' }, [
      el('div', { class: 'item-card__head' }, [
        el('span', { class: 'item-card__channel', text: item.channelTitle || item.channel }),
        el('span', { text: item.postedAtFormatted }),
      ]),
      el('p', { class: 'item-card__gist', text: item.gist }),
      el('p', { class: 'item-card__snippet', text: truncate(item.text, 280) }),
      el('a', { class: 'item-card__link', href: item.link, target: '_blank', rel: 'noopener', text: 'Открыть в Telegram →' }),
    ]);
    list.appendChild(card);
  }
}

function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).trimEnd() + '…';
}

// ---------- алерты ----------

const ALERT_INTERVAL_LABELS = {
  15: 'каждые 15 минут',
  30: 'каждые 30 минут',
  60: 'каждый час',
  180: 'каждые 3 часа',
  300: 'каждые 5 часов',
  600: 'каждые 10 часов',
  1440: 'раз в сутки',
};
const DIGEST_LABELS = {
  0: 'сразу, как нашлось',
  1: 'сводкой раз в час',
  3: 'сводкой раз в 3 часа',
  6: 'сводкой раз в 6 часов',
  12: 'сводкой раз в 12 часов',
  24: 'сводкой раз в сутки',
};
const LOUD_LABELS = { urgent: 'только срочное', important: 'важное и срочное', normal: 'всё' };

const byId = (id) => document.getElementById(id);
const formatMsk = (unix) =>
  new Date(unix * 1000).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

async function loadAlerts() {
  showAlertsError('');
  try {
    const [topics, groups, channels] = await Promise.all([api('/api/alerts/topics'), api('/api/groups'), api('/api/channels'), loadBotStatus()]);
    state.groups = groups;
    state.channels = channels;
    renderTopics(topics);
  } catch (error) {
    showAlertsError(error.message);
  }
}

function showAlertsError(message) {
  byId('alertsError').textContent = message;
  byId('alertsError').hidden = !message;
}

// ---------- бот: статус и привязка ----------

async function loadBotStatus() {
  const bot = await api('/api/alerts/bot');
  const status = byId('botStatus');
  const button = byId('botLinkBtn');
  button.hidden = !bot.configured || (bot.linked && bot.status === 'active');
  button.textContent = bot.linked ? 'Подключить заново' : 'Получать алерты';
  if (!bot.configured) {
    status.textContent = 'Бот не настроен на сервере (нет TELEGRAM_BOT_TOKEN) — алерты пока не отправляются.';
  } else if (!bot.linked) {
    status.textContent =
      `Не подключён — алертам некуда приходить. Нажмите «Получать алерты» и запустите @${bot.botUsername}. ` +
      'Если вы подключали на сайте свой Telegram-аккаунт, можно просто написать боту /start.';
  } else if (bot.status !== 'active') {
    status.textContent = 'Вы заблокировали бота в Telegram — алерты не приходят. Разблокируйте его или подключите заново.';
  } else {
    const paused = bot.pausedUntil && bot.pausedUntil * 1000 > Date.now();
    status.textContent = `Подключён: алерты приходят в @${bot.botUsername}` + (paused ? ` · пауза до ${formatMsk(bot.pausedUntil)} МСК` : '');
  }
}

byId('botLinkBtn').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const hint = byId('botLinkHint');
  button.disabled = true;
  try {
    const { url } = await api('/api/alerts/bot-link', { method: 'POST' });
    window.open(url, '_blank', 'noopener');
    hint.replaceChildren(
      'Откройте ссылку в Telegram и нажмите «Запустить». Ссылка одноразовая и действует 15 минут: ',
      el('a', { href: url, target: '_blank', rel: 'noopener' }, url)
    );
    hint.hidden = false;
  } catch (error) {
    showAlertsError(error.message);
  } finally {
    button.disabled = false;
  }
});

// Вернулись из Telegram — обновить статус привязки.
window.addEventListener('focus', () => {
  if (byId('tab-alerts').classList.contains('is-active')) loadBotStatus().catch(() => {});
});

// ---------- темы (подписки) со своими настройками ----------

const topicSummary = (s) =>
  `${ALERT_INTERVAL_LABELS[s.intervalMinutes]} · ${DIGEST_LABELS[s.digestHours] ?? `сводкой раз в ${s.digestHours} ч`} · звук: ${LOUD_LABELS[s.loudFrom]}`;

function selectEl(field, labels, current) {
  return el(
    'select',
    { class: 'select', 'data-f': field },
    Object.entries(labels).map(([value, label]) => el('option', { value, ...(String(current) === value ? { selected: 'selected' } : {}) }, label))
  );
}

const checkboxEl = (attrs, checked, label) =>
  el('label', { class: 'checkbox' }, [el('input', { type: 'checkbox', ...attrs, ...(checked ? { checked: 'checked' } : {}) }), ` ${label}`]);

function topicSettingsForm(topic) {
  const s = topic.settings;
  const scopeName = `scope-${topic.id}`;
  const radio = (value, label) =>
    el('label', { class: 'radio' }, [el('input', { type: 'radio', name: scopeName, value, ...(s.scope === value ? { checked: 'checked' } : {}) }), ` ${label}`]);

  const groupsBox = el(
    'div',
    { class: 'checks', 'data-box': 'groups' },
    state.groups.length
      ? state.groups.map((g) => checkboxEl({ 'data-kind': 'group', value: String(g.id) }, s.groupIds.includes(g.id), g.name))
      : el('p', { class: 'field__hint', text: 'Групп пока нет — создайте их во вкладке «Каналы».' })
  );
  const channelsBox = el(
    'div',
    { class: 'checks', 'data-box': 'channels' },
    state.channels.length
      ? state.channels.map((c) =>
          checkboxEl({ 'data-kind': 'channel', value: c.username }, s.channels.includes(c.username), `${c.title || c.username}${c.isPrivate ? ' 🔒' : ''}`)
        )
      : el('p', { class: 'field__hint', text: 'Каналов пока нет — добавьте их во вкладке «Каналы».' })
  );
  const time = (field, value, label) => el('input', { class: 'text-input text-input--time', type: 'time', 'data-f': field, value, 'aria-label': label });
  const num = (field, value, min, max) => el('input', { class: 'text-input text-input--num', type: 'number', 'data-f': field, value: String(value), min, max });
  const inline = (label, control) => el('div', { class: 'field field--inline' }, [el('span', { class: 'field__label', text: label }), control]);

  return el('div', { class: 'topic-card__body', hidden: 'hidden' }, [
    el('div', { class: 'field' }, [
      el('span', { class: 'field__label', text: 'Где искать' }),
      radio('all', 'Во всех отслеживаемых каналах'),
      radio('groups', 'В выбранных группах'),
      groupsBox,
      radio('channels', 'В выбранных каналах'),
      channelsBox,
    ]),
    inline('Проверять', selectEl('intervalMinutes', ALERT_INTERVAL_LABELS, s.intervalMinutes)),
    inline('Присылать', selectEl('digestHours', DIGEST_LABELS, s.digestHours)),
    el('div', { class: 'field' }, [
      el('div', { class: 'field--inline' }, [el('span', { class: 'field__label', text: 'Со звуком' }), selectEl('loudFrom', LOUD_LABELS, s.loudFrom)]),
      el('p', {
        class: 'field__hint',
        text: 'Срочность каждому пункту ставит ИИ. Громкие алерты приходят сразу и со звуком — даже в тихие часы, на паузе и в режиме сводки. Остальные — без звука.',
      }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { class: 'checkbox' }, [
        el('input', { type: 'checkbox', 'data-f': 'quietEnabled', ...(s.quietEnabled ? { checked: 'checked' } : {}) }),
        ' Тихие часы с ',
        time('quietFrom', s.quietFrom, 'Начало тихих часов'),
        ' до ',
        time('quietTo', s.quietTo, 'Конец тихих часов'),
      ]),
      el('p', { class: 'field__hint', text: 'Время московское. Обычное найденное придёт одним сообщением после них.' }),
    ]),
    inline('Присылать, если подтверждённых пунктов не меньше', num('minMatches', s.minMatches, 1, 50)),
    inline('Не больше алертов в день (громкие не ограничиваются)', num('maxPerDay', s.maxPerDay, 1, 100)),
  ]);
}

function readTopicSettings(body, topicId) {
  const f = (name) => body.querySelector(`[data-f="${name}"]`);
  const checkedValues = (kind) => [...body.querySelectorAll(`input[data-kind="${kind}"]:checked`)].map((i) => i.value);
  return {
    scope: body.querySelector(`input[name="scope-${topicId}"]:checked`).value,
    groupIds: checkedValues('group').map(Number),
    channels: checkedValues('channel'),
    intervalMinutes: Number(f('intervalMinutes').value),
    digestHours: Number(f('digestHours').value),
    loudFrom: f('loudFrom').value,
    quietEnabled: f('quietEnabled').checked,
    quietFrom: f('quietFrom').value,
    quietTo: f('quietTo').value,
    minMatches: Number(f('minMatches').value),
    maxPerDay: Number(f('maxPerDay').value),
  };
}

function syncScopeBoxes(body, scope) {
  body.querySelector('[data-box="groups"]').hidden = scope !== 'groups';
  body.querySelector('[data-box="channels"]').hidden = scope !== 'channels';
}

function renderTopicCard(topic) {
  const body = topicSettingsForm(topic);
  syncScopeBoxes(body, topic.settings.scope);
  const meta = el('span', { class: 'topic-card__meta', text: topicSummary(topic.settings) });
  const status = el('span', { class: 'actions__status', role: 'status' });
  const toggle = el('button', { class: 'btn btn--ghost', type: 'button', 'aria-expanded': 'false' }, 'Настройки');
  toggle.addEventListener('click', () => {
    body.hidden = !body.hidden;
    toggle.setAttribute('aria-expanded', String(!body.hidden));
  });

  // Автосохранение: изменения уходят через 400 мс; сервер нормализует значения,
  // числа возвращаем в форму, чтобы вне диапазона ничего не «залипало».
  let saveTimer = null;
  body.addEventListener('change', () => {
    const settings = readTopicSettings(body, topic.id);
    syncScopeBoxes(body, settings.scope);
    status.textContent = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const saved = await api(`/api/alerts/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ settings }) });
        meta.textContent = topicSummary(saved.settings);
        body.querySelector('[data-f="minMatches"]').value = saved.settings.minMatches;
        body.querySelector('[data-f="maxPerDay"]').value = saved.settings.maxPerDay;
        status.textContent = 'Сохранено';
      } catch (error) {
        status.textContent = `Не сохранилось: ${error.message}`;
      }
    }, 400);
  });

  return el('li', { class: 'topic-card' + (topic.isActive ? '' : ' is-off') }, [
    el('div', { class: 'topic' }, [
      el('label', { class: 'checkbox' }, [
        el('input', {
          type: 'checkbox',
          'aria-label': `Тема «${topic.label}» включена`,
          ...(topic.isActive ? { checked: 'checked' } : {}),
          onchange: (e) =>
            mutateTopics(() => api(`/api/alerts/topics/${topic.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: e.target.checked }) })),
        }),
        el('span', {}, [` ${topic.label}`, el('br'), meta]),
      ]),
      el('div', { class: 'topic-card__actions' }, [
        toggle,
        confirmButton('Удалить', () => mutateTopics(() => api(`/api/alerts/topics/${topic.id}`, { method: 'DELETE' }))),
      ]),
    ]),
    body,
    status,
  ]);
}

function renderTopics(topics) {
  const list = byId('topicsList');
  list.innerHTML = '';
  if (topics.length === 0) {
    list.appendChild(el('li', { class: 'topic topic--empty', text: 'Тем пока нет' }));
  }
  for (const topic of topics) list.appendChild(renderTopicCard(topic));
}

async function mutateTopics(action) {
  const error = byId('topicError');
  error.hidden = true;
  try {
    await action();
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
  renderTopics(await api('/api/alerts/topics'));
}

async function addAlertTopic() {
  const input = byId('alertTopicInput');
  if (!input.value.trim()) return;
  await mutateTopics(async () => {
    await api('/api/alerts/topics', { method: 'POST', body: JSON.stringify({ label: input.value }) });
    input.value = '';
  });
}
byId('addTopicBtn').addEventListener('click', addAlertTopic);
byId('alertTopicInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addAlertTopic();
});

// ---------- превью: что пришло бы сейчас ----------

byId('previewAlertsBtn').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const out = byId('alertsPreview');
  showAlertsError('');
  out.innerHTML = '';
  button.disabled = true;
  button.textContent = 'Проверяю…';
  try {
    const { results } = await api('/api/alerts/preview', { method: 'POST' });
    results.forEach((r) => out.appendChild(renderAlertPreview(r)));
  } catch (error) {
    showAlertsError(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Проверить сейчас';
  }
});

const URGENCY_MARK = { urgent: '🔴', important: '🟠', normal: '•' };

function renderAlertPreview(r) {
  const items = r.items || [];
  const rejected = r.rejected ? ` · выкинуто проверкой: ${r.rejected}` : '';
  const status = r.error
    ? `Ошибка: ${r.error}`
    : r.wouldSend
      ? `Пришёл бы алерт · пунктов: ${items.length}${rejected}`
      : `Не пришёл бы · подтверждённых пунктов: ${items.length}, постов в окне: ${r.postsInWindow}${rejected}`;
  return el('div', { class: 'preview' }, [
    el('div', { class: 'preview__head' }, [
      el('span', { class: 'preview__topic', text: r.topic }),
      el('span', { class: 'preview__status' + (r.wouldSend ? ' is-yes' : ''), text: status }),
    ]),
    ...items.map((item) =>
      el('div', { class: 'preview__item' }, [
        el('span', { text: `${URGENCY_MARK[item.urgency] || '•'} ${item.text}` }),
        el(
          'span',
          { class: 'preview__channel' },
          item.sources.slice(0, 5).map((s) =>
            el('a', { class: 'preview__link', href: s.link, target: '_blank', rel: 'noopener' }, `${s.channelTitle || s.channel} · ${formatMsk(s.postedAt)}`)
          )
        ),
      ])
    ),
  ]);
}

// ---------- старт ----------

(async function init() {
  setAuthMode('login');
  try {
    const res = await fetch('/api/me');
    if (!res.ok) {
      showAuthScreen();
      return;
    }
    const user = await res.json();
    showApp(user.username);
    await Promise.all([loadWindowOptions(), loadChannels()]);
    await loadTelegramAccountStatus();
  } catch (error) {
    console.error('Не удалось загрузить страницу:', error);
    showAuthScreen();
  }
})();
