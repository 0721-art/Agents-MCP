import { secretName } from '../config.js';

const mask = '[REDACTED]';
const isSecretName = key => secretName.test(key) || /[a-z\d](?:ApiKey|APIKey|Token|Secret|Password|Credentials?)$/.test(key)
  || /^authorization$/i.test(key);
const assignment = /(\b[\w-]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTHORIZATION)["']?\s*[:=]\s*)("[^"\\\r\n]*(?:\\.[^"\\\r\n]*)*"|'[^'\\\r\n]*(?:\\.[^'\\\r\n]*)*'|\\"[^"\r\n]*?\\"|(?:(?:Bearer|Basic)[ \t]+)?(?:\[REDACTED\]|(?:\\[^\r\n]|[^\s,;}\]"'\\])+))/gi;
const escapeRegex = text => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

export function createRedactor(env) {
  const secrets = new Set();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string' || !value) continue;
    if (isSecretName(key)) secrets.add(value);
    if (!/(?:^|_)proxy$/i.test(key)) continue;
    let proxy;
    try { proxy = new URL(value); } catch { continue; }
    for (const credential of [proxy.username, proxy.password].filter(Boolean)) {
      secrets.add(credential);
      try { secrets.add(decodeURIComponent(credential)); } catch { /* Keep the raw value. */ }
    }
  }
  const patterns = [...secrets].sort((a, b) => b.length - a.length).map(secret => {
    const escaped = escapeRegex(secret);
    if (secret.length >= 6) return escaped;
    // Common short values only match as tokens, keeping identifiers and JSON syntax intact.
    return /^[\w.~-]+$/.test(secret) ? '(?<![\\w])' + escaped + '(?![\\w])' : '(?<!\\S)' + escaped + '(?!\\S)';
  });
  const known = patterns.length ? new RegExp([escapeRegex(mask), ...patterns].join('|'), 'g') : null;
  function cleanText(value, key = false) {
    value = value
      .replace(assignment, (_, name, secret) => {
        const quote = secret.startsWith('\\"') ? '\\"' : /^["']/.exec(secret)?.[0] ?? '';
        return name + quote + mask + quote;
      })
      .replace(/\b(Bearer|Basic)[ \t]+[A-Za-z0-9._~+/=-]+/gi, '$1 ' + mask)
      .replace(/\b((?:https?|socks(?:4a?|5h?)?):\/\/)[^\s/?"'#\\]+@/gi, '$1' + mask + '@')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, mask);
    return known ? value.replace(known, match => key && match.length < 6 ? match : mask) : value;
  }
  function clean(value) {
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [
        cleanText(key, true), isSecretName(key) ? mask : clean(child),
      ]));
    }
    return value;
  }
  return clean;
}
