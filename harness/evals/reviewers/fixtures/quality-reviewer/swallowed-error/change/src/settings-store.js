import { writeFile } from 'node:fs/promises';

const SETTINGS_ENCODING = 'utf8';
const JSON_INDENT = 2;

export function validateSettings(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new TypeError('settings must be a plain object');
  }
  if (typeof settings.theme !== 'string') {
    throw new TypeError('settings.theme must be a string');
  }
  return settings;
}

// Persists user settings to disk.
export async function saveSettings(path, settings) {
  validateSettings(settings);
  try {
    await writeFile(path, JSON.stringify(settings, null, JSON_INDENT), SETTINGS_ENCODING);
  } catch (err) {
    // ignore
  }
}
