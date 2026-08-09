let waitingForCode = false;
const spinner = document.getElementById('mySpinner');

const appStatus = document.getElementById('status');
const codeInput = document.getElementById('code');
const sendCodeBtn = document.getElementById('send_code');

let isRunning = false;
let aiCatalog = { scenarios: [], goals: [], replyStrategies: [] };

setInterval(
  async () => {
    isRunning = await window.api.getIsRunning();  
    if (isRunning) {
      spinner.classList.remove('paused');
      actionBtn.innerHTML = 'Стоп';
    } else {
      spinner.classList.add('paused');
      actionBtn.innerHTML = 'Старт';
    }   
  },
  5000
);

setInterval(
  async () => {
    try {
      const status = await window.api.getStatus();
      document.getElementById('messages_sent').innerText = status.totalSent ?? 0;
      updateSentCounts(status.sentByGroup || {});
    } catch (_) {}
  },
  5000
);

function updateSentCounts(sentByGroup) {
  document.querySelectorAll('#list tr[data-groupid]').forEach((tr) => {
    const groupid = tr.getAttribute('data-groupid');
    const cell = tr.querySelector('.sent-count');
    if (cell) cell.textContent = sentByGroup[groupid] || 0;
  });
}

async function validateConfig() {  
  const config = await window.api.getConfig();
  const required = await window.api.getRequiredKeys();
  for (let item of required) {
    if (!config[item] || config[item].length == 0) {
      return false;
    }
  }
  return true;
}

const actionBtn = document.getElementById('action_btn');
actionBtn.onclick = async () => {
  try {            
    const isConfigValid = await validateConfig();
    if (!isConfigValid) {      
      appStatus.innerHTML = `<b>відсутні</b> <a href="configuration.html">налаштування</a>`;
      return;
    }

    const items = await window.api.getItems();
    if (!(items.length > 0)) {
      appStatus.innerHTML = `<b>відсутні групи/канали</b>`;
      return;
    }    

    if (!isRunning) {
      await window.api.start();      
    } else {
      await window.api.stop();      
    }   
  } catch (err) {
    appStatus.innerHTML = `<b>${err.message}</b>`;
  }  
};

// request auth code (same flow in single- and multi-account mode: enter code, click "Надіслати код")
window.api.onCodeRequest((phone) => {
  waitingForCode = true;
  const forPhone = phone ? ` для ${phone}` : '';
  appStatus.innerHTML = `<b>Введіть код${forPhone}</b> та натисніть «Надіслати код»`;  
  codeInput.focus();
});

// send code to main
sendCodeBtn.onclick = async () => {
  if (!waitingForCode) return;
  try {
    await window.api.submitCode(codeInput.value);
    appStatus.innerHTML = '<b>Код надісланий</b>';
    waitingForCode = false;
  } catch (err) {
    appStatus.innerHTML = `<b>${err.message}</b>`;
  }
};

async function logout() {
  try {
    await window.api.logout();
    appStatus.innerHTML = '<b>Успішний вихід</b>';
  } catch (e) {
    appStatus.innerHTML = `<b>${e.message}</b>`;
  }
}

async function exportData() {
  try {
    await window.api.exportData();
    appStatus.innerHTML = '<b>Дані експортовано</b>';
  } catch (e) {
    appStatus.innerHTML = `<b>${e.message}</b>`;
  }
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      await window.api.importData(parsed);
      await load();
      appStatus.innerHTML = '<b>Дані імпортовано</b>';
    } catch (e) {
      appStatus.innerHTML = `<b>${e.message}</b>`;
    }
  };
  input.click();
}

function renderTarget(key) {
  switch (key) {
    case '^':
      return "реплай на новий пост";
    case '$':
      return "реплай до останнього";
    case '*':
      return "реплай до рандомного";
    case '@':
      return "ведення дискусії";
    default:
      return "по замовчуванню";
  }
}

function catalogLabel(list, id) {
  if (!id) return '—';
  const found = (list || []).find((x) => x.id === id);
  return found ? found.name : id;
}

function fillSelect(selectId, items, emptyLabel, selectedValue = '') {
  const select = document.getElementById(selectId);
  const current = selectedValue || select.value || '';
  select.innerHTML = `<option value="">${emptyLabel}</option>`;
  for (const item of items || []) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.name || item.id;
    select.appendChild(opt);
  }
  select.value = current;
}

function readItemForm() {
  return {
    groupid: document.getElementById('groupid').value,
    comment: document.getElementById('comment').value,
    edition: document.getElementById('edition').value,
    reaction: document.getElementById('reaction').value,
    prompt: document.getElementById('prompt').value,
    target: document.getElementById('target').value,
    ai_scenario: document.getElementById('ai_scenario').value,
    ai_goal: document.getElementById('ai_goal').value,
    reply_strategy: document.getElementById('reply_strategy').value,
    ai_mood: document.getElementById('ai_mood').value,
    ai_personality: document.getElementById('ai_personality').value,
    ai_bio: document.getElementById('ai_bio').value,
  };
}

function fillItemForm(item = {}) {
  document.getElementById('groupid').value = item.groupid || '';
  document.getElementById('comment').value = item.comment || '';
  document.getElementById('edition').value = item.edition || '';
  document.getElementById('reaction').value = item.reaction || '';
  document.getElementById('prompt').value = item.prompt || '';
  document.getElementById('target').value = item.target || '';
  document.getElementById('ai_scenario').value = item.ai_scenario || '';
  document.getElementById('ai_goal').value = item.ai_goal || '';
  document.getElementById('reply_strategy').value = item.reply_strategy || '';
  document.getElementById('ai_mood').value = item.ai_mood || '';
  document.getElementById('ai_personality').value = item.ai_personality || '';
  document.getElementById('ai_bio').value = item.ai_bio || '';
}

function clearItemForm() {
  document.getElementById('id').value = '';
  fillItemForm({});
  document.getElementById("add_btn").style.display = "block";
  document.getElementById("save_btn").style.display = "none";
}

async function loadAiDropdowns() {
  try {
    aiCatalog = await window.api.getAiCatalog();
  } catch (_) {
    aiCatalog = { scenarios: [], goals: [], replyStrategies: [] };
  }
  fillSelect('ai_scenario', aiCatalog.scenarios, 'глобальний / немає');
  fillSelect('ai_goal', aiCatalog.goals, 'глобальний / немає');
  fillSelect('reply_strategy', aiCatalog.replyStrategies, 'глобальна');
}

async function load() {  
  const [items, sentByGroup] = await Promise.all([
    window.api.getItems(),
    window.api.getSentByGroup().catch(() => ({})),
  ]);
  const tbody = document.getElementById('list');
  tbody.innerHTML = '';
  items.forEach(i => {
    const tr = document.createElement('tr');
    tr.setAttribute('data-groupid', i.groupid);
    const sent = sentByGroup[i.groupid] || 0;
    tr.innerHTML = `
      <td>${i.groupid}</td>
      <td>${i.comment}</td> 
      <td>${i.edition}</td>
      <td>${i.reaction}</td>
      <td>${(i.prompt || '').slice(0, 100)}</td>
      <td>${catalogLabel(aiCatalog.scenarios, i.ai_scenario)}</td>
      <td>${catalogLabel(aiCatalog.goals, i.ai_goal)}</td>
      <td>${renderTarget(i.target)}</td>
      <td class="sent-count">${sent}</td>
      <td>                
        <div class="btn_container">
          <div><button onclick="edit('${i.id}')"><span class="material-icons">edit</span></button></div>
          <div><button onclick="remove('${i.id}')"><span class="material-icons">delete</span></button></div>          
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function add() {  
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await window.api.addItem({ id, ...readItemForm() });
  clearItemForm();
  load();
}

async function edit(id) {  
  const item = await window.api.getItem(id);
  document.getElementById('id').value = id;
  fillItemForm(item);

  document.getElementById("add_btn").style.display = "none";
  document.getElementById("save_btn").style.display = "block";
}

async function save() {
  const id = document.getElementById('id').value;
  await window.api.updateItem({ id, ...readItemForm() });
  clearItemForm();
  load();
}

async function remove(id) {
  await window.api.deleteItem(id);
  load();
}

(async () => {
  await loadAiDropdowns();
  await load();
})();
