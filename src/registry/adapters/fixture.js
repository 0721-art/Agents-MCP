// Offline fixture: node fixtures/fake-agent.js --model M --effort E [--resume SID].
import { fileURLToPath } from 'node:url';
import { adapter, model } from './_common.js';

export default adapter({
  id: 'fixture', name: 'Offline fixture',
  locate: () => ({ exe: process.execPath, source: 'fixture' }),
  probe: () => ({ ok: true, models: [model('fixture-model', ['low', 'high'], 'low')] }),
  buildArgs({ model: name, effort, prompt, sessionId }) {
    const args = [fileURLToPath(new URL('../../../fixtures/fake-agent.js', import.meta.url)), '--model', name, '--effort', effort];
    if (sessionId) args.push('--resume', sessionId);
    return { args, stdin: prompt };
  },
  resumeArgs(options) { return this.buildArgs(options); },
});
