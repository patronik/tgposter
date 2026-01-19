require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const inputPath = path.join(__dirname, '..', 'config.txt');
const outputPath = path.join(__dirname, '..', 'config.json');

// ===== Crypto config =====
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const SALT = process.env.ENCRYPTION_SALT;
const PASSWORD = process.env.ENCRYPTION_PASSWORD;

// ===== Helpers =====
function deriveKey(password) {
  return crypto.scryptSync(password, SALT, KEY_LENGTH);
}

function decrypt(encryptedData, password) {
  const [ivHex, authTagHex, encryptedHex] = encryptedData.split(':');

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encryptedText = Buffer.from(encryptedHex, 'hex');
  const key = deriveKey(password);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedText),
    decipher.final()
  ]);

  return decrypted.toString('utf8');
}

// ===== Main =====
const encryptedData = fs.readFileSync(inputPath, 'utf8');
const decryptedJson = decrypt(encryptedData, PASSWORD);

fs.writeFileSync(outputPath, decryptedJson);
console.log('🔓 Decrypted JSON saved.');

