const path = require('node:path');

function getDataDir() {
  const base = process.env.DATA_DIR || path.join(process.cwd(), 'data');
  return path.resolve(base);
}

module.exports = { getDataDir };
