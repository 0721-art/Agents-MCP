import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args[0] === '--sleep') {
  setInterval(() => {}, 60_000);
} else if (args[0] === '--tree') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--branch', args[1]], { stdio: 'inherit' });
  child.on('exit', () => process.exit());
  setInterval(() => {}, 60_000);
} else if (args[0] === '--branch') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--sleep'], { stdio: 'inherit' });
  await writeFile(args[1], JSON.stringify([process.pid, child.pid]));
  setInterval(() => {}, 60_000);
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) prompt += chunk;
  const print = (type, result) => process.stdout.write(JSON.stringify({ type, result, session_id: 'fixture-session' }) + '\n');
  const emit = value => process.stdout.write(JSON.stringify({ ...value, session_id: 'fixture-session' }) + '\n');
  if (args.includes('--echo')) print('result', prompt);
  else if (prompt.includes('thinking-demo')) {
    emit({ type: 'item.completed', item: { type: 'reasoning', text: 'Fixture reasons about the task.' } });
    emit({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 42 } });
    print('result', 'Fixture answer\nVERDICT: PASS');
  }
  else if (args.includes('--resume')) print('result', '@@AGENTS_MCP report ' + JSON.stringify({
    summary: 'resumed with ' + (prompt.includes('delegation cap reached') ? 'delegation cap' : 'worker results'),
  }));
  else if (prompt.startsWith('Task:\ndelegate-many\n')) {
    print('result', Array.from({ length: 5 }, (_, i) => '@@AGENTS_MCP delegate ' + JSON.stringify({
      to: 'fixture', model: 'fixture-model', effort: 'low', task: 'Worker ' + i,
    })).join('\n'));
  } else if (/^Step:\nalways-changes$/m.test(prompt) ||
    (/^Step:\nchanges-then-pass$/m.test(prompt) && !prompt.includes('revised patch'))) {
    print('result', 'Please revise the patch.\nVERDICT: CHANGES_REQUESTED');
  } else if (prompt.includes('Reviewer feedback:')) print('result', 'revised patch\nVERDICT: PASS');
  else if (prompt.includes('echo-secret')) print('result', 'FIXTURE_API_KEY=' + process.env.FIXTURE_API_KEY);
  else if (prompt.startsWith('Expand this brief')) print('result', 'Responsibility: ' + prompt.split('\n\n').at(-1));
  else print('result', 'Fixture answer\nVERDICT: PASS');
}
