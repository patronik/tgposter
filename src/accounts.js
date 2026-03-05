const { app } = require('electron');
const path = require('node:path');
const fs = require('fs');

const ACCOUNTS_FILE = path.join(app.getPath('userData'), 'accounts.json');

function readAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeAccounts(accounts) {
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8');
}

function normalizePhone(phone) {
  return String(phone).trim().replace(/\s/g, '');
}

function getAccounts() {
  return readAccounts();
}

function addAccount(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Phone number is required');
  const accounts = readAccounts();
  if (accounts.some((a) => normalizePhone(a.phone) === normalized)) {
    throw new Error('Account with this phone already exists');
  }
  accounts.push({ phone: normalized });
  writeAccounts(accounts);
  return accounts;
}

function updateAccount(oldPhone, newPhone) {
  const oldNorm = normalizePhone(oldPhone);
  const newNorm = normalizePhone(newPhone);
  if (!newNorm) throw new Error('Phone number is required');
  const accounts = readAccounts();
  const idx = accounts.findIndex((a) => normalizePhone(a.phone) === oldNorm);
  if (idx === -1) throw new Error('Account not found');
  if (accounts.some((a) => normalizePhone(a.phone) === newNorm && normalizePhone(a.phone) !== oldNorm)) {
    throw new Error('Account with this phone already exists');
  }
  accounts[idx].phone = newNorm;
  writeAccounts(accounts);
  return accounts;
}

function deleteAccount(phone) {
  const normalized = normalizePhone(phone);
  const accounts = readAccounts().filter((a) => normalizePhone(a.phone) !== normalized);
  writeAccounts(accounts);
  return accounts;
}

module.exports = {
  getAccounts,
  addAccount,
  updateAccount,
  deleteAccount,
  readAccounts,
  normalizePhone,
};
