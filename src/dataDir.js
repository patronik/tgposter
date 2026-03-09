const path = require('node:path');

/**
 * Application data directory (replaces Electron app.getPath('userData')).
 * Set DATA_DIR in env or defaults to ./data relative to CWD.
 */
function getDataDir() {
  const base = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(base);
}

module.exports = { getDataDir };
