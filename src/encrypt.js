require('dotenv').config();
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const inputPath = path.join(__dirname, '..', 'config.json');
const outputPath = path.join(__dirname, '..', 'config.txt');

// ===== Crypto config =====
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const SALT = 'what_a_beautiful_day';

const PASSWORD = process.env.ENCRYPTION_PASSWORD || 'my_super_secret_password';

// ===== Helpers =====
function deriveKey(password) {
  return crypto.scryptSync(password, SALT, KEY_LENGTH);
}

function encrypt(text, password) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(password);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(text, 'utf8'),
    cipher.final()
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    authTag.toString('hex'),
    encrypted.toString('hex')
  ].join(':');
}

// ===== Main =====
const jsonData = fs.readFileSync(inputPath, 'utf8');
const encryptedData = encrypt(jsonData, PASSWORD);

fs.writeFileSync(outputPath, encryptedData);

console.log('✅ JSON file encrypted and saved to encrypted.txt');
