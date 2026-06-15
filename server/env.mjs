import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnv(filePath = '.env') {
  const resolvedPath = resolve(process.cwd(), filePath);
  if (!existsSync(resolvedPath)) return;

  const lines = readFileSync(resolvedPath, 'utf8').split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/gu, '');

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
