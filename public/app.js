// Ванильный JS без зависимостей — страница может позже переехать в Telegram
// мини-апп без переписывания. Все данные с сервера и из Telegram считаются
// недоверенными: везде используется textContent, а не innerHTML с подстановкой.

const state = {
  windowOptions: [],
  selectedWindowMinutes: null,
  channels: [],
  searching: false,
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
    throw new Error(message);
  }
  return data;
}

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
  try {
    await Promise.all([loadWindowOptions(), loadChannels()]);
  } catch (error) {
    const banner = document.getElementById('errorBanner');
    banner.textContent = `Не удалось загрузить страницу: ${error.message}`;
    banner.hidden = false;
  }
})();
