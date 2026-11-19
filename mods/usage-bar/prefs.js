export const VISIBLE_KEYS = ['codex', 'claude', 'gemini', 'linear', 'system'];

export function readVisible(raw) {
  return Object.fromEntries(VISIBLE_KEYS.map(key => [key, typeof raw?.[key] === 'boolean' ? raw[key] : true]));
}

export function toggleVisible(current, key) {
  const visible = readVisible(current);
  if (VISIBLE_KEYS.includes(key)) visible[key] = !visible[key];
  return visible;
}
