let config = {};

const required = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_PHONE_NUM',
  'TELEGRAM_ITERATION_DELAY',
  'TELEGRAM_API_DELAY'
];

async function loadConfig() {
  config = await window.api.getConfig();

  for (let item of required) {
    if (!config[item]) {
      config[item] = '';
    }
  }

  render();
}

function render() {
  const tbody = document.getElementById('config-list');
  tbody.innerHTML = '';

  Object.entries(config).forEach(([key, value]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${key}</td>
      <td>${value}</td>
      <td>        
        <div class="btn_container">
          <div><button onclick="editConfig('${key}')">Edit</button></div>
          <div><button onclick="removeConfig('${key}')">Delete</button></div>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function addConfig() {
  const key = document.getElementById('key').value;
  const value = document.getElementById('value').value;

  if (!key) return;

  config[key] = value;
  await window.api.setConfig(config);

  document.getElementById('key').value = '';
  document.getElementById('value').value = '';

  render();
}

async function editConfig(key) {
  const value = await window.api.getConfigItem(key);
  document.getElementById('key').value = key;
  document.getElementById('value').value = value;    
  document.getElementById("add_btn").style.display = "none";
  document.getElementById("save_btn").style.display = "block";
  document.getElementById("key").readOnly = true;
}

async function saveConfig() {
  const key = document.getElementById('key').value;  
  config[key] = document.getElementById('value').value;
  await window.api.setConfig(config);
  render();
  
  document.getElementById('key').value = '';
  document.getElementById('value').value = '';  
  document.getElementById("add_btn").style.display = "block";
  document.getElementById("save_btn").style.display = "none";
  document.getElementById("key").readOnly = false;  
}

async function removeConfig(key) {
  if (required.includes(key)) {
    console.log('Required configuration cannot be removed.');
    return;
  }
  delete config[key];
  await window.api.setConfig(config);
  render();
}

loadConfig();
