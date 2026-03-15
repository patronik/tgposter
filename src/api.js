/**
 * REST API client (replaces Electron preload window.api).
 * Assumes backend is same origin or set API_BASE_URL.
 */
const API_BASE = typeof window !== 'undefined' && window.API_BASE_URL ? window.API_BASE_URL : '';

async function request(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || err.message || res.statusText);
  }
  if (res.status === 204) return;
  return res.json();
}

window.api = {
  // data
  getItems: () => request('GET', '/api/items'),
  getItem: (id) => request('GET', `/api/items/${encodeURIComponent(id)}`),
  addItem: (item) => request('POST', '/api/items', item),
  updateItem: (item) => request('PUT', `/api/items/${encodeURIComponent(item.id)}`, item),
  deleteItem: (id) => request('DELETE', `/api/items/${encodeURIComponent(id)}`),
  // config
  getConfig: () => request('GET', '/api/config'),
  getRequiredKeys: () => request('GET', '/api/config/required-keys'),
  getConfigItem: (key) => request('GET', `/api/config/${encodeURIComponent(key)}`).then((r) => r?.value),
  setConfig: (config) => request('PUT', '/api/config', config),
  // accounts
  getAccounts: () => request('GET', '/api/accounts'),
  addAccount: (phone) => request('POST', '/api/accounts', { phone }),
  updateAccount: (oldPhone, newPhone) =>
    request('PUT', `/api/accounts/${encodeURIComponent(oldPhone)}`, { phone: newPhone }),
  deleteAccount: (phone) => request('DELETE', `/api/accounts/${encodeURIComponent(phone)}`),
  logoutAccount: (phone) => request('POST', `/api/accounts/${encodeURIComponent(phone)}/logout`),
  // profile (active account)
  getProfile: () => request('GET', '/api/profile'),
  getProfilePhotoUrl: () => `${API_BASE}/api/profile/photo?t=${Date.now()}`,
  updateProfile: (data) => request('PUT', '/api/profile', data),
  // auth
  getPendingCode: () => request('GET', '/api/auth/pending-code'),
  submitCode: (code) => request('POST', '/api/auth/submit-code', { code }),
  logout: () => request('POST', '/api/auth/logout'),
  // control
  start: () => request('POST', '/api/start'),
  stop: () => request('POST', '/api/stop'),
  getStatus: () => request('GET', '/api/status'),
  // legacy aliases
  getIsRunning: async () => (await request('GET', '/api/status')).isRunning,
  getTotalSent: async () => (await request('GET', '/api/status')).totalSent,
  exportData: async () => {
    const res = await fetch(`${API_BASE}/api/export`);
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'data.json';
    a.click();
    URL.revokeObjectURL(url);
  },
  importData: (data) => request('POST', '/api/import', data),
  /**
   * Poll for pending code request (replaces onCodeRequest).
   * Calls callback(phone) when backend needs a code.
   */
  onCodeRequest: (callback) => {
    const interval = setInterval(async () => {
      try {
        const r = await request('GET', '/api/auth/pending-code');
        if (r && r.needCode && r.phone) {
          callback(r.phone);
        }
      } catch (_) {}
    }, 500);
    return () => clearInterval(interval);
  },
};
