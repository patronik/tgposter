let waitingForCode = false;
let isRunning = false;

function toggleSpinner() {  
  const spinner = document.getElementById('mySpinner');
  if (spinner.classList.contains('paused')) {
    spinner.classList.remove('paused');
  } else {
    spinner.classList.add('paused');
  }
}

const actionBtn = document.getElementById('action_btn');
actionBtn.onclick = async () => {
  try {
    if (!isRunning) {
      await window.api.processGroups();      
      toggleSpinner();
      actionBtn.innerHTML = 'Stop';
      isRunning = true;
    } else {
      await window.api.stopPosting();      
      toggleSpinner();      
      actionBtn.innerHTML = 'Start';
      isRunning = false;
    }   
  } catch (err) {
    appStatus.textContent = err.message;
  }  
};

const appStatus = document.getElementById('status');
const codeInput = document.getElementById('code');
const sendCodeBtn = document.getElementById('send_code');

// request auth code
window.api.onCodeRequest(() => {
  waitingForCode = true;
  appStatus.textContent = 'Enter code:';
  codeInput.value = '';
  input.focus();
});

// send code to main
sendCodeBtn.onclick = async () => {
  if (!waitingForCode) return;
  try {
    await window.api.submitCode(codeInput.value);
    appStatus.textContent = 'Code sent';
    waitingForCode = false;
  } catch (err) {
    appStatus.textContent = err.message;
  }
};

async function load() {
  const items = await window.api.getItems();
  const tbody = document.getElementById('list');
  tbody.innerHTML = '';
  items.forEach(i => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i.id}</td>
      <td>${i.comment}</td> 
      <td>${i.reaction}</td>
      <td>${i.prompt}</td>
      <td>${i.target}</td>
      <td>                
        <div class="btn_container">
          <div><button onclick="edit('${i.id}')">Edit</button></div>
          <div><button onclick="remove('${i.id}')">Delete</button></div>          
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function add() {
  const id = document.getElementById('id').value;
  const item = await window.api.getItem(id);
  if (item) {
    return;
  }
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;
  const prompt = document.getElementById('prompt').value;
  const target = document.getElementById('target').value;
  await window.api.addItem({
    id,
    comment,
    reaction,
    prompt,
    target
  });
  load();
}

async function edit(id) {  
  const item = await window.api.getItem(id);
  document.getElementById('id').value = item.id;
  document.getElementById('comment').value = item.comment;
  document.getElementById('reaction').value = item.reaction;
  document.getElementById('prompt').value = item.prompt;
  document.getElementById('target').value = item.target;
  document.getElementById("add_btn").style.display = "none";
  document.getElementById("save_btn").style.display = "block";
  document.getElementById("id").readOnly = true;
}

async function save() {
  const id = document.getElementById('id').value;
  const comment = document.getElementById('comment').value;
  const reaction = document.getElementById('reaction').value;
  const prompt = document.getElementById('prompt').value;
  const target = document.getElementById('target').value;
  await window.api.updateItem({ id, comment, reaction, prompt, target });
  load();

  document.getElementById('id').value = '';
  document.getElementById('comment').value = '';
  document.getElementById('reaction').value = '';
  document.getElementById('prompt').value = '';
  document.getElementById('target').value = '';
  document.getElementById("add_btn").style.display = "block";
  document.getElementById("save_btn").style.display = "none";
  document.getElementById("id").readOnly = false;
}

async function remove(id) {
  await window.api.deleteItem(id);
  load();
}

load();