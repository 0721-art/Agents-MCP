export function problem(code, message, remedy) {
  return Object.assign(new Error(message), { code, remedy });
}

export const defaults = {
  port: 4870, maxParallel: 3, stepTimeoutMinutes: 30, agents: {}, strengths: {}, fixtures: false, proxy: '',
  // Master switch: the panel header flips this, and every MCP tool call checks it.
  enabled: true,
  gate: { policy: 'ask-once', modeA: true, modeB: true, draftRoleRequiresGate: false },
  modeB: { maxDepth: 2, maxDelegations: 12, maxParallel: 3, wallClockMinutes: 60 },
};

export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
export const fileIdentifier = value => identifier(value) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value);
export const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
export const secretName = /(?:^|[_-])(?:API[_-]?KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/i;

export function configWith(current, patch) {
  const invalid = message => { throw problem('E_CONFIG', message); };
  function inspect(value) {
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (secretName.test(key)) throw problem('E_SECRET_IN_CONFIG', 'Credentials belong in the CLI environment.');
      inspect(child);
    }
  }
  inspect(patch);
  if (!object(patch)) invalid('Configuration must be an object.');
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(defaults, key)) invalid('Unknown configuration field: ' + key);
  }
  for (const key of ['gate', 'modeB', 'agents', 'strengths']) {
    if (Object.hasOwn(patch, key) && !object(patch[key])) invalid(key + ' must be an object.');
  }
  const result = {
    ...current, ...patch, gate: { ...current.gate, ...patch.gate }, modeB: { ...current.modeB, ...patch.modeB },
  };
  for (const [key, min, max] of [['port', 0, 65535], ['maxParallel', 1, 32], ['stepTimeoutMinutes', 1, 1440]]) {
    if (!integer(result[key], min, max)) invalid('Invalid ' + key);
  }
  for (const [key, min, max] of [['maxDepth', 1, 10], ['maxDelegations', 1, 100], ['maxParallel', 1, 32], ['wallClockMinutes', 1, 1440]]) {
    if (!integer(result.modeB[key], min, max)) invalid('Invalid modeB.' + key);
  }
  if (Object.keys(result.modeB).some(key => !Object.hasOwn(defaults.modeB, key))) invalid('Unknown Mode B setting.');
  if (!['ask-once', 'auto-enable', 'deny'].includes(result.gate.policy)) invalid('Invalid gate policy.');
  for (const [key, value] of Object.entries(result.gate)) {
    if (!Object.hasOwn(defaults.gate, key) || (key !== 'policy' && typeof value !== 'boolean')) invalid('Invalid gate.' + key);
  }
  if (typeof result.fixtures !== 'boolean') invalid('fixtures must be a boolean.');
  if (typeof result.enabled !== 'boolean') invalid('enabled must be a boolean.');
  if (typeof result.proxy !== 'string' || (result.proxy.trim() && !/^(?:https?:\/\/)?[\w.-]+:\d+$/i.test(result.proxy.trim()))) {
    invalid('proxy must be empty or a host:port such as 127.0.0.1:7892.');
  }
  result.proxy = result.proxy.trim();
  for (const [id, settings] of Object.entries(result.agents)) {
    if (!identifier(id) || !object(settings)) invalid('Invalid agent override.');
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'exe' && typeof value === 'string' && value.trim()) continue;
      if (key === 'disabled' && typeof value === 'boolean') continue;
      if (key === 'env' && object(value) && Object.entries(value).every(([name, url]) => {
        if (typeof url !== 'string' || !['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(name)) return false;
        if (name === 'NO_PROXY' || !url) return true;
        try {
          const proxy = new URL(url);
          return ['http:', 'https:', 'socks:', 'socks5:'].includes(proxy.protocol)
            && !proxy.username && !proxy.password && !proxy.search && !proxy.hash && proxy.pathname === '/';
        } catch {
          return false;
        }
      })) continue;
      invalid('Invalid agent override field: ' + key);
    }
  }
  for (const [id, strength] of Object.entries(result.strengths)) {
    if (!identifier(id) || typeof strength !== 'string' || strength.length > 20_000) invalid('Invalid agent strength.');
  }
  return result;
}
