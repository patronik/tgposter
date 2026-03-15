require('dotenv').config();
const express = require('express');
const path = require('node:path');
const fs = require('fs');
const {
  readData,
  writeData,
  loadRemote,
  readConfig,
  writeConfig,
  getConfigItem,
  getReqKeys,
} = require('./src/config');
const {
  getAccounts,
  addAccount,
  updateAccount,
  deleteAccount,
} = require('./src/accounts');
const {
  processGroups,
  getIsRunning,
  setIsRunning,
  getTotalSent,
  getProfile,
  getProfilePhotoBuffer,
  updateProfile,
} = require('./src/telegram/poster');
const { getDataDir } = require('./src/dataDir');

const app = express();
const PORT = process.env.PORT || 3000;

// Pending Telegram auth code (replaces Electron IPC request-code / submit-code)
let pendingCode = { resolve: null, phone: null };

function requestCode(phone) {
  return new Promise((resolve) => {
    pendingCode.resolve = resolve;
    pendingCode.phone = phone || getConfigItem('TELEGRAM_PHONE_NUM');
  });
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'src')));

// SPA-style: serve index.html for root so links work when opening / directly
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

// ----- Items -----
app.get('/api/items', (req, res) => {
  try {
    const data = readData();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/items/:id', (req, res) => {
  try {
    const data = readData().filter((i) => i.id === req.params.id);
    if (!data.length) return res.status(404).json({ error: 'Not found' });
    res.json(data[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/items', (req, res) => {
  try {
    const data = readData();
    data.push(req.body);
    writeData(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/items/:id', (req, res) => {
  try {
    let data = readData();
    data = data.map((i) => (i.id === req.params.id ? { ...req.body, id: req.params.id } : i));
    writeData(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/items/:id', (req, res) => {
  try {
    const data = readData().filter((i) => i.id !== req.params.id);
    writeData(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Config -----
app.get('/api/config', (req, res) => {
  try {
    res.json(readConfig());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config/required-keys', (req, res) => {
  try {
    res.json(getReqKeys());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config/:key', (req, res) => {
  try {
    const value = getConfigItem(req.params.key);
    res.json({ value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/config', (req, res) => {
  try {
    writeConfig(req.body);
    res.json(req.body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Accounts -----
app.get('/api/accounts', (req, res) => {
  try {
    res.json(getAccounts());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts', (req, res) => {
  try {
    const phone = req.body?.phone;
    if (!phone) return res.status(400).json({ error: 'Phone number is required' });
    const accounts = addAccount(phone);
    res.json(accounts);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/accounts/:phone', (req, res) => {
  try {
    const newPhone = req.body?.phone;
    if (!newPhone) return res.status(400).json({ error: 'Phone number is required' });
    const accounts = updateAccount(decodeURIComponent(req.params.phone), newPhone);
    res.json(accounts);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:phone', (req, res) => {
  try {
    const accounts = deleteAccount(decodeURIComponent(req.params.phone));
    res.json(accounts);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/accounts/:phone/logout', (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const sessionPath = path.join(getDataDir(), `${phone}-session.json`);
    if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Profile (active account) -----
app.get('/api/profile', async (req, res) => {
  try {
    const profile = await getProfile();
    res.json(profile);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/profile/photo', async (req, res) => {
  try {
    const buffer = await getProfilePhotoBuffer();
    if (!buffer || buffer.length === 0) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/profile', async (req, res) => {
  try {
    const { username, bio } = req.body || {};
    await updateProfile({ username, bio });
    const profile = await getProfile();
    res.json(profile);
  } catch (e) {
    res.status(400).json({ error: e.message || e.error_message || String(e) });
  }
});

// ----- Auth (Telegram code) -----
app.get('/api/auth/pending-code', (req, res) => {
  if (pendingCode.resolve) {
    return res.json({ needCode: true, phone: pendingCode.phone });
  }
  res.json({ needCode: false });
});

app.post('/api/auth/submit-code', (req, res) => {
  const code = req.body?.code?.trim();
  if (!code) return res.status(400).json({ error: 'Неправильний код' });
  if (pendingCode.resolve) {
    pendingCode.resolve(code);
    pendingCode.resolve = null;
    pendingCode.phone = null;
    return res.json({ ok: true });
  }
  res.status(400).json({ error: 'No pending code request' });
});

app.post('/api/auth/logout', (req, res) => {
  try {
    const phone = getConfigItem('TELEGRAM_PHONE_NUM');
    if (phone) {
      const sessionPath = path.join(getDataDir(), `${phone}-session.json`);
      if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----- Status & control -----
app.get('/api/status', (req, res) => {
  try {
    res.json({ isRunning: getIsRunning(), totalSent: getTotalSent() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

let taskCount = 0;

app.post('/api/start', async (req, res) => {
  try {
    const expireAt = getConfigItem('LICENSE_EXPIRE_AT');
    if (expireAt) {
      const exp = new Date(expireAt);
      if (exp < new Date()) {
        return res.status(403).json({
          error: 'Термін ліцензії програми закінчився!',
        });
      }
    }

    setIsRunning(true);
    if (taskCount > 0) {
      return res.json({ message: 'already running' });
    }
    taskCount++;
    const task = processGroups(requestCode);
    task.finally(() => taskCount--);
    res.json({ message: 'started' });
  } catch (e) {
    setIsRunning(false);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop', (req, res) => {
  setIsRunning(false);
  res.json({ message: 'stopped' });
});

// ----- Export / Import -----
app.get('/api/export', (req, res) => {
  try {
    const data = readData();
    res.setHeader('Content-Disposition', 'attachment; filename=data.json');
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/import', (req, res) => {
  try {
    const parsed = req.body;
    if (!Array.isArray(parsed)) {
      return res.status(400).json({ error: 'Невірний формат JSON' });
    }
    parsed.forEach((i) => {
      if (!i.id) throw new Error('Некоректний запис у JSON');
    });
    writeData(parsed);
    res.json({ ok: true, data: readData() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Load remote config on startup
loadRemote()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tgposter server at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to load remote config:', err);
    app.listen(PORT, () => {
      console.log(`Tgposter server at http://localhost:${PORT}`);
    });
  });
