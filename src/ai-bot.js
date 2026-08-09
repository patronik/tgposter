const AI_KEYS = [
  'GROQ_API_KEY',
  'GROQ_API_MODEL',
  'GROQ_SYSTEM_MESSAGE',
  'TELEGRAM_PM_MODE',
  'TELEGRAM_PM_AUTOREPLY_TEXT',
  'AI_PM_SCENARIO',
  'AI_PM_GOAL',
  'AI_PM_MOOD',
  'AI_PM_PROMPT',
  'AI_PM_PERSONALITY',
  'AI_PM_BIO',
  'AI_PERSONALITY',
  'AI_BIO',
  'AI_MOOD',
  'AI_CONVERSATION_STYLE',
  'AI_REPLY_STRATEGY',
  'AI_SKIP_PROBABILITY',
  'AI_REPLY_DELAY_MIN_MS',
  'AI_REPLY_DELAY_MAX_MS',
];

const SELECT_KEYS = new Set([
  'TELEGRAM_PM_MODE',
  'AI_PM_SCENARIO',
  'AI_PM_GOAL',
  'AI_REPLY_STRATEGY',
]);

let config = {};
let catalog = {
  scenarios: [],
  goals: [],
  replyStrategies: [],
  pmModes: [],
  defaults: { scenarios: [], goals: [], conversationStyle: '', pmPrompt: '' },
};

function setStatus(text, kind = '') {
  const el = document.getElementById('ai-status');
  el.textContent = text;
  el.className = `status-msg ${kind}`.trim();
}

function parseStoredCatalog(raw, fallback) {
  if (!raw || !String(raw).trim()) return fallback.map((x) => ({ ...x }));
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return fallback.map((x) => ({ ...x }));
    return parsed.map((item) => ({
      id: String(item.id || ''),
      name: String(item.name || ''),
      description: String(item.description || ''),
    }));
  } catch {
    return fallback.map((x) => ({ ...x }));
  }
}

function renderCatalogRows(containerId, items) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  items.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'catalog-row';
    row.dataset.index = String(index);
    row.innerHTML = `
      <input data-field="id" placeholder="id" value="${escapeAttr(item.id)}" />
      <input data-field="name" placeholder="Назва" value="${escapeAttr(item.name)}" />
      <textarea data-field="description" placeholder="Опис">${escapeText(item.description)}</textarea>
      <button type="button" title="Видалити" onclick="removeCatalogRow('${containerId}', ${index})">
        <span class="material-icons">delete</span>
      </button>
    `;
    container.appendChild(row);
  });
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;');
}

function readCatalogRows(containerId) {
  return [...document.querySelectorAll(`#${containerId} .catalog-row`)].map((row) => ({
    id: row.querySelector('[data-field="id"]').value.trim(),
    name: row.querySelector('[data-field="name"]').value.trim(),
    description: row.querySelector('[data-field="description"]').value.trim(),
  })).filter((item) => item.id);
}

function removeCatalogRow(containerId, index) {
  const items = readCatalogRows(containerId);
  items.splice(index, 1);
  renderCatalogRows(containerId, items);
}

function addScenarioRow() {
  const items = readCatalogRows('scenarios-list');
  items.push({ id: '', name: '', description: '' });
  renderCatalogRows('scenarios-list', items);
}

function addGoalRow() {
  const items = readCatalogRows('goals-list');
  items.push({ id: '', name: '', description: '' });
  renderCatalogRows('goals-list', items);
}

function resetScenarios() {
  renderCatalogRows('scenarios-list', catalog.defaults.scenarios || []);
}

function resetGoals() {
  renderCatalogRows('goals-list', catalog.defaults.goals || []);
}

function fillSelect(selectId, items, emptyLabel, selectedValue) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = '';
  if (emptyLabel != null) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = emptyLabel;
    select.appendChild(empty);
  }
  for (const item of items || []) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name || item.id;
    select.appendChild(opt);
  }
  if (selectedValue != null && selectedValue !== '') {
    select.value = selectedValue;
  }
}

function resolveInitialPmMode() {
  const mode = String(config.TELEGRAM_PM_MODE || '').trim().toLowerCase();
  if (mode === 'ai' || mode === 'autoreply' || mode === 'off') return mode;
  if (config.TELEGRAM_PM_AUTOREPLY_TEXT) return 'autoreply';
  return 'off';
}

async function loadAiSettings() {
  setStatus('Завантаження…');
  config = await window.api.getConfig();
  catalog = await window.api.getAiCatalog();

  fillSelect('TELEGRAM_PM_MODE', catalog.pmModes || [], null, resolveInitialPmMode());
  fillSelect('AI_PM_SCENARIO', catalog.scenarios, 'глобальний / немає', config.AI_PM_SCENARIO || '');
  fillSelect('AI_PM_GOAL', catalog.goals, 'глобальний / немає', config.AI_PM_GOAL || '');
  fillSelect('AI_REPLY_STRATEGY', catalog.replyStrategies, null, config.AI_REPLY_STRATEGY || 'auto');

  for (const key of AI_KEYS) {
    const el = document.getElementById(key);
    if (!el || SELECT_KEYS.has(key)) continue;
    if (key === 'AI_CONVERSATION_STYLE') {
      el.value = config[key] || catalog.defaults.conversationStyle || '';
      continue;
    }
    if (key === 'AI_PM_PROMPT') {
      el.value = config[key] || catalog.defaults.pmPrompt || '';
      continue;
    }
    el.value = config[key] ?? '';
  }

  const scenarios = parseStoredCatalog(config.AI_SCENARIOS, catalog.defaults.scenarios || catalog.scenarios);
  const goals = parseStoredCatalog(config.AI_GOALS, catalog.defaults.goals || catalog.goals);
  renderCatalogRows('scenarios-list', scenarios);
  renderCatalogRows('goals-list', goals);
  setStatus('');
}

async function saveAiSettings() {
  try {
    const next = { ...config };
    for (const key of AI_KEYS) {
      const el = document.getElementById(key);
      if (!el) continue;
      next[key] = el.value;
    }

    const scenarios = readCatalogRows('scenarios-list');
    const goals = readCatalogRows('goals-list');
    next.AI_SCENARIOS = JSON.stringify(scenarios, null, 2);
    next.AI_GOALS = JSON.stringify(goals, null, 2);

    await window.api.setConfig(next);
    config = next;

    fillSelect('AI_PM_SCENARIO', scenarios, 'глобальний / немає', next.AI_PM_SCENARIO || '');
    fillSelect('AI_PM_GOAL', goals, 'глобальний / немає', next.AI_PM_GOAL || '');
    setStatus('Збережено', 'ok');
  } catch (err) {
    setStatus(err.message || 'Помилка збереження', 'err');
  }
}

loadAiSettings();
