import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, 'data', 'db.json');

export function read() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}

export function write(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function update(fn) {
  const data = read();
  const result = fn(data);
  write(data);
  return result;
}