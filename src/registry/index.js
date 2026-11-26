import { join } from 'node:path';
import { problem } from '../config.js';
import agy from './adapters/agy.js';
import claude from './adapters/claude.js';
import codex from './adapters/codex.js';
import dsh from './adapters/dsh.js';
import fixture from './adapters/fixture.js';
import grok from './adapters/grok.js';
import omp from './adapters/omp.js';
import pi from './adapters/pi.js';

// A cached catalog is refreshed in the background once it is this old, so the panel opens
// on the previous result instead of waiting for every CLI.
const cacheFreshMs = 10 * 60 * 1000;

export function createRegistry({ store, config, env }) {
  let catalog;
  let inFlight;
  let generation = 0;
  const adapters = [codex, agy, claude, dsh, pi, omp, grok];

  async function detect(spec, settings) {
    const base = { id: spec.id, name: spec.name, available: false, models: [], warnings: [], probedAt: new Date().toISOString() };
    const overrides = Object.hasOwn(settings.agents, spec.id) ? settings.agents[spec.id] : {};
    const remedy = 'Install the CLI or set its executable override, then refresh.';
    const agentEnv = { ...env, ...spec.env({ env }), ...overrides.env };
    if (overrides.disabled) return { ...base, reason: 'Disabled in settings.', remedy: 'Enable the agent in settings.' };
    const signal = AbortSignal.timeout(15_000);
    let location;
    try {
      location = await spec.locate({ overrides, env: agentEnv, signal });
      if (!location) return { ...base, reason: 'Executable not found.', remedy };
      const { ok, ...data } = await spec.probe({ ...location, env: agentEnv, signal });
      return { ...base, ...location, ...data, available: Boolean(ok && data.models?.length) };
    } catch (error) {
      return { ...base, ...location, reason: store.redact(error.message), remedy };
    }
  }

  function probe(refresh) {
    if (inFlight) return inFlight;
    const settings = config();
    const selected = env.AGENTS_MCP_FIXTURES === '1' ? [fixture] : settings.fixtures ? [...adapters, fixture] : adapters;
    const revision = generation;
    inFlight = Promise.all(selected.map(spec => detect(spec, settings))).then(async result => {
      if (revision === generation || refresh) {
        catalog = result;
        try {
          await store.writeJson(join(store.dir, 'agents-cache.json'), result);
        } catch {
          // A read-only state directory must not break agent listing; the panel still
          // works from memory and the next successful write refreshes the file.
        }
      }
      return result;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  // Probing behind a cached answer: failures are already encoded per agent, and a rejected
  // promise must not surface as an unhandled rejection.
  function refreshInBackground(stale) {
    if (!stale || inFlight) return;
    probe(true).catch(() => {});
  }

  function stale(entries) {
    const newest = entries.reduce((latest, entry) => {
      const stamp = Date.parse(entry?.probedAt ?? '') || 0;
      return stamp > latest ? stamp : latest;
    }, 0);
    return Date.now() - newest > cacheFreshMs;
  }

  async function list({ refresh = false } = {}) {
    if (refresh) return probe(true);
    if (Array.isArray(catalog)) {
      refreshInBackground(stale(catalog));
      return catalog;
    }
    const stored = await store.readJson(join(store.dir, 'agents-cache.json'), null).catch(() => null);
    if (Array.isArray(stored) && stored.length) {
      catalog = stored;
      refreshInBackground(stale(stored));
      return catalog;
    }
    return probe(false);
  }

  return {
    list, invalidate() { generation++; catalog = undefined; },
    // True while a probe runs, so a caller can tell a cached answer from a fresh one.
    probing: () => Boolean(inFlight),
    async get({ agent, model, effort }) {
      const info = (await list()).find(entry => entry.id === agent);
      if (!info?.available) throw problem('E_AGENT_UNAVAILABLE', (agent || 'Agent') + ': ' + (info?.reason ?? 'Unknown agent.'),
        info?.remedy ?? 'List agents and select an available one.');
      const selected = info.models.find(entry => entry.id === model);
      if (!selected) throw problem('E_MODEL', 'Unknown model ' + model + ' for ' + agent + '.', 'Select a listed model.');
      if (!selected.efforts.includes(effort)) throw problem('E_EFFORT', 'Unsupported effort ' + effort + ' for ' + model + '.',
        'Choose one of: ' + selected.efforts.join(', '));
      const spec = [...adapters, fixture].find(entry => entry.id === agent);
      return { info, adapter: spec, env: { ...env, ...spec.env({ env }), ...config().agents[agent]?.env } };
    },
  };
}
