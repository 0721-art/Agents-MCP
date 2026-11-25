// Presets are the user's own data, not shipped content: they live in
// <stateDir>/presets.json and nothing about them belongs in the repository.
// This module only validates, reads and writes that file.
import { join } from 'node:path';
import { identifier, problem } from './config.js';

const maxPresets = 50;

export const presetPath = dir => join(dir, 'presets.json');

export function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'preset';
}

function usableFlow(flow) {
  return Boolean(flow) && typeof flow === 'object'
    && Array.isArray(flow.participants) && flow.participants.length
    && Array.isArray(flow.steps) && flow.steps.length
    && typeof flow.task === 'string';
}

/** Drops anything that could not be shown or run, instead of failing the whole list. */
export function normalizePresets(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw problem('E_PRESET', 'presets.json must contain an array of presets.');
  const seen = new Set();
  const presets = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 120) : '';
    if (!name || !usableFlow(entry.flow)) continue;
    const wanted = typeof entry.id === 'string' && identifier(entry.id) ? entry.id : slug(name);
    let id = wanted;
    for (let n = 2; seen.has(id); n += 1) id = wanted + '-' + n;
    seen.add(id);
    presets.push({
      id, name,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 2000) : '',
      flow: entry.flow,
    });
  }
  return presets.slice(0, maxPresets);
}

export async function readPresets(store) {
  return normalizePresets(await store.readJson(presetPath(store.dir), []));
}

export async function savePreset(store, input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name) throw problem('E_PRESET', 'Give the preset a name.');
  if (!usableFlow(input?.flow)) {
    throw problem('E_PRESET', 'A preset needs task text, at least one participant and at least one step.');
  }
  const existing = await readPresets(store);
  const id = slug(name);
  const preset = {
    id, name: name.slice(0, 120),
    description: typeof input.description === 'string' ? input.description.slice(0, 2000) : '',
    flow: input.flow,
  };
  // Saving under an existing name overwrites that preset instead of piling up copies.
  const next = [...existing.filter(entry => entry.id !== id), preset].slice(-maxPresets);
  await store.writeJson(presetPath(store.dir), next);
  return { preset, presets: next };
}

export async function deletePreset(store, id) {
  const existing = await readPresets(store);
  const next = existing.filter(entry => entry.id !== id);
  await store.writeJson(presetPath(store.dir), next);
  return next;
}
