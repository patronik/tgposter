let accounts = [];
let editingPhone = null;

async function loadAccounts() {
  try {
    accounts = await window.api.getAccounts();
  } catch (e) {
    accounts = [];
  }
  render();
}

function escapeForAttr(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '&quot;');
}

function render() {
  const tbody = document.getElementById('accounts-list');
  const empty = document.getElementById('empty-accounts');
  tbody.innerHTML = '';
  if (!accounts.length) {
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  accounts.forEach((a) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeForAttr(a.phone)}</td>
      <td>
        <div class="btn_container">
          <button class="btn-edit" data-phone="${escapeForAttr(a.phone)}"><span class="material-icons">edit</span></button>
          <button class="btn-delete" data-phone="${escapeForAttr(a.phone)}"><span class="material-icons">delete</span></button>
          <button class="btn-logout" data-phone="${escapeForAttr(a.phone)}" title="Вийти (видалити сесію)"><span class="material-icons">logout</span></button>
        </div>
      </td>
    `;
    tr.querySelector('.btn-edit').onclick = () => editAccount(tr.querySelector('.btn-edit').dataset.phone);
    tr.querySelector('.btn-delete').onclick = () => deleteAccount(tr.querySelector('.btn-delete').dataset.phone);
    tr.querySelector('.btn-logout').onclick = () => logoutAccount(tr.querySelector('.btn-logout').dataset.phone);
    tbody.appendChild(tr);
  });
}

async function addAccount() {
  const phone = document.getElementById('phone').value.trim();
  if (!phone) return;
  try {
    accounts = await window.api.addAccount(phone);
    document.getElementById('phone').value = '';
    render();
  } catch (e) {
    alert(e.message || 'Помилка додавання');
  }
}

function editAccount(phone) {
  editingPhone = phone;
  document.getElementById('phone').value = phone;
  document.getElementById('add_btn').style.display = 'none';
  document.getElementById('save_btn').style.display = 'inline-flex';
}

async function saveAccount() {
  const newPhone = document.getElementById('phone').value.trim();
  if (!newPhone || !editingPhone) return;
  try {
    accounts = await window.api.updateAccount(editingPhone, newPhone);
    editingPhone = null;
    document.getElementById('phone').value = '';
    document.getElementById('add_btn').style.display = 'inline-flex';
    document.getElementById('save_btn').style.display = 'none';
    render();
  } catch (e) {
    alert(e.message || 'Помилка збереження');
  }
}

async function deleteAccount(phone) {
  if (!confirm('Видалити акаунт ' + phone + '?')) return;
  try {
    accounts = await window.api.deleteAccount(phone);
    render();
  } catch (e) {
    alert(e.message || 'Помилка видалення');
  }
}

async function logoutAccount(phone) {
  if (!confirm('Вийти з акаунта ' + phone + ' (сесія буде видалена)?')) return;
  try {
    await window.api.logoutAccount(phone);
  } catch (e) {
    alert(e.message || 'Помилка');
  }
}

loadAccounts();
