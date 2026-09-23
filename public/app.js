// Ванильный JS без зависимостей — страница может позже переехать в Telegram
// мини-апп без переписывания. Все данные с сервера и из Telegram считаются
// недоверенными: везде используется textContent, а не innerHTML с подстановкой.

const state = {
  windowOptions: [],
  selectedWindowMinutes: null,
  channels: [],
  searching: false,
  authMode: 'login', // 'login' | 'register' — один и тот же экран/форма на оба режима
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
  document.getElementById('tab-search').classList.toggle('is-active', name === 'search');
  document.getElementById('tab-channels').classList.toggle('is-active', name === 'channels');
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

// ---------- каналы ----------

async function loadChannels() {
  state.channels = await api('/api/channels');
  renderChannels();
  updateSearchAvailability();
}

function renderChannels() {
  const list = document.getElementById('channelsList');
  const empty = document.getElementById('channelsEmpty');
  const countBadge = document.getElementById('channelsCount');

  list.innerHTML = '';
  countBadge.textContent = state.channels.length ? `(${state.channels.length})` : '';
  empty.hidden = state.channels.length > 0;

  for (const channel of state.channels) {
    const toggleId = `active-${channel.username.replace(/[^a-z0-9]/gi, '')}`;

    const switchEl = el('label', { class: 'switch' }, [
      el('input', {
        type: 'checkbox',
        id: toggleId,
        ...(channel.isActive ? { checked: 'checked' } : {}),
        onchange: (e) => toggleChannelActive(channel.username, e.target.checked),
      }),
      el('span', { class: 'switch__track' }),
    ]);

    const deleteBtn = el('button', { class: 'btn btn--danger', type: 'button' }, 'Удалить');
    wireConfirmDelete(deleteBtn, channel.username);

    const row = el('li', { class: 'channel-row' }, [
      el('div', { class: 'channel-row__info' }, [
        el('div', { class: 'channel-row__title', text: channel.title || channel.username }),
        el('div', { class: 'channel-row__username', text: channel.username }),
      ]),
      el('div', { class: 'channel-row__actions' }, [switchEl, deleteBtn]),
    ]);

    list.appendChild(row);
  }
}

// Удаление в два клика вместо блокирующего confirm(): первый клик просит
// подтвердить, второй в течение 3 секунд — удаляет.
function wireConfirmDelete(button, username) {
  let armed = false;
  let timer = null;

  button.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      button.textContent = 'Точно удалить?';
      timer = setTimeout(() => {
        armed = false;
        button.textContent = 'Удалить';
      }, 3000);
      return;
    }
    clearTimeout(timer);
    button.disabled = true;
    try {
      await api(`/api/channels/${encodeURIComponent(username.replace('@', ''))}`, { method: 'DELETE' });
      await loadChannels();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
      armed = false;
      button.textContent = 'Удалить';
    }
  });
}

async function toggleChannelActive(username, isActive) {
  try {
    await api(`/api/channels/${encodeURIComponent(username.replace('@', ''))}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    });
    await loadChannels();
  } catch (error) {
    alert(error.message);
    await loadChannels(); // откатить переключатель к реальному состоянию
  }
}

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
    await api('/api/channels', { method: 'POST', body: JSON.stringify({ username: value }) });
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
  const hasActive = state.channels.some((c) => c.isActive);
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
