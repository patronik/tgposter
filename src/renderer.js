let waitingForCode = false;
const spinner = document.getElementById('mySpinner');

const appStatus = document.getElementById('status');
const codeInput = document.getElementById('code');
const sendCodeBtn = document.getElementById('send_code');

let isRunning = false;
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
  100
);

setInterval(
  async () => {
    const messagesSent = await window.api.getMessagesSent();  
    document.getElementById('messages_sent').innerText = messagesSent;
  },
  500
);

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
      appStatus.innerHTML = `відсутні <a href="configuration.html">налаштування</a>`;
      return;
    }

    const items = await window.api.getItems();
    if (!(items.length > 0)) {
      appStatus.textContent = `відсутні групи/канали`;
      return;
    }

    const requestRestart = sessionStorage.getItem('request-restart');
    if (requestRestart) {
      sessionStorage.removeItem('request-restart');
      await window.api.requestRestart(
        'Ваша сесія змінилась, потрібен перезапуск програми!'
      );
    }    

    if (!isRunning) {
      await window.api.start();      
    } else {
      await window.api.stop();      
    }   
  } catch (err) {
    appStatus.textContent = err.message;
  }  
};

// request auth code
window.api.onCodeRequest(() => {
  waitingForCode = true;
  appStatus.textContent = 'Введіть код:';
  codeInput.value = '';
  input.focus();
});

// send code to main
sendCodeBtn.onclick = async () => {
  if (!waitingForCode) return;
  try {
    await window.api.submitCode(codeInput.value);
    appStatus.textContent = 'Код надісланий';
    waitingForCode = false;
  } catch (err) {
    appStatus.textContent = err.message;
  }
};

// on log event
window.api.onLog((data) => {
  console.log(data);
});

async function exportData() {
  try {
    await window.api.exportData();
    appStatus.textContent = 'Дані експортовано';
  } catch (e) {
    appStatus.textContent = e.message;
  }
}

async function importData() {
  try {
    const replaced = await window.api.importData();
    if (replaced) {
      await load();
      appStatus.textContent = 'Дані імпортовано';
    }
  } catch (e) {
    appStatus.textContent = e.message;
  }
}

function renderTarget(key) {
  switch (key) {
    case '^':
      return "реплай на новий пост";
    case '$':
      return "реплай до останнього";
    case '*':
      return "реплай до рандомного";
    default:
      return "по замовчуванню";
  }
}

async function load() {  
  const items = await window.api.getItems();
  const tbody = document.getElementById('list');
  tbody.innerHTML = '';
  items.forEach(i => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i.groupid}</td>
      <td>${i.comment}</td> 
      <td>${i.reaction}</td>
      <td>${i.prompt}</td>
      <td>${renderTarget(i.target)}</td>
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
  const groupid = document.getElementById('groupid').value;
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;
  const prompt = document.getElementById('prompt').value;
  const target = document.getElementById('target').value;
  await window.api.addItem({
    id,
    groupid,
    comment,
    reaction,
    prompt,
    target
  });
  load();
}

async function edit(id) {  
  const item = await window.api.getItem(id);
  document.getElementById('id').value = id;
  document.getElementById('groupid').value = item.groupid;
  document.getElementById('comment').value = item.comment;
  document.getElementById('reaction').value = item.reaction;
  document.getElementById('prompt').value = item.prompt;
  document.getElementById('target').value = item.target;

  document.getElementById("add_btn").style.display = "none";
  document.getElementById("save_btn").style.display = "block";
}

async function save() {
  const id = document.getElementById('id').value;
  const groupid = document.getElementById('groupid').value;
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;
  const prompt = document.getElementById('prompt').value;
  const target = document.getElementById('target').value;
  await window.api.updateItem({ id, groupid, comment, reaction, prompt, target });
  load();

  document.getElementById('id').value = '';
  document.getElementById('groupid').value = '';
  document.getElementById('comment').value = '';
  document.getElementById('reaction').value = '';
  document.getElementById('prompt').value = '';
  document.getElementById('target').value = '';
  
  document.getElementById("add_btn").style.display = "block";
  document.getElementById("save_btn").style.display = "none";
}

async function remove(id) {
  await window.api.deleteItem(id);
  load();
}

load();