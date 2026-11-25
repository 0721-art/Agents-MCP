import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { problem } from '../config.js';

const fingerprintVersion = 2;
const question = '是否为此任务启用 Agents-MCP？';

function taskFingerprint(task) {
  if (typeof task !== 'string' || !task.trim()) throw problem('E_TASK', 'Task text is required.');
  return createHash('sha256').update(task.replace(/\r\n/g, '\n')).digest('hex');
}

function taskKey(task, taskId) {
  if (taskId !== undefined) {
    if (typeof taskId !== 'string' || !/^[\da-z][\da-z_-]{0,79}$/i.test(taskId)) {
      throw problem('E_TASK_ID', 'Invalid task ID.');
    }
    return taskId;
  }
  return taskFingerprint(task).slice(0, 16);
}

function verifyBinding(entry, fingerprint) {
  if (entry?.fingerprint && fingerprint && entry.fingerprint !== fingerprint) {
    throw problem('E_TASK_ID', 'This task ID is already bound to different task text.', 'Use a new task ID for the new task.');
  }
}

export async function createGate(store) {
  const path = join(store.dir, 'gate.json');
  // Legacy fingerprints cannot prove which whitespace the user approved.
  let entries = new Map(Object.entries(await store.readJson(path, {}))
    .filter(([, entry]) => entry?.fingerprintVersion === fingerprintVersion));
  let writes = Promise.resolve();
  function update(action) {
    const next = writes.then(async () => {
      const copy = new Map(entries);
      const result = action(copy);
      if (copy.size !== entries.size || copy.get(result.taskId) !== entries.get(result.taskId)) {
        await store.writeJson(path, Object.fromEntries(copy), { redact: false });
        entries = copy;
      }
      return result;
    });
    writes = next.catch(() => {});
    return next;
  }
  return {
    async pending() {
      await writes;
      return [...entries.values()].filter(entry => entry.status === 'confirmation_required').map(publicEntry);
    },
    check({ task, taskId, mode }, policy) {
      if ((mode === 'A' && !policy.modeA) || (mode === 'B' && !policy.modeB)) return { status: 'mode_disabled' };
      if (policy.policy === 'deny') return { status: 'denied' };
      if (policy.policy === 'auto-enable') return { status: 'enabled' };
      taskId = taskKey(task, taskId);
      const fingerprint = taskFingerprint(task);
      return update(copy => {
        const existing = copy.get(taskId);
        verifyBinding(existing, fingerprint);
        if (existing?.decision) {
          return { status: existing.decision === 'enable' ? 'enabled' : 'disabled_by_user', taskId };
        }
        if (existing) return { status: existing.status, taskId };
        const pending = {
          status: 'confirmation_required', taskId, task: store.redact(task), mode,
          question: store.redact(question),
        };
        copy.set(taskId, { ...pending, fingerprint, fingerprintVersion });
        return pending;
      });
    },
    decide({ task, taskId, decision, mode }) {
      if (!['enable', 'disable'].includes(decision)) throw problem('E_DECISION', 'Choose enable or disable.');
      if (mode !== undefined && !['A', 'B'].includes(mode)) throw problem('E_MODE', 'Choose mode A or B.');
      taskId = taskKey(task, taskId);
      return update(copy => {
        const existing = copy.get(taskId);
        if (existing) verifyBinding(existing, task === undefined ? undefined : taskFingerprint(task));
        if (existing?.decision) return { status: 'already_decided', taskId, decision: existing.decision };
        if (existing?.status !== 'confirmation_required') {
          throw problem('E_TASK_ID', 'Run the task first so the confirmation question is issued.');
        }
        const { question, ...entry } = existing;
        const decided = {
          ...entry, decision, mode: existing.mode ?? mode,
          status: decision === 'enable' ? 'enabled' : 'disabled_by_user',
        };
        copy.set(taskId, decided);
        return publicEntry(decided);
      });
    },
  };
}

function publicEntry({ fingerprint, fingerprintVersion, ...entry }) { return entry; }
