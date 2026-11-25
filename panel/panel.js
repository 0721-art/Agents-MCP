const $ = id => document.getElementById(id);
const caps = { maxDepth: '最大深度', maxDelegations: '委派次数', maxParallel: '最大并发', wallClockMinutes: '总时限（分钟）' };
const statuses = {
  available: '可用', unavailable: '不可用', pending: '等待', running: '运行中', cancelled: '已取消',
  PASS: '通过', CHANGES_REQUESTED: '待修改', BLOCKED: '受阻', FAILED: '失败', SKIPPED: '已跳过', incomplete: '未完成',
};
let agents = [];
let config;
let selectedRun;
let tab = 'agents';
let gateSignature;
let serial = 0;
const people = [];
const steps = [];
const loops = [];
const mainActor = {};
const afterGate = new Map();

function el(tag, content, className) {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  if (className) node.className = className;
  return node;
}
const group = (className, ...children) => {
  const node = el('div', undefined, className);
  node.append(...children);
  return node;
};
function button(label, action, className) {
  const node = el('button', label, className);
  node.type = 'button';
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action();
    } catch (error) {
      message(error.message, true);
    } finally {
      node.disabled = false;
    }
  });
  return node;
}
function wire(id, action) {
  const node = $(id);
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await action();
    } catch (error) {
      message(error.message, true);
    } finally {
      node.disabled = false;
    }
  });
}
function field(label, control) {
  const node = el('label', label);
  node.append(control);
  return node;
}
function input(value, change, options = {}) {
  const node = el(options.rows ? 'textarea' : 'input');
  Object.assign(node, options);
  if (node.type === 'checkbox') {
    node.checked = Boolean(value);
    node.addEventListener('change', () => change(node.checked));
  } else {
    node.value = value ?? '';
    node.addEventListener('input', () => change(node.type === 'number' ? node.valueAsNumber : node.value));
  }
  return node;
}
function select(options, value, change) {
  const node = el('select');
  for (const [key, label] of options.length ? options : [['', '无可用选项']]) {
    const opt = el('option', label);
    opt.value = key;
    node.append(opt);
  }
  if (options.some(([key]) => key === value)) node.value = value;
  node.addEventListener('change', () => change(node.value));
  return node;
}
function badge(state) {
  const node = el('span', statuses[state] ?? state, 'badge');
  node.dataset.state = state;
  return node;
}
function message(text, error = false) {
  $('message').textContent = text;
  $('message').hidden = !text;
  $('message').toggleAttribute('data-error', error);
}
async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, data === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error([value.message, value.remedy].filter(Boolean).join('\n') || '请求失败');
  return value;
}
async function switchTab(id) {
  tab = id;
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== id; });
  document.querySelectorAll('[data-tab]').forEach(node => {
    if (node.dataset.tab === id) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  message('');
  if (id === 'runs') await loadRuns();
}
document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () =>
  switchTab(node.dataset.tab).catch(error => message(error.message, true))));

function actorPicker(state, onlyAgent) {
  const wrapper = group('actor');
  const choices = agents.filter(agent => agent.available && (!onlyAgent || onlyAgent === agent.id));
  function render() {
    const agent = choices.find(entry => entry.id === state.agent) ?? choices[0];
    const model = agent?.models.find(entry => entry.id === state.model) ?? agent?.models[0];
    state.agent = agent?.id ?? '';
    state.model = model?.id ?? '';
    if (!model?.efforts.includes(state.effort)) state.effort = model?.defaultEffort ?? '';
    const pickAgent = field('Agent', select(choices.map(info => [info.id, info.name]), state.agent, value => {
      state.agent = value;
      state.model = '';
      state.effort = '';
      render();
      wrapper.querySelector('select').focus();
    }));
    const pickModel = field('模型', select((agent?.models ?? []).map(entry => [entry.id, entry.label]), state.model, value => {
      state.model = value;
      state.effort = '';
      render();
      wrapper.querySelectorAll('select')[onlyAgent ? 0 : 1].focus();
    }));
    const pickEffort = field('思考强度', select((model?.efforts ?? []).map(value => [value, value]), state.effort, value => { state.effort = value; }));
    wrapper.replaceChildren(...(onlyAgent ? [] : [pickAgent]), pickModel, pickEffort);
  }
  render();
  return wrapper;
}

const agentSelections = new Map();
function renderAgents() {
  const cards = agents.map(agent => {
    const overrides = config.agents[agent.id] ?? {};
    const exe = input(overrides.exe, () => {}, { placeholder: '使用自动检测路径' });
    const proxy = input(overrides.env?.HTTPS_PROXY, () => {}, { placeholder: '可选' });
    const httpProxy = input(overrides.env?.HTTP_PROXY, () => {}, { placeholder: '可选' });
    const state = agentSelections.get(agent.id) ?? {};
    agentSelections.set(agent.id, state);
    const card = el('article', undefined, 'agent');
    card.append(group('agent-heading', el('h3', agent.name), badge(agent.available ? 'available' : 'unavailable')),
      el('p', agent.exe || '未检测到可执行文件', 'path'));
    if (agent.available) card.append(actorPicker(state, agent.id));
    if (agent.reason) card.append(el('p', [agent.reason, agent.remedy].filter(Boolean).join(' ')));
    for (const warning of agent.warnings ?? []) card.append(el('small', warning));
    card.append(field('可执行文件覆盖', exe), group('fields', field('HTTP_PROXY', httpProxy), field('HTTPS_PROXY', proxy)),
      button('保存覆盖', async () => {
        const env = { ...overrides.env, HTTP_PROXY: httpProxy.value.trim(), HTTPS_PROXY: proxy.value.trim() };
        const value = { ...overrides, env };
        if (exe.value.trim()) value.exe = exe.value.trim();
        else delete value.exe;
        await api('/agents/' + agent.id + '/override', 'PUT', value);
        await loadAgents(true);
        message('Agent 设置已保存。');
      }));
    return card;
  });
  $('agent-list').replaceChildren(...cards);
}
async function loadAgents(refresh = false) {
  [agents, config] = await Promise.all([api('/agents' + (refresh ? '?refresh=1' : '')), api('/config')]);
  renderAgents();
  renderPeople();
  $('main-actor').replaceChildren(actorPicker(mainActor));
  renderStrengths();
}

function remove(rows, entry, render) {
  rows.splice(rows.indexOf(entry), 1);
  render();
}
function row(label, action, ...children) {
  return group('editor-row', ...children, group('actions', button(label, action)));
}
function renderPeople() {
  $('people').replaceChildren(...people.map(person => {
    const responsibilities = input(person.responsibility, text => { person.responsibility = text; }, { rows: 3 });
    const draft = button('帮我写职责', async () => {
      const args = { ...person, brief: person.responsibility || person.role, ...draftContext() };
      const launch = async () => {
        const started = await api('/draft-role', 'POST', args);
        if (await waitForGate(started, launch)) return;
        for (;;) {
          await new Promise(resolve => setTimeout(resolve, 900));
          const result = await api('/runs/' + started.runId);
          if (!result.finishedAt) continue;
          if (result.status !== 'PASS') throw new Error(result.answer || '生成职责失败。');
          person.responsibility = result.answer;
          responsibilities.value = result.answer;
          renderPeople();
          message('职责已填入。');
          return;
        }
      };
      await launch();
    });
    return row('移除参与者', () => {
      remove(people, person, renderPeople);
      renderSteps();
    }, group('fields', field('参与者 ID', el('span', person.id)), field('角色', input(person.role, text => { person.role = text; })),
      field('允许写入', input(person.writes, checked => { person.writes = checked; }, { type: 'checkbox' }))),
    actorPicker(person), field('职责', responsibilities), group('actions', draft));
  }));
}
function draftContext() {
  const fields = taskFields('flow');
  if (!fields.task.trim()) delete fields.task;
  return fields;
}
const words = text => text.split(/[\s,，]+/).filter(Boolean);
function renderSteps() {
  $('steps').replaceChildren(...steps.map((step, index) => {
    const choices = [['', '选择参与者'], ...people.map(person => [person.id, person.id + (person.role ? ' · ' + person.role : '')])];
    const dependency = el('fieldset');
    dependency.append(el('legend', '依赖步骤'), group('chips', ...steps.filter(other => other !== step).map(other =>
      field(other.id, input(step.dependsOn.includes(other.id), checked => {
        step.dependsOn = checked ? [...step.dependsOn, other.id] : step.dependsOn.filter(id => id !== other.id);
      }, { type: 'checkbox' })))));
    const move = (offset) => {
      const other = index + offset;
      if (!steps[other]) return;
      [steps[index], steps[other]] = [steps[other], steps[index]];
      renderSteps();
    };
    return row('移除步骤', () => {
      for (const other of steps) other.dependsOn = other.dependsOn.filter(id => id !== step.id);
      for (let i = loops.length - 1; i >= 0; i--) if ([loops[i].from, loops[i].to].includes(step.id)) loops.splice(i, 1);
      remove(steps, step, renderSteps);
    }, group('fields', field('步骤 ID', el('span', step.id)),
      field('参与者', select(choices, step.participant, value => { step.participant = value; }))),
    field('步骤任务', input(step.task, value => { step.task = value; }, { rows: 2 })), dependency,
    group('fields', field('输入名（逗号分隔）', input(step.inputs.join(', '), value => { step.inputs = words(value); })),
      field('产物名（逗号分隔）', input(step.produces.join(', '), value => { step.produces = words(value); }))),
    group('actions', button('上移', () => move(-1)), button('下移', () => move(1))));
  }));
  renderLoops();
}
function renderLoops() {
  const choices = [['', '选择步骤'], ...steps.map(step => [step.id, step.id])];
  $('loops').replaceChildren(...loops.map(loop => row('移除循环', () => remove(loops, loop, renderLoops), group('fields',
    field('评审步骤', select(choices, loop.from, value => { loop.from = value; })),
    field('重跑起点', select(choices, loop.to, value => { loop.to = value; })),
    field('结束条件', select([['PASS', 'PASS']], loop.until, value => { loop.until = value; })),
    field('最多轮数', input(loop.maxRounds, value => { loop.maxRounds = value; }, { type: 'number', min: 1, max: 10 }))))));
}
wire('add-person', () => { people.push({ id: 'p-' + ++serial, role: '', responsibility: '', writes: false }); renderPeople(); renderSteps(); });
wire('add-step', () => {
  steps.push({ id: 's-' + ++serial, participant: people[0]?.id ?? '', task: '', dependsOn: [], inputs: ['task'], produces: [] });
  renderSteps();
});
wire('add-loop', () => { loops.push({ from: steps.at(-1)?.id ?? '', to: steps[0]?.id ?? '', until: 'PASS', maxRounds: 2 }); renderLoops(); });
const taskFields = prefix => ({ task: $(prefix + '-task').value, cwd: $(prefix + '-cwd').value.trim() || undefined });
const flow = () => ({ ...taskFields('flow'), participants: people, steps, loops });
wire('validate', async () => {
  const plan = await api('/flow/validate', 'POST', flow());
  message(plan.ok ? '有效。执行顺序 ' + plan.order.join(' → ')
    : plan.errors.map(error => error.path + ' · ' + error.message).join('\n'), !plan.ok);
});
wire('start-flow', () => launchRun('/flow/run', structuredClone(flow())));

const capValues = {};
function renderSettings() {
  $('policy').value = config.gate.policy;
  $('enable-a').checked = config.gate.modeA;
  $('enable-b').checked = config.gate.modeB;
  $('draft-gate').checked = config.gate.draftRoleRequiresGate;
  $('port').value = config.port;
  $('step-timeout').value = config.stepTimeoutMinutes;
  $('parallel').value = config.maxParallel;
  $('state-dir').value = config.stateDir;
  $('caps').replaceChildren(...Object.entries(caps).map(([key, label]) => {
    const value = capValues[key] ?? config.modeB[key];
    capValues[key] = value;
    return field(label, input(value, changed => { capValues[key] = changed; }, { type: 'number', min: 1, max: config.modeB[key] }));
  }));
}
function renderStrengths() {
  $('strengths').replaceChildren(...agents.map(agent => {
    const node = input(config.strengths[agent.id], () => {}, { rows: 2 });
    node.dataset.agent = agent.id;
    return field(agent.name, node);
  }));
}
wire('save-strengths', async () => {
  const strengths = Object.fromEntries([...$('strengths').querySelectorAll('textarea')].map(node => [node.dataset.agent, node.value]));
  config.strengths = await api('/strengths', 'PUT', strengths);
  message('Agent 专长已保存。');
});
wire('start-delegate', () => launchRun('/delegate', {
  ...taskFields('delegate'), ...mainActor, ...capValues, writes: $('delegate-writes').checked,
}));
wire('save-settings', async () => {
  config = { ...config, ...await api('/config', 'PUT', {
    gate: { policy: $('policy').value, modeA: $('enable-a').checked, modeB: $('enable-b').checked, draftRoleRequiresGate: $('draft-gate').checked },
    port: $('port').valueAsNumber, stepTimeoutMinutes: $('step-timeout').valueAsNumber, maxParallel: $('parallel').valueAsNumber,
  }) };
  renderSettings();
  message('设置已保存。');
});
wire('refresh', () => loadAgents(true));

async function loadGate() {
  const pending = await api('/gate/pending');
  const signature = pending.map(entry => entry.taskId).join(',');
  if (signature === gateSignature) return;
  gateSignature = signature;
  $('gate').hidden = !pending.length;
  $('gate').replaceChildren(...pending.map(entry => {
    const decide = async decision => {
      const result = await api('/gate', 'POST', { taskId: entry.taskId, decision });
      const resume = afterGate.get(entry.taskId);
      afterGate.delete(entry.taskId);
      await loadGate();
      if (resume && (result.status === 'enabled' || result.decision === 'enable')) await resume();
      else message(result.decision === 'enable' ? '已启用此任务。' : '授权决定已保存。');
    };
    return group('gate-entry', group('subheading', el('strong', entry.question), group('actions',
      button('启用', () => decide('enable'), 'primary'), button('禁用', () => decide('disable')))), el('p', entry.task));
  }));
}
async function waitForGate(result, launch) {
  if (result.status === 'confirmation_required') {
    afterGate.set(result.taskId, launch);
    await loadGate();
    message('请在上方确认是否启用此任务。');
    return true;
  }
  if (!result.runId) {
    const messages = { mode_disabled: '该模式已关闭。', denied: '当前授权策略拒绝执行。', disabled_by_user: '此任务已禁用。' };
    throw new Error(messages[result.status] ?? '服务未启动任务。');
  }
  return false;
}
async function launchRun(path, data) {
  const result = await api(path, 'POST', data);
  if (await waitForGate(result, () => launchRun(path, data))) return;
  selectedRun = result.runId;
  await switchTab('runs');
}

async function loadRuns() {
  const runs = await api('/runs');
  if (tab !== 'runs') return;
  $('run-list').replaceChildren(...(runs.length ? runs.map(run => {
    const node = button('', async () => { selectedRun = run.runId; await loadRuns(); }, 'run-row');
    node.append(el('span', run.task), badge(run.status));
    node.setAttribute('aria-pressed', String(selectedRun === run.runId));
    return node;
  }) : [el('p', '暂无运行记录。')]));
  if (selectedRun) await loadRun(selectedRun);
}
async function loadRun(id) {
  const run = await api('/runs/' + id);
  if (tab !== 'runs' || selectedRun !== id) return;
  const heading = group('subheading', el('h3', run.task), badge(run.status));
  const table = el('table');
  const header = table.createTHead().insertRow();
  for (const title of ['步骤', '状态', '轮次', '耗时']) header.append(el('th', title));
  for (const [step, status] of Object.entries(run.steps)) {
    const tr = table.insertRow();
    for (const value of [step, statuses[status.status] ?? status.status, status.round, status.durationMs === undefined ? '—' : (status.durationMs / 1000).toFixed(1) + ' 秒']) {
      tr.insertCell().textContent = value;
    }
  }
  const links = el('ul');
  const link = (label, path) => {
    const item = el('li');
    const anchor = el('a', label);
    anchor.href = '/api/runs/' + id + '/files/' + path;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    item.append(anchor);
    links.append(item);
  };
  run.artifacts.forEach(name => link(name, 'artifacts/' + encodeURIComponent(name)));
  if (run.reportPath) link('查看报告', 'report.md');
  const log = el('pre', run.events.map(event =>
    [event.step, event.type, event.text || (event.data && JSON.stringify(event.data))].filter(Boolean).join(' · ')).join('\n') || '等待事件…');
  const oldLog = $('run-detail').querySelector('pre');
  const scroll = oldLog && oldLog.scrollTop + oldLog.clientHeight < oldLog.scrollHeight - 24 ? oldLog.scrollTop : null;
  const children = [heading, el('p', '工作目录 · ' + run.cwd, 'path'), table];
  if (Array.isArray(run.delegationTree)) {
    const branches = parent => {
      const list = el('ul');
      for (const edge of run.delegationTree.filter(edge => edge.parent === parent)) {
        const item = el('li', edge.id + ' · ' + (statuses[edge.status] ?? edge.status));
        const descendants = branches(edge.id);
        if (descendants.childElementCount) item.append(descendants);
        list.append(item);
      }
      return list;
    };
    const tree = branches('main');
    children.push(el('h3', '委派树'), tree.childElementCount ? tree : el('p', '暂无委派。'));
  }
  children.push(el('h3', '最近事件'), log);
  if (links.childElementCount) children.push(el('h3', '产物与报告'), links);
  if (!run.finishedAt) children.push(group('actions', button('取消运行', async () => {
    await api('/runs/' + id + '/cancel', 'POST', {});
    await loadRuns();
  })));
  $('run-detail').replaceChildren(...children);
  log.scrollTop = scroll ?? log.scrollHeight;
}
wire('refresh-runs', loadRuns);

loadAgents().then(renderSettings).catch(error => message(error.message, true));
function poll(action, ms) {
  const tick = async () => {
    try {
      await action();
    } catch (error) {
      message(error.message, true);
    }
    setTimeout(tick, ms);
  };
  void tick();
}
poll(loadGate, 1500);
poll(() => tab === 'runs' && loadRuns(), 1000);
