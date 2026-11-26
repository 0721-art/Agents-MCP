const $ = id => document.getElementById(id);
const slot = name => document.querySelector('[data-slot="' + name + '"]');
const caps = { maxDepth: '最大深度', maxDelegations: '委派次数', maxParallel: '最大并发', wallClockMinutes: '总时限（分钟）' };
const statuses = {
  available: '可用', unavailable: '不可用', pending: '等待', running: '运行中', cancelled: '已取消',
  PASS: '通过', CHANGES_REQUESTED: '待修改', BLOCKED: '受阻', FAILED: '失败', SKIPPED: '已跳过',
  incomplete: '未完成', refused: '已拒绝', error: '错误',
  connected: '使用中', configured: '已注册', disabled: '已停用', unconfigured: '未接入',
};
const runKinds = { A: '模式 A · 编排', B: '模式 B · 委派', draft: '职责生成' };

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
// Details toggles survive the one-second refresh, otherwise opening a step collapses immediately.
const thinkingOpen = new Map();
// Session-local plan cache lets Mode A run details draw true dependsOn & loop edges without extra requests.
const flowPlans = new Map();
const MAX_PLANS = 20;
const MAX_ROUTE_NODES = 24;
let flowPreviewAnimate = false;

// SVG prototypes live inside <template> so cloned nodes inherit SVG namespace with zero namespace literals.
const routeTpl = document.querySelector('template[data-route-template]');
const svgProto = routeTpl?.content.querySelector('svg');
const edgesGroupProto = routeTpl?.content.querySelector('g.route-edges');
const packetsGroupProto = routeTpl?.content.querySelector('g.route-packets');
const pathProto = routeTpl?.content.querySelector('path.route-edge-proto');
const portProto = routeTpl?.content.querySelector('circle.route-port-proto');

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
  const cls = className ? (className.split(/\s+/).includes('btn') ? className : 'btn ' + className) : 'btn';
  const node = el('button', label, cls);
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
  const isCheck = control.tagName === 'INPUT' && control.type === 'checkbox';
  if (isCheck) {
    const node = el('label', undefined, 'check');
    node.append(control, el('span', label));
    return node;
  }
  const node = el('label', undefined, 'field');
  node.append(el('span', label, 'field-label'), control);
  return node;
}
function input(value, change, options = {}) {
  const node = el(options.rows ? 'textarea' : 'input');
  Object.assign(node, options);
  if (node.type !== 'checkbox') node.classList.add('control');
  if (node.type === 'number') node.classList.add('mono');
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
  const node = el('select', undefined, 'control');
  for (const [key, label] of options.length ? options : [['', '无可用选项']]) {
    const opt = el('option', label);
    opt.value = key;
    node.append(opt);
  }
  if (options.some(([key]) => key === value)) node.value = value;
  node.addEventListener('change', () => change(node.value));
  return node;
}
function toneOf(state) {
  if (state === 'available' || state === 'PASS' || state === 'connected') return 'ok';
  if (state === 'running') return 'run';
  if (state === 'CHANGES_REQUESTED' || state === 'cancelled' || state === 'incomplete' || state === 'configured') return 'warn';
  if (state === 'unavailable' || state === 'FAILED' || state === 'BLOCKED' || state === 'error' || state === 'refused' || state === 'disabled') return 'bad';
  return 'idle';
}
function statusText(state, scope = 'step') {
  if (scope === 'run' && state === 'PASS') return '已完成';
  return statuses[state] ?? state ?? '—';
}
function badge(state, scope = 'step') {
  const node = el('span', statusText(state, scope), 'pill');
  node.dataset.state = state ?? '';
  node.dataset.tone = toneOf(state);
  return node;
}
function updateBadge(node, state, scope = 'step') {
  const text = statusText(state, scope);
  const tone = toneOf(state);
  if (node.textContent !== text) node.textContent = text;
  if (node.dataset.state !== (state ?? '')) node.dataset.state = state ?? '';
  if (node.dataset.tone !== tone) node.dataset.tone = tone;
}
function message(text, error = false) {
  const box = $('message');
  box.textContent = text;
  box.hidden = !text;
  box.toggleAttribute('data-error', error);
}
async function api(path, method = 'GET', data) {
  const response = await fetch('/api' + path, data === undefined ? { method } : {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (!response.ok) throw new Error([value.message, value.remedy].filter(Boolean).join('\n') || '请求失败');
  return value;
}

function formatClock(iso) {
  if (!iso) return '—';
  const when = new Date(iso);
  return Number.isNaN(when.getTime()) ? '—' : when.toLocaleTimeString('zh-CN', { hour12: false });
}
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return Math.round(ms) + 'ms';
  const sec = ms / 1000;
  if (sec < 60) return sec.toFixed(1) + 's';
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return mins + 'm ' + String(rem).padStart(2, '0') + 's';
}
function runDurationMs(run) {
  if (!run?.startedAt) return undefined;
  const start = Date.parse(run.startedAt);
  if (Number.isNaN(start)) return undefined;
  const end = run.finishedAt ? Date.parse(run.finishedAt) : (run.status === 'running' ? Date.now() : NaN);
  return Number.isNaN(end) ? undefined : Math.max(0, end - start);
}

// Appbar dynamic slots
function renderAppbar() {
  const addrEl = slot('addr');
  if (addrEl) addrEl.textContent = window.location.host || '127.0.0.1';
  const verEl = slot('version');
  const ver = config?.version || updateInfo?.current || '';
  if (verEl) {
    verEl.textContent = ver ? 'v' + ver : '';
    verEl.hidden = !ver;
  }
}

// A newer release is announced once per page load; 稍后 hides it until the next reload.
// Only a git checkout can update itself — a packaged exe opens the release page instead.
let updateInfo;
let updateDismissed = false;
function renderUpdate() {
  renderAppbar();
  const chip = slot('update-chip');
  if (chip) {
    if (updateInfo?.newer) {
      chip.textContent = '有新版本 v' + updateInfo.latest;
      chip.hidden = false;
    } else {
      chip.hidden = true;
    }
  }
  const box = $('update');
  box.replaceChildren();
  if (!updateInfo?.newer || updateDismissed) {
    box.hidden = true;
    return;
  }
  const link = el('a', '发布说明');
  link.href = updateInfo.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  const label = updateInfo.packaged ? '立即更新到 v' : '更新到 v';
  const action = updateInfo.canSelfUpdate
    ? button(label + updateInfo.latest, async () => {
      const result = await api('/update/apply', 'POST', {});
      updateDismissed = true;
      renderUpdate();
      message(result.message || result.restart || '已更新到最新版本，重启服务后生效。');
      if (result.restarting && result.restart === 'panel' && window.chrome?.webview) {
        // The window host was replaced too, so it has to relaunch itself; it starts the new
        // service and shows this same page again.
        window.chrome.webview.postMessage('agents-mcp:restart');
      } else if (result.restarting) {
        // A service-only install restarts itself on the same port; wait, then reload so the
        // panel talks to the new version.
        setTimeout(() => window.location.reload(), 5000);
      }
    }, 'btn-primary btn-sm')
    : button('打开发布页', async () => {
      window.open(updateInfo.url, '_blank', 'noopener');
    }, 'btn-primary btn-sm');
  box.append(
    el('span', '发现新版本 v' + updateInfo.latest + '（当前 v' + updateInfo.current + '）', 'update-text'),
    link,
    action,
    button('稍后', async () => {
      updateDismissed = true;
      renderUpdate();
    }, 'btn-ghost btn-sm'),
  );
  box.hidden = false;
}
slot('update-chip')?.addEventListener('click', () => {
  if (!updateInfo?.newer) return;
  updateDismissed = false;
  renderUpdate();
  $('update').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
async function loadUpdate(fresh = false) {
  try {
    updateInfo = await api('/update' + (fresh ? '?fresh=1' : ''));
    renderUpdate();
    // A failed check is not "up to date": say so only when the user asked for it.
    if (fresh && updateInfo.proxy) message('已通过代理 ' + updateInfo.proxy + ' 检查更新。');
    if (fresh && updateInfo.error) message('检查更新失败：' + updateInfo.error, true);
    else if (fresh && !updateInfo.newer) message('已是当前最新版本 v' + updateInfo.current + '。');
  } catch (error) {
    message(error.message, true);
  }
}

async function switchTab(id) {
  tab = id;
  if (id !== 'flow' && flowPreviewAnimate) {
    flowPreviewAnimate = false;
    syncFlowPreviewToggle();
  }
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== id; });
  document.querySelectorAll('[data-tab]').forEach(node => {
    if (node.dataset.tab === id) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  message('');
  if (id === 'flow') scheduleFlowGraph();
  if (id === 'runs') {
    await loadRuns();
    if (runDetailState?.routeFigure) scheduleRouteRender(runDetailState.routeFigure);
  }
  if (id === 'route') await loadRoutePage();
}
document.querySelectorAll('[data-tab]').forEach(node => node.addEventListener('click', () =>
  switchTab(node.dataset.tab).catch(error => message(error.message, true))));

function actorPicker(state, onlyAgent, onChange) {
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
      if (onChange) onChange();
    }));
    const pickModel = field('模型', select((agent?.models ?? []).map(entry => [entry.id, entry.label]), state.model, value => {
      state.model = value;
      state.effort = '';
      render();
      wrapper.querySelectorAll('select')[onlyAgent ? 0 : 1].focus();
      if (onChange) onChange();
    }));
    const pickEffort = field('思考强度', select((model?.efforts ?? []).map(value => [value, value]), state.effort, value => {
      state.effort = value;
      if (onChange) onChange();
    }));
    wrapper.replaceChildren(...(onlyAgent ? [] : [pickAgent]), pickModel, pickEffort);
  }
  render();
  return wrapper;
}

const agentSelections = new Map();
function agentLabel(id) {
  return agents.find(entry => entry.id === id)?.name || id;
}
function renderAgents() {
  if (!agents.length) {
    $('agent-list').replaceChildren(group('empty',
      el('p', '没有检测到可用的 Agent', 'empty-title'),
      el('p', '本机安装 Codex / Claude Code / DSH 等 CLI 后，点击重新检测。', 'hint'),
      button('重新检测', () => loadAgents(true), 'btn-primary btn-sm')));
    return;
  }
  const cards = agents.map(agent => {
    const overrides = config.agents[agent.id] ?? {};
    const exe = input(overrides.exe, () => {}, { placeholder: '使用自动检测路径' });
    exe.classList.add('mono');
    const proxy = input(overrides.env?.HTTPS_PROXY, () => {}, { placeholder: '可选' });
    proxy.classList.add('mono');
    const httpProxy = input(overrides.env?.HTTP_PROXY, () => {}, { placeholder: '可选' });
    httpProxy.classList.add('mono');
    const state = agentSelections.get(agent.id) ?? {};
    agentSelections.set(agent.id, state);
    const card = el('article', undefined, 'card agent-card');
    card.append(
      group('agent-head', el('h2', agent.name, 'agent-name'), badge(agent.available ? 'available' : 'unavailable')),
      el('p', agent.exe || '未检测到可执行文件', 'path'),
    );
    if (agent.available) card.append(actorPicker(state, agent.id));
    if (agent.reason) card.append(el('p', [agent.reason, agent.remedy].filter(Boolean).join(' '), 'hint bad'));
    for (const warning of agent.warnings ?? []) card.append(el('p', warning, 'hint warn-text'));

    const details = el('details', undefined, 'agent-override');
    const hasOverride = Boolean(overrides.exe || overrides.env?.HTTP_PROXY || overrides.env?.HTTPS_PROXY);
    if (!agent.available || hasOverride) details.open = true;
    details.append(
      el('summary', '路径与代理覆盖'),
      group('agent-override-body',
        field('可执行文件覆盖', exe),
        group('fields', field('HTTP_PROXY', httpProxy), field('HTTPS_PROXY', proxy)),
        group('actions', button('保存覆盖', async () => {
          const env = { ...overrides.env, HTTP_PROXY: httpProxy.value.trim(), HTTPS_PROXY: proxy.value.trim() };
          const value = { ...overrides, env };
          if (exe.value.trim()) value.exe = exe.value.trim();
          else delete value.exe;
          await api('/agents/' + agent.id + '/override', 'PUT', value);
          await loadAgents(true);
          message('Agent 设置已保存。');
        }, 'btn-sm')),
      ),
    );
    card.append(details);
    return card;
  });
  $('agent-list').replaceChildren(...cards);
}

// One switch for the whole server: it is the same flag every tool call checks, so flipping
// it here changes what agents see on their very next call.
function renderSwitch() {
  const node = $('mcp-switch');
  if (!node) return;
  const on = config?.enabled !== false;
  node.textContent = on ? 'Agents-MCP 已启用' : 'Agents-MCP 已停用';
  node.classList.toggle('on', on);
  node.setAttribute('aria-pressed', String(on));
}
async function toggleSwitch() {
  const next = config?.enabled === false;
  if (!next && !window.confirm('停用后 Codex / DSH / Claude Code 的 agents_* 调用都会失败，直到重新启用。继续？')) return;
  config = { ...config, ...await api('/config', 'PUT', { enabled: next }) };
  renderSwitch();
  message(next ? 'Agents-MCP 已启用：agent 下次调用就能看到「已启用」。' : 'Agents-MCP 已停用：工具调用会被拒绝，直到重新启用。');
}

async function loadAgents(refresh = false) {
  [agents, config] = await Promise.all([api('/agents' + (refresh ? '?refresh=1' : '')), api('/config')]);
  renderAppbar();
  renderSwitch();
  renderAgents();
  renderDraftActor();
  renderPeople();
  $('main-actor').replaceChildren(actorPicker(mainActor));
  renderStrengths();
  scheduleFlowGraph();
}

function remove(rows, entry, render) {
  const idx = rows.indexOf(entry);
  if (idx >= 0) rows.splice(idx, 1);
  render();
}
const draftActor = { agent: '', model: '', effort: '' };
function renderDraftActor() {
  const wrapper = $('draft-actor');
  const options = [['', '跟随参与者自己的 Agent'], ...agents.filter(agent => agent.available).map(agent => [agent.id, agent.name])];
  const fields = [field('职责代笔', select(options, draftActor.agent, value => {
    draftActor.agent = value;
    draftActor.model = '';
    draftActor.effort = '';
    renderDraftActor();
  }))];
  const agent = agents.find(entry => entry.id === draftActor.agent);
  if (agent) {
    const model = agent.models.find(entry => entry.id === draftActor.model) ?? agent.models[0];
    draftActor.model = model?.id ?? '';
    if (!model?.efforts.includes(draftActor.effort)) draftActor.effort = model?.defaultEffort ?? '';
    fields.push(field('模型', select(agent.models.map(entry => [entry.id, entry.label]), draftActor.model, value => {
      draftActor.model = value;
      draftActor.effort = '';
      renderDraftActor();
    })), field('思考强度', select((model?.efforts ?? []).map(value => [value, value]), draftActor.effort, value => { draftActor.effort = value; })));
  }
  wrapper.replaceChildren(...fields);
}
function draftPerson(person) {
  return draftActor.agent
    ? { agent: draftActor.agent, model: draftActor.model, effort: draftActor.effort }
    : { agent: person.agent, model: person.model, effort: person.effort };
}
function renderPeople() {
  if (!people.length) {
    $('people').replaceChildren(group('empty',
      el('p', '暂无参与者', 'empty-title'),
      el('p', '添加至少一名参与者，并在右侧为它分配执行步骤。', 'hint'),
      button('添加参与者', () => $('add-person').click(), 'btn-sm')));
    scheduleFlowGraph();
    return;
  }
  $('people').replaceChildren(...people.map(person => {
    const responsibilities = input(person.responsibility, text => { person.responsibility = text; }, { rows: 3, placeholder: '描述该参与者的职责范围与输出要求' });
    const draft = button('帮我写职责', async () => {
      const writer = draftPerson(person);
      if (!writer.agent || !writer.model) {
        message('先给参与者选好 Agent，或在「职责代笔」里指定。');
        return;
      }
      const args = { ...person, ...writer, brief: person.responsibility || person.role, ...draftContext() };
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
    }, 'btn-sm');

    const roleInput = input(person.role, text => {
      person.role = text;
      scheduleFlowGraph();
    }, { placeholder: '如：实现工程师 / 评审者' });
    const writesCheck = input(person.writes, checked => {
      person.writes = checked;
      scheduleFlowGraph();
    }, { type: 'checkbox' });

    return group('editor-row',
      group('editor-row-head',
        el('span', person.id, 'editor-id mono'),
        button('移除参与者', () => {
          remove(people, person, renderPeople);
          renderSteps();
        }, 'btn-ghost btn-sm')),
      group('fields',
        field('角色', roleInput),
        field('允许写入', writesCheck)),
      actorPicker(person, undefined, () => scheduleFlowGraph()),
      field('职责', responsibilities),
      group('editor-row-foot', group('actions', draft)));
  }));
  scheduleFlowGraph();
}
function draftContext() {
  const fields = taskFields('flow');
  if (!fields.task.trim()) delete fields.task;
  return fields;
}
const words = text => text.split(/[\s,，]+/).filter(Boolean);
function renderSteps() {
  if (!steps.length) {
    $('steps').replaceChildren(group('empty',
      el('p', '暂无步骤', 'empty-title'),
      el('p', '添加步骤并指定参与者与依赖关系，上方路由图将实时同步。', 'hint'),
      button('添加步骤', () => $('add-step').click(), 'btn-sm')));
    renderLoops();
    scheduleFlowGraph();
    return;
  }
  $('steps').replaceChildren(...steps.map((step, index) => {
    const choices = [['', '选择参与者'], ...people.map(person => [person.id, person.id + (person.role ? ' · ' + person.role : '')])];
    const dependency = el('fieldset', undefined, 'dep-group');
    const others = steps.filter(other => other !== step);
    dependency.append(el('legend', '依赖步骤'),
      others.length
        ? group('chips', ...others.map(other => {
          const chip = el('label', undefined, 'chip');
          const box = input(step.dependsOn.includes(other.id), checked => {
            step.dependsOn = checked ? [...step.dependsOn, other.id] : step.dependsOn.filter(id => id !== other.id);
            scheduleFlowGraph();
          }, { type: 'checkbox' });
          chip.append(box, el('span', other.id, 'mono'));
          return chip;
        }))
        : el('p', '添加更多步骤后可设置前置依赖。', 'hint'));

    const move = offset => {
      const other = index + offset;
      if (!steps[other]) return;
      [steps[index], steps[other]] = [steps[other], steps[index]];
      renderSteps();
    };
    const upBtn = button('上移', () => move(-1), 'btn-ghost btn-sm');
    const downBtn = button('下移', () => move(1), 'btn-ghost btn-sm');
    if (index === 0) upBtn.disabled = true;
    if (index === steps.length - 1) downBtn.disabled = true;

    return group('editor-row',
      group('editor-row-head',
        el('span', step.id, 'editor-id mono'),
        button('移除步骤', () => {
          for (const other of steps) other.dependsOn = other.dependsOn.filter(id => id !== step.id);
          for (let i = loops.length - 1; i >= 0; i--) if ([loops[i].from, loops[i].to].includes(step.id)) loops.splice(i, 1);
          remove(steps, step, renderSteps);
        }, 'btn-ghost btn-sm')),
      group('fields',
        field('参与者', select(choices, step.participant, value => {
          step.participant = value;
          scheduleFlowGraph();
        }))),
      field('步骤任务', input(step.task, value => { step.task = value; }, { rows: 2, placeholder: '该步骤需要完成什么？' })),
      dependency,
      group('fields',
        field('输入名（逗号分隔）', input(step.inputs.join(', '), value => { step.inputs = words(value); })),
        field('产物名（逗号分隔）', input(step.produces.join(', '), value => { step.produces = words(value); }))),
      group('editor-row-foot', group('actions', upBtn, downBtn)));
  }));
  renderLoops();
  scheduleFlowGraph();
}
function renderLoops() {
  if (!loops.length) {
    $('loops').replaceChildren(el('p', '尚未配置评审循环；需要「评审不通过则回退重跑」时点击右上角添加。', 'hint'));
    scheduleFlowGraph();
    return;
  }
  const choices = [['', '选择步骤'], ...steps.map(step => [step.id, step.id])];
  $('loops').replaceChildren(...loops.map(loop => group('editor-row',
    group('editor-row-head',
      el('span', (loop.from || '未选评审') + ' ↺ ' + (loop.to || '未选起点'), 'editor-id mono'),
      button('移除循环', () => remove(loops, loop, renderLoops), 'btn-ghost btn-sm')),
    group('fields',
      field('评审步骤', select(choices, loop.from, value => { loop.from = value; renderLoops(); })),
      field('重跑起点', select(choices, loop.to, value => { loop.to = value; renderLoops(); })),
      field('结束条件', select([['PASS', 'PASS']], loop.until, value => { loop.until = value; })),
      field('最多轮数', input(loop.maxRounds, value => { loop.maxRounds = value; scheduleFlowGraph(); }, { type: 'number', min: 1, max: 10 }))))));
  scheduleFlowGraph();
}
wire('add-person', () => { people.push({ id: 'p-' + ++serial, role: '', responsibility: '', writes: false }); renderPeople(); renderSteps(); });
wire('add-step', () => {
  steps.push({ id: 's-' + ++serial, participant: people[0]?.id ?? '', task: '', dependsOn: [], inputs: ['task'], produces: [] });
  renderSteps();
});
wire('add-loop', () => { loops.push({ from: steps.at(-1)?.id ?? '', to: steps[0]?.id ?? '', until: 'PASS', maxRounds: 2 }); renderLoops(); });
const taskFields = prefix => ({ task: $(prefix + '-task').value, cwd: $(prefix + '-cwd').value.trim() || undefined });
const flow = () => ({ ...taskFields('flow'), participants: people, steps, loops });

// Presets are the user's own saved flows (<stateDir>/presets.json): the panel can load
// them back into the form and store whatever the form currently holds under a new name.
let presetList = [];
async function loadPresets() {
  presetList = await api('/presets');
  const node = $('flow-preset');
  node.replaceChildren(...(presetList.length ? presetList.map(preset => [preset.id, preset.name]) : [['', '暂无预设']])
    .map(([id, label]) => {
      const option = el('option', label);
      option.value = id;
      return option;
    }));
  node.disabled = !presetList.length;
  scheduleFlowGraph();
}
function applyPreset(id) {
  const preset = presetList.find(entry => entry.id === id);
  if (!preset) throw new Error('请先选择预设。');
  const { flow: shape } = preset;
  $('flow-task').value = shape.task ?? '';
  people.splice(0, people.length, ...shape.participants.map(person => ({
    id: person.id, role: person.role ?? '', responsibility: person.responsibility ?? '',
    writes: Boolean(person.writes), agent: person.agent, model: person.model, effort: person.effort,
  })));
  steps.splice(0, steps.length, ...shape.steps.map(step => ({
    id: step.id, participant: step.participant, task: step.task,
    dependsOn: [...(step.dependsOn ?? [])], inputs: [...(step.inputs ?? [])], produces: [...(step.produces ?? [])],
  })));
  loops.splice(0, loops.length, ...(shape.loops ?? []).map(loop => ({
    from: loop.from, to: loop.to, until: loop.until ?? 'PASS', maxRounds: loop.maxRounds ?? 2,
  })));
  renderPeople();
  renderSteps();
  scheduleFlowGraph();
  message(preset.description || '已载入预设：' + preset.name);
}
wire('flow-preset-load', () => applyPreset($('flow-preset').value));
wire('flow-preset-save', async () => {
  const { task, ...rest } = flow();
  if (!people.length || !steps.length) throw new Error('至少需要一个参与者和一个步骤。');
  const name = window.prompt('预设名称（同名会覆盖）', presetList[0]?.name ?? '');
  if (!name) return;
  const saved = await api('/presets', 'POST', { name, flow: { task, ...rest } });
  presetList = saved.presets;
  await loadPresets();
  $('flow-preset').value = saved.preset.id;
  message('已保存预设：' + saved.preset.name + '（' + saved.preset.id + '）');
});
wire('validate', async () => {
  const plan = await api('/flow/validate', 'POST', flow());
  message(plan.ok ? '有效。执行顺序 ' + plan.order.join(' → ')
    : plan.errors.map(error => error.path + ' · ' + error.message).join('\n'), !plan.ok);
});
wire('start-flow', () => launchRun('/flow/run', structuredClone(flow())));

// "Is it on right now?" — the config says installed, the usage record says it has actually
// connected and called a tool, which is the only honest answer mid-task.
function ago(iso) {
  if (!iso) return '从未';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前';
  if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前';
  return Math.round(seconds / 86400) + ' 天前';
}

async function loadBridges() {
  const report = $('bridges');
  report.replaceChildren(el('p', '检测中…', 'hint'));
  let rows;
  try {
    rows = await api('/bridges');
  } catch (error) {
    report.replaceChildren(el('p', error.message, 'hint bad'));
    return;
  }
  let calls = [];
  try {
    calls = await api('/calls?limit=15');
  } catch {
    calls = [];
  }
  const line = row => {
    const item = el('div', undefined, 'health-row with-state');
    const stateKey = row.connectedNow ? 'connected' : row.enabled === false ? 'disabled' : row.configured ? 'configured' : 'unconfigured';
    const value = row.detail + ' · 最近调用 ' + ago(row.lastSeen) + (row.calls ? '（' + row.calls + ' 次）' : '');
    item.append(
      el('span', row.label, 'health-label'),
      badge(stateKey),
      el('span', value, 'health-value'),
    );
    if (row.configured) {
      const off = row.enabled === false;
      const toggle = el('button', off ? '启用' : '停用', 'btn btn-sm health-action');
      toggle.type = 'button';
      toggle.onclick = async () => {
        toggle.disabled = true;
        try {
          await api('/bridges', 'POST', { id: row.id, enabled: off });
          message(row.label + (off ? ' 已启用' : ' 已停用'));
          await loadBridges();
        } catch (error) {
          toggle.disabled = false;
          message(error.message, true);
        }
      };
      item.append(toggle);
    } else {
      item.append(el('span', '', 'health-action'));
    }
    return item;
  };
  const callLine = entry => {
    const item = el('div', undefined, 'health-row call-row');
    const text = entry.task ? entry.task : '（无任务文本）';
    item.append(
      el('span', formatClock(entry.at), 'health-label mono'),
      el('span', entry.client ?? '其他客户端', 'health-value'),
      el('span', entry.tool + (entry.ok ? '' : ' · 失败') + ' · ' + entry.ms + 'ms', 'health-value mono ' + (entry.ok ? '' : 'bad')),
      el('span', text, 'health-value'),
    );
    return item;
  };
  report.replaceChildren(
    ...rows.map(line),
    el('h3', '最近调用', 'health-title'),
    ...(calls.length ? calls.map(callLine) : [el('p', '没有任何调用记录——说明这段时间没有任务经过本 MCP（客户端只是登记在配置里，并没有用它）。', 'hint')]),
    el('p', '「停用」会改这个客户端自己的配置，重启该客户端后生效；「启用」会把它接回来。在 Codex 或 Claude Code 里调用任意 agents_* 工具，这一行会立刻变成「使用中」。', 'hint'),
  );
}

// The problem report's loudest complaint was silence: failures without a reason. The panel
// now states where state lives, which folders it can write, and whether the update route
// can reach anything at all.
async function loadHealth() {
  const report = $('health');
  report.replaceChildren(el('p', '检测中…', 'hint'));
  let data;
  try {
    data = await api('/health');
  } catch (error) {
    report.replaceChildren(el('p', error.message, 'hint bad'));
    return;
  }
  const row = (label, value, ok, mono = false) => {
    const line = el('div', undefined, 'health-row');
    const cls = ['health-value', mono ? 'mono' : '', ok === false ? 'bad' : ok === true ? 'good' : ''].filter(Boolean).join(' ');
    line.append(el('span', label, 'health-label'), el('span', value, cls));
    return line;
  };
  const rows = [
    row('状态目录', data.state.dir + (data.state.writable ? '（可写）' : '（不可写：' + data.state.reason + '）'), data.state.writable, true),
  ];
  for (const location of data.locations) {
    rows.push(row(location.kind === 'desktop' ? '桌面目录' : '开始菜单目录',
      location.dir + (location.writable ? '（可写）' : '（不可写：' + location.reason + '）'), location.writable, true));
  }
  rows.push(row('更新通道', data.update.proxy
    ? '代理 ' + data.update.proxy + '（来源 ' + data.update.source + '，' + (data.update.reachable ? '可连接' : '连不上') + '）'
    : '直连', data.update.proxy ? data.update.reachable : null));
  rows.push(row('运行环境', data.platform + ' · ' + data.node + ' · v' + data.version, null, true));
  report.replaceChildren(...rows);
}

const capValues = {};
function renderSettings() {
  renderAppbar();
  $('policy').value = config.gate.policy;
  $('enable-a').checked = config.gate.modeA;
  $('enable-b').checked = config.gate.modeB;
  $('draft-gate').checked = config.gate.draftRoleRequiresGate;
  $('port').value = config.port;
  $('step-timeout').value = config.stepTimeoutMinutes;
  $('parallel').value = config.maxParallel;
  $('state-dir').value = config.stateDir;
  $('state-note').textContent = config.stateFallback
    ? '默认目录 ' + config.stateFallback.from + ' 不可写（' + config.stateFallback.reason + '），已改用当前目录。用 --state-dir 可以固定下来。'
    : '通过启动参数 --state-dir 更改';
  $('version').value = config.version ?? '';
  $('proxy').value = config.proxy ?? '';
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
const pickInto = inputId => async () => {
  const node = $(inputId);
  const result = await api('/pick-folder', 'POST', { initial: node.value.trim() || undefined });
  if (result.cancelled) {
    message('未选择工作目录。');
    return;
  }
  node.value = result.path;
  message('工作目录：' + result.path);
};
wire('flow-cwd-pick', pickInto('flow-cwd'));
wire('delegate-cwd-pick', pickInto('delegate-cwd'));
wire('start-delegate', () => launchRun('/delegate', {
  ...taskFields('delegate'), ...mainActor, ...capValues, writes: $('delegate-writes').checked,
}));
wire('save-settings', async () => {
  config = { ...config, ...await api('/config', 'PUT', {
    gate: { policy: $('policy').value, modeA: $('enable-a').checked, modeB: $('enable-b').checked, draftRoleRequiresGate: $('draft-gate').checked },
    port: $('port').valueAsNumber, stepTimeoutMinutes: $('step-timeout').valueAsNumber, maxParallel: $('parallel').valueAsNumber,
    proxy: $('proxy').value.trim(),
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
      else if (result.status === 'dismissed') message('已忽略这条已过期的授权请求。');
      else message(result.decision === 'enable' ? '已启用此任务。' : '授权决定已保存。');
    };
    return group('gate-entry',
      group('gate-head', el('strong', entry.question), group('actions',
        button('启用', () => decide('enable'), 'btn-primary btn-sm'),
        button('禁用', () => decide('disable'), 'btn-sm'),
        button('忽略', () => decide('dismiss'), 'btn-ghost btn-sm'))),
      el('p', entry.task, 'gate-task'));
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
function cacheFlowPlan(runId, data) {
  if (!runId || !Array.isArray(data?.steps)) return;
  const stepIds = new Set(data.steps.map(s => s.id));
  const participantOf = {};
  const producesOf = {};
  for (const step of data.steps) {
    participantOf[step.id] = step.participant || '';
    producesOf[step.id] = Array.isArray(step.produces) ? step.produces.filter(Boolean) : [];
  }
  const hasExplicitDeps = data.steps.some(s => Array.isArray(s.dependsOn) && s.dependsOn.length > 0);
  const stepEdges = [];
  if (hasExplicitDeps) {
    for (const step of data.steps) {
      for (const dep of step.dependsOn ?? []) {
        if (stepIds.has(dep)) stepEdges.push({ from: dep, to: step.id, kind: 'flow', label: '' });
      }
    }
  }
  const loopEdges = [];
  for (const loop of data.loops ?? []) {
    if (stepIds.has(loop.from) && stepIds.has(loop.to)) {
      loopEdges.push({ from: loop.from, to: loop.to, kind: 'loop', label: '↺ ≤' + (loop.maxRounds ?? 2) + '轮' });
    }
  }
  if (flowPlans.size >= MAX_PLANS) {
    const oldest = flowPlans.keys().next().value;
    if (oldest !== undefined) flowPlans.delete(oldest);
  }
  flowPlans.set(runId, { hasExplicitDeps, stepEdges, loopEdges, participantOf, producesOf });
}
async function launchRun(path, data) {
  const result = await api(path, 'POST', data);
  if (await waitForGate(result, () => launchRun(path, data))) return;
  if (path === '/flow/run') cacheFlowPlan(result.runId, data);
  selectedRun = result.runId;
  await switchTab('runs');
}

// ============================================================================
// Routing Graph Engine (Mode A topology preview & Run Detail live handoffs)
// ============================================================================
const NODE_W = 164;
const NODE_H = 84;
const GAP_X = 52;
const GAP_Y = 38;
const PAD_X = 16;
const PAD_Y = 18;

const routeStateMap = new WeakMap();
const pendingRouteFigures = new Set();
let routeRaf = 0;

const routeResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(entries => {
    for (const entry of entries) {
      const figure = entry.target.closest('figure.route');
      if (!figure) continue;
      const state = routeStateMap.get(figure);
      const w = Math.floor(entry.contentRect.width);
      if (w <= 0) continue;
      const bucket = w < 360 ? 0 : Math.floor(w / 24) * 24;
      if (state && state.widthBucket === bucket) continue;
      scheduleRouteRender(figure);
    }
  })
  : null;

function scheduleRouteRender(figure) {
  if (!figure) return;
  pendingRouteFigures.add(figure);
  if (routeRaf) return;
  routeRaf = requestAnimationFrame(() => {
    routeRaf = 0;
    const items = [...pendingRouteFigures];
    pendingRouteFigures.clear();
    for (const fig of items) {
      const state = routeStateMap.get(fig);
      if (state?.lastModel) renderRouting(fig, state.lastModel);
    }
  });
}

function buildFlowRouting() {
  const participantIds = new Set(people.map(p => p.id));
  const stepsByParticipant = new Map();
  const stepMap = new Map();
  for (const step of steps) {
    stepMap.set(step.id, step);
    if (step.participant) {
      const list = stepsByParticipant.get(step.participant) ?? [];
      list.push(step.id);
      stepsByParticipant.set(step.participant, list);
    }
  }

  const rawEdges = [];
  const edgePairMap = new Map();
  const addForward = (from, to, stepId) => {
    if (!participantIds.has(from) || !participantIds.has(to)) return;
    const pairKey = from + '->' + to;
    const existing = edgePairMap.get(pairKey);
    if (existing) {
      if (stepId && !existing.steps.includes(stepId)) existing.steps.push(stepId);
      return;
    }
    const entry = { key: pairKey, from, to, kind: 'flow', steps: stepId ? [stepId] : [] };
    edgePairMap.set(pairKey, entry);
    rawEdges.push(entry);
  };

  const hasExplicitDeps = steps.some(s => Array.isArray(s.dependsOn) && s.dependsOn.length > 0);
  let fallbackOrder = false;
  if (hasExplicitDeps) {
    for (const step of steps) {
      for (const depId of step.dependsOn ?? []) {
        const parent = stepMap.get(depId);
        if (parent) addForward(parent.participant, step.participant, step.id);
      }
    }
  } else {
    const validSteps = steps.filter(s => participantIds.has(s.participant));
    if (validSteps.length >= 2) {
      fallbackOrder = true;
      for (let i = 1; i < validSteps.length; i++) {
        addForward(validSteps[i - 1].participant, validSteps[i].participant, validSteps[i].id);
      }
    }
  }

  const loopEdges = [];
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i];
    const fromStep = stepMap.get(loop.from);
    const toStep = stepMap.get(loop.to);
    if (!fromStep || !toStep) continue;
    if (!participantIds.has(fromStep.participant) || !participantIds.has(toStep.participant)) continue;
    loopEdges.push({
      key: 'loop:' + i + ':' + fromStep.participant + '->' + toStep.participant,
      from: fromStep.participant,
      to: toStep.participant,
      kind: 'loop',
      label: '↺ ≤' + (loop.maxRounds || 2) + '轮',
      state: 'loop',
      activePacket: false,
    });
  }

  const activeTargets = new Set();
  const forwardEdges = rawEdges.map(entry => {
    const label = entry.steps.length <= 2
      ? entry.steps.join(', ')
      : entry.steps.slice(0, 2).join(', ') + ' +' + (entry.steps.length - 2);
    if (flowPreviewAnimate) activeTargets.add(entry.to);
    return {
      key: entry.key,
      from: entry.from,
      to: entry.to,
      kind: 'flow',
      label,
      state: flowPreviewAnimate ? 'active' : 'idle',
      activePacket: flowPreviewAnimate,
    };
  });

  const nodes = people.map(person => {
    const owned = stepsByParticipant.get(person.id) ?? [];
    const stepSummary = owned.length
      ? (owned.length <= 3 ? owned.join(' · ') : owned.slice(0, 3).join(' · ') + ' +' + (owned.length - 3))
      : '未分配步骤';
    const assignedAgent = person.agent ? agentLabel(person.agent) : '未选 Agent';
    const sub = [person.role, assignedAgent].filter(Boolean).join(' · ');
    const previewRunning = flowPreviewAnimate && activeTargets.has(person.id);
    return {
      key: person.id,
      title: person.id,
      subtitle: sub || '未指定角色',
      meta: stepSummary,
      status: previewRunning ? 'running' : (person.agent ? 'available' : 'pending'),
      pillText: previewRunning ? '交接中' : (person.writes ? '可写' : '只读'),
      pillTone: previewRunning ? 'run' : (person.writes ? 'warn' : 'idle'),
    };
  });

  return {
    scope: 'flow',
    nodeWidth: 214,
    gapX: 96,
    nodes,
    edges: [...forwardEdges, ...loopEdges],
    fallbackOrder,
    hasLoop: loopEdges.length > 0,
    hasForward: forwardEdges.length > 0,
    terminal: !flowPreviewAnimate,
    sourceNote: fallbackOrder ? '未设依赖 · 按步骤顺序示意' : (hasExplicitDeps ? '按 dependsOn 依赖连线' : '添加步骤与依赖后自动连线'),
  };
}

function latestActorStep(runSteps, actorId) {
  let matched = null;
  let maxRound = 0;
  for (const [key, value] of Object.entries(runSteps ?? {})) {
    if (key === actorId) {
      if (maxRound < 1) { maxRound = 1; matched = value; }
    } else if (key.startsWith(actorId + '-r')) {
      const num = Number(key.slice(actorId.length + 2));
      if (Number.isFinite(num) && num >= maxRound) { maxRound = num; matched = value; }
    }
  }
  return { step: matched, rounds: maxRound };
}

function buildRunRouting(run, plan) {
  const isTerminal = Boolean(run.finishedAt)
    || ['PASS', 'FAILED', 'BLOCKED', 'cancelled', 'incomplete'].includes(run.status);

  if (Array.isArray(run.delegationTree) || run.kind === 'B') {
    const tree = Array.isArray(run.delegationTree) ? run.delegationTree : [];
    const nodeMap = new Map();
    const mainInfo = latestActorStep(run.steps, 'main');
    const mainRawStatus = mainInfo.step?.status ?? (isTerminal ? run.status : 'running');
    nodeMap.set('main', {
      key: 'main',
      title: 'main',
      subtitle: [mainInfo.step?.agent ? agentLabel(mainInfo.step.agent) : '主 Agent', mainInfo.step?.model].filter(Boolean).join(' · '),
      meta: [mainInfo.rounds > 1 ? '第 ' + mainInfo.rounds + ' 轮' : '', mainInfo.step?.durationMs !== undefined ? formatDuration(mainInfo.step.durationMs) : ''].filter(Boolean).join(' · ') || '统筹主节点',
      status: isTerminal && mainRawStatus === 'running' ? run.status : mainRawStatus,
      rawStatus: mainRawStatus,
      pillText: statusText(mainRawStatus, 'step'),
      pillTone: toneOf(mainRawStatus),
    });

    for (const edge of tree) {
      if (nodeMap.has(edge.id)) continue;
      const info = latestActorStep(run.steps, edge.id);
      const rawStatus = info.step?.status ?? edge.status ?? 'pending';
      const displayStatus = isTerminal && rawStatus === 'running' ? edge.status : rawStatus;
      nodeMap.set(edge.id, {
        key: edge.id,
        title: edge.id,
        subtitle: [edge.agent ? agentLabel(edge.agent) : (info.step?.agent ? agentLabel(info.step.agent) : '子 Agent'), info.step?.model].filter(Boolean).join(' · '),
        meta: [info.rounds > 1 ? '第 ' + info.rounds + ' 轮' : '', info.step?.durationMs !== undefined ? formatDuration(info.step.durationMs) : ''].filter(Boolean).join(' · ') || '委派子任务',
        status: isTerminal && displayStatus === 'running' ? 'incomplete' : displayStatus,
        rawStatus: displayStatus,
        pillText: statusText(displayStatus, 'step'),
        pillTone: toneOf(displayStatus),
      });
    }

    const edges = tree
      .filter(edge => nodeMap.has(edge.parent) && nodeMap.has(edge.id))
      .map(edge => {
        const target = nodeMap.get(edge.id);
        const source = nodeMap.get(edge.parent);
        const tStatus = target.rawStatus;
        const sStatus = source.rawStatus;
        const active = !isTerminal && tStatus === 'running';
        let state = 'idle';
        if (active) state = 'active';
        else if (['FAILED', 'BLOCKED', 'error', 'refused'].includes(tStatus)) state = 'failed';
        else if (tStatus === 'PASS') state = 'done';
        else if (sStatus === 'PASS' && tStatus !== 'pending' && tStatus !== 'SKIPPED') state = 'done';
        return {
          key: edge.parent + '->' + edge.id,
          from: edge.parent,
          to: edge.id,
          kind: 'flow',
          label: edge.agent || '',
          state,
          activePacket: active,
        };
      });

    return {
      scope: 'run',
      runId: run.runId,
      nodes: [...nodeMap.values()],
      edges,
      fallbackOrder: false,
      hasLoop: false,
      hasForward: edges.length > 0,
      terminal: isTerminal,
      sourceNote: edges.length ? '按主 Agent 实际委派树连线' : '尚未产生子委派',
    };
  }

  // Mode A (or draft) run
  const entries = Object.entries(run.steps ?? {});
  const stepMap = new Map(entries);
  const nodes = entries.map(([stepId, info]) => {
    const rawStatus = info.status ?? 'pending';
    const round = info.round ?? run.loopRounds?.[stepId];
    const parts = [];
    if (plan?.participantOf?.[stepId]) parts.push(plan.participantOf[stepId]);
    if (info.agent) parts.push(agentLabel(info.agent));
    const metaParts = [];
    if (round && round > 1) metaParts.push('第 ' + round + ' 轮');
    if (info.durationMs !== undefined) metaParts.push(formatDuration(info.durationMs));
    return {
      key: stepId,
      title: stepId,
      subtitle: parts.join(' · ') || info.model || '待分配',
      meta: metaParts.join(' · ') || (info.model || '—'),
      status: isTerminal && rawStatus === 'running' ? 'incomplete' : rawStatus,
      rawStatus,
      pillText: statusText(rawStatus, 'step'),
      pillTone: toneOf(rawStatus),
    };
  });

  const edges = [];
  let fallbackOrder = false;
  if (plan?.hasExplicitDeps && plan.stepEdges.length) {
    for (const e of plan.stepEdges) {
      if (stepMap.has(e.from) && stepMap.has(e.to)) edges.push({ ...e, key: e.from + '->' + e.to });
    }
  } else if (entries.length >= 2) {
    fallbackOrder = true;
    for (let i = 1; i < entries.length; i++) {
      edges.push({ key: entries[i - 1][0] + '->' + entries[i][0], from: entries[i - 1][0], to: entries[i][0], kind: 'flow', label: '' });
    }
  }
  const hasLoop = Boolean(plan?.loopEdges?.length);
  for (let i = 0; i < (plan?.loopEdges?.length ?? 0); i++) {
    const le = plan.loopEdges[i];
    if (stepMap.has(le.from) && stepMap.has(le.to)) {
      edges.push({ ...le, key: 'loop:' + i + ':' + le.from + '->' + le.to });
    }
  }

  const styledEdges = edges.map(edge => {
    if (edge.kind === 'loop') return { ...edge, state: 'loop', activePacket: false };
    const sStatus = stepMap.get(edge.from)?.status ?? 'pending';
    const tStatus = stepMap.get(edge.to)?.status ?? 'pending';
    const active = !isTerminal && tStatus === 'running';
    let state = 'idle';
    if (active) state = 'active';
    else if (['FAILED', 'BLOCKED', 'error'].includes(tStatus)) state = 'failed';
    else if (tStatus === 'PASS' && sStatus === 'PASS') state = 'done';
    else if (sStatus === 'PASS' && tStatus !== 'pending' && tStatus !== 'SKIPPED') state = 'done';
    return { ...edge, state, activePacket: active };
  });

  return {
    scope: 'run',
    runId: run.runId,
    nodes,
    edges: styledEdges,
    fallbackOrder,
    hasLoop,
    hasForward: styledEdges.some(e => e.kind !== 'loop'),
    terminal: isTerminal,
    sourceNote: fallbackOrder ? '按步骤顺序示意' : (plan?.hasExplicitDeps ? '按本会话 dependsOn 依赖连线' : '单步执行'),
  };
}

function chevronPath(tx, ty, c2x, c2y, fallbackDx, fallbackDy) {
  let dx = tx - c2x;
  let dy = ty - c2y;
  let len = Math.hypot(dx, dy);
  if (len < 0.01) {
    dx = fallbackDx;
    dy = fallbackDy;
    len = Math.hypot(dx, dy) || 1;
  }
  const ux = dx / len;
  const uy = dy / len;
  const size = 6.5;
  const spread = 3.4;
  const x1 = (tx - size * ux + spread * uy).toFixed(1);
  const y1 = (ty - size * uy - spread * ux).toFixed(1);
  const x2 = (tx - size * ux - spread * uy).toFixed(1);
  const y2 = (ty - size * uy + spread * ux).toFixed(1);
  return 'M' + x1 + ' ' + y1 + 'L' + tx.toFixed(1) + ' ' + ty.toFixed(1) + 'L' + x2 + ' ' + y2;
}

function cubicMid(sx, sy, c1x, c1y, c2x, c2y, tx, ty) {
  return {
    lx: 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * tx,
    ly: 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ty,
  };
}

function layoutRouting(model, containerWidth) {
  // 协作动画页把节点放得更宽，好让「产物 · 耗时 · token」在同一行读得下。
  const NODE_W = model.nodeWidth ?? 164;
  const GAP_X = model.gapX ?? 52;
  const visibleNodes = model.nodes.slice(0, MAX_ROUTE_NODES);
  const omitted = Math.max(0, model.nodes.length - visibleNodes.length);
  const visibleKeys = new Set(visibleNodes.map(n => n.key));
  const visibleEdges = model.edges.filter(e => visibleKeys.has(e.from) && visibleKeys.has(e.to));

  if (!visibleNodes.length) {
    return { empty: true, compact: false, nodes: [], edges: [], omitted: 0, gw: 0, gh: 0, nodeW: NODE_W, nodeH: NODE_H };
  }
  if (containerWidth > 0 && containerWidth < 360) {
    return { empty: false, compact: true, nodes: visibleNodes, edges: visibleEdges, omitted, gw: containerWidth, gh: 0, nodeW: NODE_W, nodeH: NODE_H };
  }

  const W = Math.max(360, containerWidth || 720);

  // Break cycles among non-loop forward edges so depth assignment always terminates cleanly.
  const outMap = new Map(visibleNodes.map(n => [n.key, []]));
  const inDegree = new Map(visibleNodes.map(n => [n.key, 0]));
  const forwardIndices = [];
  visibleEdges.forEach((edge, idx) => {
    if (edge.kind !== 'loop' && edge.from !== edge.to) {
      forwardIndices.push(idx);
      outMap.get(edge.from).push({ to: edge.to, idx });
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  });

  const state = new Map(); // 0=unvisited, 1=visiting, 2=done
  const backEdgeIdx = new Set();
  const dfs = key => {
    state.set(key, 1);
    for (const next of outMap.get(key) ?? []) {
      const s = state.get(next.to) ?? 0;
      if (s === 1) backEdgeIdx.add(next.idx);
      else if (s === 0) dfs(next.to);
    }
    state.set(key, 2);
  };
  for (const node of visibleNodes) {
    if ((inDegree.get(node.key) ?? 0) === 0 && !state.get(node.key)) dfs(node.key);
  }
  for (const node of visibleNodes) {
    if (!state.get(node.key)) dfs(node.key);
  }

  const hasLoopOrBack = visibleEdges.some((e, idx) => e.kind === 'loop' || backEdgeIdx.has(idx));
  const maxCols = Math.max(1, Math.min(5, Math.floor((W - 2 * PAD_X - (hasLoopOrBack ? 26 : 0) + GAP_X) / (NODE_W + GAP_X))));

  const dagEdges = forwardIndices.filter(idx => !backEdgeIdx.has(idx)).map(idx => visibleEdges[idx]);
  const depth = new Map(visibleNodes.map(n => [n.key, 0]));
  for (let pass = 0; pass < visibleNodes.length; pass++) {
    let changed = false;
    for (const edge of dagEdges) {
      const nextDepth = (depth.get(edge.from) ?? 0) + 1;
      if (nextDepth > (depth.get(edge.to) ?? 0)) {
        depth.set(edge.to, nextDepth);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const levelsMap = new Map();
  visibleNodes.forEach((node, index) => {
    const d = depth.get(node.key) ?? 0;
    const list = levelsMap.get(d) ?? [];
    list.push({ node, index });
    levelsMap.set(d, list);
  });
  const sortedDepths = [...levelsMap.keys()].sort((a, b) => a - b);
  const levels = sortedDepths.map(d => levelsMap.get(d));

  const hasSelfLoop = visibleEdges.some(e => e.from === e.to);
  const hasSkipColForward = levels.length > 2 || visibleNodes.length > maxCols;
  const shouldWrap = levels.length > maxCols || (levels.length === 1 && visibleNodes.length > 3);
  const leftPad = hasLoopOrBack && shouldWrap ? PAD_X + 26 : PAD_X;
  const topPad = hasSelfLoop ? PAD_Y + 30 : (hasSkipColForward ? PAD_Y + 14 : PAD_Y);
  const placed = new Map();
  let colsUsed = 1;
  let maxRowUsed = 0;
  let contentBottom = topPad + NODE_H;

  if (shouldWrap) {
    const flat = visibleNodes
      .map((node, index) => ({ node, index, d: depth.get(node.key) ?? 0 }))
      .sort((a, b) => a.d - b.d || a.index - b.index);
    colsUsed = Math.min(maxCols, flat.length);
    const rowsUsed = Math.ceil(flat.length / maxCols);
    maxRowUsed = rowsUsed - 1;
    flat.forEach((entry, i) => {
      const col = i % maxCols;
      const row = Math.floor(i / maxCols);
      const x = leftPad + col * (NODE_W + GAP_X);
      const y = topPad + row * (NODE_H + GAP_Y);
      placed.set(entry.node.key, { ...entry.node, col, row, x, y });
    });
    contentBottom = topPad + rowsUsed * NODE_H + Math.max(0, rowsUsed - 1) * GAP_Y;
  } else {
    colsUsed = levels.length;
    const maxRows = Math.max(1, ...levels.map(l => l.length));
    maxRowUsed = maxRows - 1;
    const totalGridH = maxRows * NODE_H + Math.max(0, maxRows - 1) * GAP_Y;
    levels.forEach((level, col) => {
      const levelH = level.length * NODE_H + Math.max(0, level.length - 1) * GAP_Y;
      const yOffset = Math.round((totalGridH - levelH) / 2);
      level.forEach((entry, row) => {
        const x = leftPad + col * (NODE_W + GAP_X);
        const y = topPad + yOffset + row * (NODE_H + GAP_Y);
        placed.set(entry.node.key, { ...entry.node, col, row, x, y });
      });
    });
    contentBottom = topPad + totalGridH;
  }

  // Count fan-out / fan-in ports for left-to-right edges so parallel wires separate neatly.
  const outTotals = new Map();
  const inTotals = new Map();
  visibleEdges.forEach((edge, idx) => {
    if (edge.kind === 'loop' || edge.from === edge.to || backEdgeIdx.has(idx)) return;
    const s = placed.get(edge.from);
    const t = placed.get(edge.to);
    if (t.x > s.x) {
      outTotals.set(edge.from, (outTotals.get(edge.from) ?? 0) + 1);
      inTotals.set(edge.to, (inTotals.get(edge.to) ?? 0) + 1);
    }
  });
  const outSeen = new Map();
  const inSeen = new Map();
  const portOffset = (seen, total) => {
    if (total <= 1) return 0;
    const span = Math.min(28, (total - 1) * 12);
    return -span / 2 + (seen / (total - 1)) * span;
  };

  let loopLane = 0;
  let packetOrder = 0;
  const placedNodesList = [...placed.values()];

  const routedEdges = visibleEdges.map((edge, idx) => {
    const s = placed.get(edge.from);
    const t = placed.get(edge.to);
    const isLoopOrBack = edge.kind === 'loop' || backEdgeIdx.has(idx);
    let sx; let sy; let tx; let ty; let c1x; let c1y; let c2x; let c2y;
    let d; let lx; let ly; let endTangentX; let endTangentY;

    if (edge.from === edge.to) {
      // Self-handoff arch cleanly above the node
      sx = s.x + NODE_W * 0.34;
      sy = s.y;
      tx = s.x + NODE_W * 0.66;
      ty = s.y;
      c1x = sx - 12;
      c1y = sy - 32;
      c2x = tx + 12;
      c2y = ty - 32;
      d = `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      ({ lx, ly } = cubicMid(sx, sy, c1x, c1y, c2x, c2y, tx, ty));
      endTangentX = c2x;
      endTangentY = c2y;
    } else if (isLoopOrBack || (t.row <= s.row && t.x <= s.x)) {
      // Return arc: if both endpoints sit on the bottom row, arc cleanly underneath;
      // otherwise route around the outer bottom-left perimeter so it never crosses behind cards.
      const laneIdx = loopLane++;
      const laneY = contentBottom + 22 + laneIdx * 24;
      sx = s.x + NODE_W * 0.56;
      sy = s.y + NODE_H;
      if (s.row === maxRowUsed && t.row === maxRowUsed) {
        tx = t.x + NODE_W * 0.44;
        ty = t.y + NODE_H;
        c1x = sx;
        c1y = laneY;
        c2x = tx;
        c2y = laneY;
        d = `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
        ({ lx, ly } = cubicMid(sx, sy, c1x, c1y, c2x, c2y, tx, ty));
        endTangentX = c2x;
        endTangentY = c2y;
      } else {
        const gutterX = Math.max(10, leftPad - 16 - laneIdx * 6);
        const r = 10;
        tx = t.x;
        ty = t.y + NODE_H * 0.5;
        d = [
          `M${sx.toFixed(1)} ${sy.toFixed(1)}`,
          `L${sx.toFixed(1)} ${(laneY - r).toFixed(1)}`,
          `Q${sx.toFixed(1)} ${laneY.toFixed(1)} ${(sx - r).toFixed(1)} ${laneY.toFixed(1)}`,
          `L${(gutterX + r).toFixed(1)} ${laneY.toFixed(1)}`,
          `Q${gutterX.toFixed(1)} ${laneY.toFixed(1)} ${gutterX.toFixed(1)} ${(laneY - r).toFixed(1)}`,
          `L${gutterX.toFixed(1)} ${(ty + r).toFixed(1)}`,
          `Q${gutterX.toFixed(1)} ${ty.toFixed(1)} ${(gutterX + r).toFixed(1)} ${ty.toFixed(1)}`,
          `L${tx.toFixed(1)} ${ty.toFixed(1)}`,
        ].join(' ');
        lx = Math.max(gutterX + 42, (sx + gutterX) / 2);
        ly = laneY;
        endTangentX = gutterX;
        endTangentY = ty;
      }
    } else if (t.x > s.x) {
      // Standard left-to-right handoff
      const oi = outSeen.get(edge.from) ?? 0;
      outSeen.set(edge.from, oi + 1);
      const ii = inSeen.get(edge.to) ?? 0;
      inSeen.set(edge.to, ii + 1);
      sx = s.x + NODE_W;
      sy = s.y + NODE_H / 2 + portOffset(oi, outTotals.get(edge.from) ?? 1);
      tx = t.x;
      ty = t.y + NODE_H / 2 + portOffset(ii, inTotals.get(edge.to) ?? 1);

      // Avoid slicing across a node sitting directly between non-adjacent columns
      const blocksMiddle = t.col - s.col > 1 && placedNodesList.some(n =>
        n.key !== s.key && n.key !== t.key
        && n.x > s.x + NODE_W - 4 && n.x + NODE_W < t.x + 4
        && Math.min(sy, ty) > n.y - 10 && Math.max(sy, ty) < n.y + NODE_H + 10);

      if (blocksMiddle) {
        const bowY = Math.min(s.y, t.y) - 20;
        c1x = sx + (tx - sx) * 0.28;
        c1y = bowY;
        c2x = tx - (tx - sx) * 0.28;
        c2y = bowY;
      } else {
        const dx = Math.max(26, (tx - sx) * 0.46);
        c1x = sx + dx;
        c1y = sy;
        c2x = tx - dx;
        c2y = ty;
      }
      d = `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      ({ lx, ly } = cubicMid(sx, sy, c1x, c1y, c2x, c2y, tx, ty));
      endTangentX = c2x;
      endTangentY = c2y;
    } else {
      // Wrapped next-row handoff routed cleanly through horizontal gutter between rows
      sx = s.x + NODE_W / 2;
      sy = s.y + NODE_H;
      tx = t.x + NODE_W / 2;
      ty = t.y;
      const midY = s.y + NODE_H + GAP_Y / 2;
      c1x = sx;
      c1y = midY;
      c2x = tx;
      c2y = midY;
      d = `M${sx.toFixed(1)} ${sy.toFixed(1)} C${c1x.toFixed(1)} ${c1y.toFixed(1)} ${c2x.toFixed(1)} ${c2y.toFixed(1)} ${tx.toFixed(1)} ${ty.toFixed(1)}`;
      ({ lx, ly } = cubicMid(sx, sy, c1x, c1y, c2x, c2y, tx, ty));
      endTangentX = c2x;
      endTangentY = c2y;
    }

    const arrowD = chevronPath(tx, ty, endTangentX, endTangentY, tx - sx, ty - sy);
    const k = packetOrder++;
    return { ...edge, sx, sy, tx, ty, d, arrowD, lx, ly, k };
  });

  // De-conflict overlapping edge labels gently so adjacent badges never touch
  const placedLabels = [];
  for (const edge of routedEdges) {
    if (!edge.label) continue;
    for (let tries = 0; tries < 4; tries++) {
      const hit = placedLabels.find(p => Math.abs(p.lx - edge.lx) < 54 && Math.abs(p.ly - edge.ly) < 20);
      if (!hit) break;
      edge.lx += (tries % 2 === 0 ? 1 : -1) * 38;
    }
    placedLabels.push({ lx: edge.lx, ly: edge.ly });
  }

  const gw = Math.max(NODE_W + leftPad + PAD_X, leftPad + PAD_X + colsUsed * NODE_W + Math.max(0, colsUsed - 1) * GAP_X);
  const gh = contentBottom + PAD_Y + (loopLane > 0 ? loopLane * 24 + 22 : 0);

  return {
    empty: false,
    compact: false,
    nodes: placedNodesList,
    edges: routedEdges,
    omitted,
    gw,
    gh,
  };
}

function legendItem(kind, text) {
  const wrap = el('span', undefined, 'legend-item');
  const swatch = el('span', undefined, 'legend-swatch');
  swatch.dataset.kind = kind;
  swatch.setAttribute('aria-hidden', 'true');
  wrap.append(swatch, el('span', text));
  return wrap;
}

// ── 协作动画 ────────────────────────────────────────────────────────────────
// 参考 yetone/magpie 的做法：连线是流动的虚线，数据包是一颗带光晕的小圆点，
// 每帧按真实路径取点移动（不是 CSS 补间，所以快慢、往返都能控制），颜色按上游
// Agent 分配，同一张图里不同 Agent 不撞色；评审回环用空心点反向飞回上游。
const ROUTE_PALETTE = ['#4c8df6', '#a06bf5', '#e5679a', '#e09a2b', '#2fae76', '#2ba8bd', '#e0685f', '#8aa93a'];
const routeColourMaps = new WeakMap();
const routeFlights = new WeakMap();

function routeColour(figure, id) {
  let map = routeColourMaps.get(figure);
  if (!map) { map = new Map(); routeColourMaps.set(figure, map); }
  let colour = map.get(id);
  if (!colour) {
    const used = new Set(map.values());
    colour = ROUTE_PALETTE.find(c => !used.has(c)) ?? ROUTE_PALETTE[map.size % ROUTE_PALETTE.length];
    map.set(id, colour);
  }
  return colour;
}

function routeAgentOf(node) {
  const head = String(node.subtitle ?? '').split(' · ')[0].trim();
  return head || String(node.title ?? '');
}

const routeStill = () => typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const routeEase = t => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2);

function stopRouteFlights(figure) {
  const flight = routeFlights.get(figure);
  if (!flight) return;
  if (flight.raf) cancelAnimationFrame(flight.raf);
  flight.layer?.replaceChildren();
  routeFlights.delete(figure);
}

function routeDot(colour, back, radius, className = 'route-fly') {
  const dot = portProto.cloneNode(false);
  dot.setAttribute('class', className);
  dot.setAttribute('r', String(radius));
  dot.setAttribute('opacity', '0');
  dot.dataset.back = back ? '1' : '0';
  dot.style.setProperty('--agent', colour);
  return dot;
}

function syncRouteFlights(figure, state, layout, model) {
  const layer = state.packetsLayer;
  if (!layer) return;
  const tracks = [];
  const trails = [];
  for (const edge of layout.edges) {
    const ref = state.edgeRefs.get(edge.key);
    if (!ref?.wire) continue;
    const flowing = Boolean(edge.activePacket);
    const back = edge.kind === 'loop' && !model.terminal;
    if (!flowing && !back) {
      if (edge.state === 'done') {
        let trailLen = 0;
        try { trailLen = ref.wire.getTotalLength(); } catch { trailLen = 0; }
        if (trailLen) trails.push({ path: ref.wire, len: trailLen, colour: ref.wire.style.getPropertyValue('--agent') || 'var(--accent)', back: false });
      }
      continue;
    }
    let len = 0;
    try { len = ref.wire.getTotalLength(); } catch { len = 0; }
    if (!len) continue;
    tracks.push({ path: ref.wire, len, colour: ref.wire.style.getPropertyValue('--agent') || 'var(--accent)', back });
  }
  const sig = tracks.map(t => (t.back ? 'b' : 'f') + Math.round(t.len) + t.colour).join('|') + '#' + layout.edges.filter(e => e.state === 'done').length;
  const current = routeFlights.get(figure);
  if (current && current.sig === sig && current.layer === layer) return;
  stopRouteFlights(figure);
  if (!tracks.length && !trails.length) return;

  const flight = { layer, sig, tracks, trails, packets: [], raf: 0, last: 0 };
  routeFlights.set(figure, flight);

  // 站着不动的点：已走过的边（历史痕迹），以及"减少动态效果"时正在交接的边
  const standing = routeStill() ? tracks.concat(trails) : trails;
  for (const track of standing) {
    for (const at of [0.36, 0.68]) {
      const dot = routeDot(track.colour, track.back, 3, 'route-point');
      dot.setAttribute('opacity', routeStill() ? '0.65' : '0.5');
      const point = track.path.getPointAtLength(at * track.len);
      dot.setAttribute('cx', point.x.toFixed(1));
      dot.setAttribute('cy', point.y.toFixed(1));
      layer.append(dot);
    }
  }
  if (routeStill() || !tracks.length) return;

  for (const track of tracks) {
    for (let i = 0; i < 2; i++) {
      const halo = routeDot(track.colour, track.back, track.back ? 9 : 10, 'route-halo');
      const dot = routeDot(track.colour, track.back, track.back ? 4.6 : 5);
      layer.append(halo, dot);
      flight.packets.push({ dot, halo, track, t: i / 2, speed: 1 / (track.back ? 1700 : 1400) });
    }
  }

  flight.last = performance.now();
  const frame = now => {
    const dt = Math.min(64, now - flight.last);
    flight.last = now;
    for (const packet of flight.packets) {
      packet.t += dt * packet.speed;
      if (packet.t >= 1) packet.t -= 1;
      const at = (packet.track.back ? 1 - routeEase(packet.t) : routeEase(packet.t)) * packet.track.len;
      const point = packet.track.path.getPointAtLength(at);
      packet.dot.setAttribute('cx', point.x.toFixed(1));
      packet.dot.setAttribute('cy', point.y.toFixed(1));
      packet.halo.setAttribute('cx', point.x.toFixed(1));
      packet.halo.setAttribute('cy', point.y.toFixed(1));
      const fade = packet.t < 0.1 ? packet.t / 0.1 : packet.t > 0.9 ? (1 - packet.t) / 0.1 : 1;
      packet.dot.setAttribute('opacity', fade.toFixed(2));
      packet.halo.setAttribute('opacity', (fade * 0.85).toFixed(2));
    }
    flight.raf = requestAnimationFrame(frame);
  };
  flight.raf = requestAnimationFrame(frame);
}

function renderRouting(figure, model) {
  if (!figure || !svgProto) return;
  const body = figure.querySelector('[data-route-body]');
  const summaryEl = figure.querySelector('[data-route-summary]');
  const legendEl = figure.querySelector('[data-route-legend]');
  if (!body) return;

  let state = routeStateMap.get(figure);
  if (!state) {
    state = { layoutSig: '', widthBucket: -1, nodeRefs: new Map(), edgeRefs: new Map(), lastModel: null, packetsLayer: null, colourScope: '', agents: new Map() };
    routeStateMap.set(figure, state);
    if (routeResizeObserver) routeResizeObserver.observe(body);
  }
  state.lastModel = model;
  const colourScope = String(model.runId ?? model.scope ?? '');
  if (state.colourScope !== colourScope) {
    routeColourMaps.delete(figure);
    state.colourScope = colourScope;
  }

  const nodeCount = model.nodes.length;
  const edgeCount = model.edges.length;
  const unit = model.scope === 'flow' ? '个参与者' : '个节点';
  const summaryText = nodeCount + ' ' + unit + ' · ' + edgeCount + ' 条连线';
  if (summaryEl && summaryEl.textContent !== summaryText) summaryEl.textContent = summaryText;
  figure.setAttribute('aria-label', '路由图：' + summaryText + (model.sourceNote ? '（' + model.sourceNote + '）' : ''));

  const measuredW = Math.floor(body.getBoundingClientRect().width);
  const widthBucket = measuredW <= 0 ? 720 : (measuredW < 360 ? 0 : Math.floor(measuredW / 24) * 24);
  state.widthBucket = widthBucket;

  // Empty state
  if (!nodeCount) {
    stopRouteFlights(figure);
    state.packetsLayer = null;
    state.layoutSig = 'empty:' + model.scope;
    state.nodeRefs.clear();
    state.edgeRefs.clear();
    if (model.scope === 'flow') {
      const actions = group('actions', button('添加参与者', () => $('add-person').click(), 'btn-primary btn-sm'));
      if (presetList.length) actions.append(button('载入首个预设', () => applyPreset(presetList[0].id), 'btn-sm'));
      body.replaceChildren(group('empty',
        el('p', '还没有编排节点', 'empty-title'),
        el('p', '添加参与者与步骤，或载入已有预设，路由图会实时展示 Agent 间的任务流向。', 'hint'),
        actions));
    } else {
      body.replaceChildren(group('empty',
        el('p', '暂无路由节点', 'empty-title'),
        el('p', '等待步骤开始执行后将呈现节点与连线。', 'hint')));
    }
    if (legendEl) legendEl.replaceChildren();
    return;
  }

  const layout = layoutRouting(model, measuredW || 720);
  const layoutSig = [
    model.scope,
    model.runId ?? '',
    widthBucket,
    layout.compact ? 'c' : 'g',
    layout.omitted,
    layout.nodes.map(n => n.key + '|' + n.title + '|' + n.subtitle + '|' + n.meta).join(';'),
    layout.edges.map(e => e.key + '|' + e.from + '>' + e.to + '|' + e.kind + '|' + (e.label || '')).join(';'),
  ].join('#');

  // Update legend (lightweight text check)
  if (legendEl) {
    const legendKey = [layout.compact, model.sourceNote, model.hasLoop, layout.omitted].join('|');
    if (legendEl.dataset.key !== legendKey) {
      legendEl.dataset.key = legendKey;
      const items = [
        legendItem('active', '交接中 / 数据包'),
        legendItem('done', '已走过'),
        legendItem('idle', '等待'),
      ];
      if (model.hasLoop) items.push(legendItem('loop', '评审循环'));
      if (model.scope === 'run') items.push(legendItem('failed', '失败 / 受阻'));
      if (layout.compact) items.push(el('span', '窄视口：按顺序列表展示'));
      if (model.sourceNote) items.push(el('span', model.sourceNote));
      if (layout.omitted > 0) items.push(el('span', '仅展示前 ' + MAX_ROUTE_NODES + ' 个节点，已省略 +' + layout.omitted + '（完整列表见下方）'));
      legendEl.replaceChildren(...items);
    }
  }

  // Compact narrow fallback (<360px)
  if (layout.compact) {
    if (state.layoutSig !== layoutSig) {
      state.layoutSig = layoutSig;
      state.nodeRefs.clear();
      state.edgeRefs.clear();
      const list = group('route-compact-list');
      const incomingByKey = new Map();
      for (const edge of layout.edges) {
        const listIn = incomingByKey.get(edge.to) ?? [];
        listIn.push(edge.from + (edge.label ? ' (' + edge.label + ')' : ''));
        incomingByKey.set(edge.to, listIn);
      }
      for (const node of layout.nodes) {
        const pill = badge(node.status);
        pill.textContent = node.pillText;
        pill.dataset.tone = node.pillTone;
        const fromList = incomingByKey.get(node.key);
        const item = group('route-compact-item',
          group('route-node-top', el('span', node.title, 'route-node-id mono'), pill),
          el('span', node.subtitle, 'route-node-sub'),
          el('span', (fromList?.length ? '上游：' + fromList.join(', ') + ' · ' : '') + node.meta, 'route-node-meta mono'));
        item.dataset.status = node.status;
        list.append(item);
        state.nodeRefs.set(node.key, { card: item, pill });
      }
      body.replaceChildren(list);
    } else {
      for (const node of layout.nodes) {
        const ref = state.nodeRefs.get(node.key);
        if (!ref) continue;
        ref.card.dataset.status = node.status;
        ref.pill.textContent = node.pillText;
        ref.pill.dataset.tone = node.pillTone;
      }
    }
    return;
  }

  // Fast path: layout unchanged -> preserve SVG/node DOM identity so 1s polls never restart packet animations!
  if (state.layoutSig === layoutSig) {
    for (const node of layout.nodes) {
      const ref = state.nodeRefs.get(node.key);
      if (!ref) continue;
      if (ref.card.dataset.status !== node.status) ref.card.dataset.status = node.status;
      if (ref.pill.textContent !== node.pillText) ref.pill.textContent = node.pillText;
      if (ref.pill.dataset.tone !== node.pillTone) ref.pill.dataset.tone = node.pillTone;
      if (ref.meta.textContent !== node.meta) ref.meta.textContent = node.meta;
    }
    for (const edge of layout.edges) {
      const ref = state.edgeRefs.get(edge.key);
      if (!ref) continue;
      if (ref.wire.dataset.state !== edge.state) ref.wire.dataset.state = edge.state;
      if (ref.arrow.dataset.state !== edge.state) ref.arrow.dataset.state = edge.state;
      if (ref.port.dataset.state !== edge.state) ref.port.dataset.state = edge.state;
      if (ref.label && ref.label.dataset.state !== edge.state) ref.label.dataset.state = edge.state;
    }
    syncRouteFlights(figure, state, layout, model);
    return;
  }

  // Full layout rebuild
  state.layoutSig = layoutSig;
  state.nodeRefs.clear();
  state.edgeRefs.clear();

  const stage = group('route-stage');
  const canvas = group('route-canvas');
  canvas.style.setProperty('--gw', layout.gw + 'px');
  canvas.style.setProperty('--gh', layout.gh + 'px');
  canvas.style.setProperty('--nw', (layout.nodeW ?? 164) + 'px');
  canvas.style.setProperty('--nh', (layout.nodeH ?? 84) + 'px');

  const svg = svgProto.cloneNode(false);
  svg.setAttribute('viewBox', '0 0 ' + layout.gw + ' ' + layout.gh);
  svg.setAttribute('width', String(layout.gw));
  svg.setAttribute('height', String(layout.gh));
  const edgesLayer = edgesGroupProto.cloneNode(false);
  const packetsLayer = packetsGroupProto.cloneNode(false);
  svg.append(edgesLayer, packetsLayer);

  const labelsLayer = group('route-labels');
  const nodesLayer = group('route-nodes');

  // 每个节点先领一个颜色，连线沿用上游节点的颜色 —— 谁交给谁一眼能看出来。
  const colourOf = new Map();
  for (const node of layout.nodes) colourOf.set(node.key, routeColour(figure, routeAgentOf(node)));

  for (const edge of layout.edges) {
    const colour = colourOf.get(edge.from) ?? routeColour(figure, edge.from);
    const wirePath = pathProto.cloneNode(false);
    wirePath.setAttribute('class', 'route-edge');
    wirePath.setAttribute('d', edge.d);
    wirePath.dataset.state = edge.state;
    wirePath.style.setProperty('--agent', colour);

    const arrowPath = pathProto.cloneNode(false);
    arrowPath.setAttribute('class', 'route-arrow');
    arrowPath.setAttribute('d', edge.arrowD);
    arrowPath.dataset.state = edge.state;
    arrowPath.style.setProperty('--agent', colour);

    const portDot = portProto.cloneNode(false);
    portDot.setAttribute('class', 'route-port');
    portDot.setAttribute('cx', edge.sx.toFixed(1));
    portDot.setAttribute('cy', edge.sy.toFixed(1));
    portDot.dataset.state = edge.state;
    portDot.style.setProperty('--agent', colour);

    edgesLayer.append(wirePath, arrowPath, portDot);

    let labelEl = null;
    if (edge.label) {
      labelEl = el('span', edge.label, 'route-edge-label');
      labelEl.title = edge.label;
      labelEl.dataset.state = edge.state;
      labelEl.style.setProperty('--lx', edge.lx.toFixed(1) + 'px');
      labelEl.style.setProperty('--ly', edge.ly.toFixed(1) + 'px');
      labelsLayer.append(labelEl);
    }

    state.edgeRefs.set(edge.key, { wire: wirePath, arrow: arrowPath, port: portDot, label: labelEl });
  }

  for (const node of layout.nodes) {
    const card = group('route-node');
    card.dataset.status = node.status;
    card.style.setProperty('--agent', colourOf.get(node.key) ?? '');
    card.style.setProperty('--nx', node.x + 'px');
    card.style.setProperty('--ny', node.y + 'px');

    const titleEl = el('span', node.title, 'route-node-id mono');
    titleEl.title = node.title;
    const pill = el('span', node.pillText, 'pill');
    pill.dataset.tone = node.pillTone;
    const subEl = group('route-node-sub', el('span', '', 'route-node-dot'), el('span', node.subtitle, 'route-node-subtext'));
    subEl.title = node.subtitle;
    const metaEl = el('span', node.meta, 'route-node-meta mono');
    metaEl.title = node.meta;

    card.append(group('route-node-top', titleEl, pill), subEl, metaEl);
    nodesLayer.append(card);
    state.nodeRefs.set(node.key, { card, pill, meta: metaEl });
  }

  canvas.append(svg, labelsLayer, nodesLayer);
  stage.append(canvas);
  body.replaceChildren(stage);
  state.packetsLayer = packetsLayer;
  syncRouteFlights(figure, state, layout, model);
}

function syncFlowPreviewToggle() {
  const fig = $('flow-graph');
  const toggle = fig?.querySelector('[data-route-preview]');
  if (!toggle) return;
  const model = buildFlowRouting();
  toggle.hidden = !model.hasForward;
  if (!model.hasForward) flowPreviewAnimate = false;
  toggle.setAttribute('aria-pressed', String(flowPreviewAnimate));
  toggle.textContent = flowPreviewAnimate ? '停止预览' : '预览流动';
}

function scheduleFlowGraph() {
  const fig = $('flow-graph');
  if (!fig) return;
  syncFlowPreviewToggle();
  const model = buildFlowRouting();
  let state = routeStateMap.get(fig);
  if (!state) {
    state = { layoutSig: '', widthBucket: -1, nodeRefs: new Map(), edgeRefs: new Map(), lastModel: model };
    routeStateMap.set(fig, state);
    const body = fig.querySelector('[data-route-body]');
    if (body && routeResizeObserver) routeResizeObserver.observe(body);
  } else {
    state.lastModel = model;
  }
  scheduleRouteRender(fig);
}

$('flow-graph')?.querySelector('[data-route-preview]')?.addEventListener('click', () => {
  flowPreviewAnimate = !flowPreviewAnimate;
  scheduleFlowGraph();
});

// ============================================================================
// Runs list + persistent two-column Run Detail
// ============================================================================
let runListRefs = new Map();
let runListKey = '';
let runDetailState = null;

function renderRunsEmptyDetail() {
  runDetailState = null;
  $('run-detail').replaceChildren(group('empty',
    el('p', '选择一条运行记录', 'empty-title'),
    el('p', '从左侧选择一条运行记录查看路由图、步骤与思考过程，或去模式 A 发起一次。', 'hint'),
    button('去模式 A 发起一次', () => switchTab('flow'), 'btn-primary btn-sm')));
}

function createRunDetailSkeleton(runId) {
  const titleEl = el('h2', '');
  const statusPill = badge('pending', 'run');
  const head = group('run-head', titleEl, statusPill);

  const statKind = el('span', '—', 'stat-value');
  const statId = el('span', runId, 'stat-value mono');
  const statDur = el('span', '—', 'stat-value mono');
  const statCwd = el('span', '—', 'stat-value mono');
  const stats = group('run-stats',
    group('stat', el('span', '模式', 'stat-label'), statKind),
    group('stat', el('span', '运行 ID', 'stat-label'), statId),
    group('stat', el('span', '耗时', 'stat-label'), statDur),
    group('stat', el('span', '工作目录', 'stat-label'), statCwd));

  const routeFigure = el('figure', undefined, 'route route-embedded');
  routeFigure.dataset.route = 'run';
  const routeSummary = el('span', '', 'card-sub');
  routeSummary.dataset.routeSummary = '';
  const routeBody = el('div', undefined, 'route-body');
  routeBody.dataset.routeBody = '';
  const routeLegend = el('figcaption', undefined, 'route-legend');
  routeLegend.dataset.routeLegend = '';
  routeFigure.append(
    group('route-head', group('route-title-wrap', el('h3', 'Agent 路由图'), routeSummary)),
    routeBody,
    routeLegend);

  const table = el('table');
  const header = table.createTHead().insertRow();
  const cols = [['步骤', 'col-step'], ['状态', 'col-status'], ['轮次', 'col-round'], ['耗时', 'col-duration']];
  for (const [label, cls] of cols) header.append(el('th', label, cls));
  const tableBody = table.createTBody();
  const stepsSection = group('section-block', el('h3', '步骤', 'section-title'), group('table-wrap', table));

  const thinkingWrap = group('thinking-list');
  const thinkingSection = group('section-block', el('h3', '思考过程', 'section-title'), thinkingWrap);

  const treeWrap = el('div');
  const treeSection = group('section-block', el('h3', '委派树', 'section-title'), treeWrap);
  treeSection.hidden = true;

  const logPre = el('pre', '等待事件…', 'event-log');
  const logSection = group('section-block', el('h3', '最近事件', 'section-title'), logPre);

  const linksList = el('ul', undefined, 'links-list');
  const linksSection = group('section-block', el('h3', '产物与报告', 'section-title'), linksList);
  linksSection.hidden = true;

  const cancelWrap = group('actions', button('取消运行', async () => {
    await api('/runs/' + runId + '/cancel', 'POST', {});
    await loadRuns();
  }, 'btn-danger'));
  cancelWrap.hidden = true;

  $('run-detail').replaceChildren(head, stats, routeFigure, stepsSection, thinkingSection, treeSection, logSection, linksSection, cancelWrap);

  return {
    runId, titleEl, statusPill, statKind, statId, statDur, statCwd,
    routeFigure, tableBody, thinkingWrap, thinkingRefs: new Map(),
    treeSection, treeWrap, logPre, linksSection, linksList, cancelWrap,
    lastLogText: '等待事件…', lastStepsSig: '', lastTreeSig: '', lastLinksSig: '',
  };
}

function updateRunsBadge(runs) {
  const badgeEl = slot('runs-badge');
  if (!badgeEl) return;
  const activeCount = runs.filter(r => r.status === 'running').length;
  badgeEl.textContent = String(activeCount);
  badgeEl.hidden = activeCount === 0;
}

async function loadRuns() {
  const runs = await api('/runs');
  updateRunsBadge(runs);
  if (tab !== 'runs') return;

  const listEl = $('run-list');
  if (!runs.length) {
    runListKey = '';
    runListRefs.clear();
    listEl.replaceChildren(group('empty',
      el('p', '还没有运行记录', 'empty-title'),
      el('p', '去模式 A 发起一次编排，或在模式 B 中由主 Agent 自动委派。', 'hint'),
      button('去模式 A 发起一次', () => switchTab('flow'), 'btn-primary btn-sm')));
    selectedRun = undefined;
    renderRunsEmptyDetail();
    return;
  }

  const nextKey = runs.map(r => r.runId).join(',');
  if (nextKey === runListKey && runListRefs.size === runs.length) {
    for (const run of runs) {
      const ref = runListRefs.get(run.runId);
      if (!ref) continue;
      ref.btn.setAttribute('aria-pressed', String(selectedRun === run.runId));
      updateBadge(ref.pill, run.status, 'run');
      const metaText = [runKinds[run.kind] ?? run.kind ?? '任务', formatClock(run.startedAt), formatDuration(runDurationMs(run))].join(' · ');
      if (ref.meta.textContent !== metaText) ref.meta.textContent = metaText;
    }
  } else {
    const focusedRunId = document.activeElement?.closest?.('.run-row')?.dataset?.runId;
    runListKey = nextKey;
    runListRefs.clear();
    const nodes = runs.map(run => {
      const rowBtn = button('', async () => {
        selectedRun = run.runId;
        await loadRuns();
      }, 'run-row');
      rowBtn.classList.remove('btn');
      rowBtn.dataset.runId = run.runId;
      const taskEl = el('span', run.task || '（未命名任务）', 'run-task');
      const pill = badge(run.status, 'run');
      const metaText = [runKinds[run.kind] ?? run.kind ?? '任务', formatClock(run.startedAt), formatDuration(runDurationMs(run))].join(' · ');
      const meta = el('span', metaText, 'run-row-meta mono');
      rowBtn.append(group('run-row-top', taskEl, pill), meta);
      rowBtn.setAttribute('aria-pressed', String(selectedRun === run.runId));
      runListRefs.set(run.runId, { btn: rowBtn, pill, meta });
      return rowBtn;
    });
    listEl.replaceChildren(...nodes);
    if (focusedRunId && runListRefs.has(focusedRunId)) {
      runListRefs.get(focusedRunId).btn.focus({ preventScroll: true });
    }
  }

  if (selectedRun) await loadRun(selectedRun);
  else if (!runDetailState) renderRunsEmptyDetail();
}

async function loadRun(id) {
  const run = await api('/runs/' + id);
  if (tab !== 'runs' || selectedRun !== id) return;

  const oldLog = $('run-detail').querySelector('pre.event-log');
  const scroll = oldLog && oldLog.scrollTop + oldLog.clientHeight < oldLog.scrollHeight - 24 ? oldLog.scrollTop : null;

  if (!runDetailState || runDetailState.runId !== id) {
    runDetailState = createRunDetailSkeleton(id);
  }
  const s = runDetailState;

  if (s.titleEl.textContent !== run.task) s.titleEl.textContent = run.task;
  updateBadge(s.statusPill, run.status, 'run');
  s.statKind.textContent = runKinds[run.kind] ?? run.kind ?? '—';
  s.statId.textContent = run.runId;
  s.statDur.textContent = formatDuration(runDurationMs(run));
  s.statCwd.textContent = run.cwd || '—';

  // Update persistent routing graph without restarting active packet animations
  renderRouting(s.routeFigure, buildRunRouting(run, flowPlans.get(id)));

  // Steps table
  const stepEntries = Object.entries(run.steps ?? {});
  const stepsSig = stepEntries.map(([k, v]) => k + ':' + v.status + ':' + v.round + ':' + (v.durationMs ?? '')).join('|');
  if (stepsSig !== s.lastStepsSig) {
    s.lastStepsSig = stepsSig;
    const rows = stepEntries.map(([step, status]) => {
      const tr = el('tr');
      const tdStep = el('td', step, 'mono');
      const tdStatus = el('td');
      tdStatus.append(badge(status.status, 'step'));
      const tdRound = el('td', status.round === undefined ? '—' : String(status.round), 'mono');
      const tdDur = el('td', status.durationMs === undefined ? '—' : (status.durationMs / 1000).toFixed(1) + ' 秒', 'mono');
      tr.append(tdStep, tdStatus, tdRound, tdDur);
      return tr;
    });
    s.tableBody.replaceChildren(...rows);
  }

  // Thinking disclosures: keep each step's reasoning and preserve user toggles
  const reasoning = new Map();
  for (const event of run.events ?? []) {
    if (event.type !== 'reasoning' || typeof event.text !== 'string' || !event.text) continue;
    const entry = reasoning.get(event.step) ?? { text: '' };
    entry.text += (entry.text && !event.delta ? '\n\n' : '') + event.text;
    reasoning.set(event.step, entry);
  }
  if (!stepEntries.length) {
    s.thinkingRefs.clear();
    s.thinkingWrap.replaceChildren(el('p', '暂无思考记录。', 'hint'));
  } else {
    const validKeys = new Set(stepEntries.map(([step]) => step));
    const orderedNodes = [];
    for (const [step, status] of stepEntries) {
      const notes = reasoning.get(step);
      const tokens = status.tokens && status.tokens.reasoningTokens;
      const summaryLabel = [step, status.agent, status.model,
        tokens === undefined ? undefined : '思考 ' + tokens + ' tokens'].filter(Boolean).join(' · ');
      const key = id + ':' + step;
      const desiredOpen = thinkingOpen.has(key) ? thinkingOpen.get(key) : Boolean(notes) && status.status === 'running';
      let ref = s.thinkingRefs.get(step);
      if (!ref) {
        const details = el('details', undefined, 'thinking');
        const summary = el('summary', summaryLabel);
        // The click is recorded instead of the toggle event, which also fires for programmatic opens.
        summary.addEventListener('click', () => thinkingOpen.set(key, !details.open));
        const bodyNode = notes
          ? el('pre', notes.text, 'thinking-text')
          : el('p', tokens === undefined ? '暂无思考内容。' : '该 Agent 没有输出思考正文，只记录了 token 用量。', 'hint');
        details.open = desiredOpen;
        details.append(summary, bodyNode);
        ref = { details, summary, bodyNode, hasNotes: Boolean(notes) };
        s.thinkingRefs.set(step, ref);
      } else {
        if (ref.summary.textContent !== summaryLabel) ref.summary.textContent = summaryLabel;
        if (ref.details.open !== desiredOpen) ref.details.open = desiredOpen;
        if (notes) {
          if (!ref.hasNotes) {
            const pre = el('pre', notes.text, 'thinking-text');
            ref.bodyNode.replaceWith(pre);
            ref.bodyNode = pre;
            ref.hasNotes = true;
          } else if (ref.bodyNode.textContent !== notes.text) {
            ref.bodyNode.textContent = notes.text;
          }
        } else {
          const emptyMsg = tokens === undefined ? '暂无思考内容。' : '该 Agent 没有输出思考正文，只记录了 token 用量。';
          if (ref.hasNotes) {
            const p = el('p', emptyMsg, 'hint');
            ref.bodyNode.replaceWith(p);
            ref.bodyNode = p;
            ref.hasNotes = false;
          } else if (ref.bodyNode.textContent !== emptyMsg) {
            ref.bodyNode.textContent = emptyMsg;
          }
        }
      }
      orderedNodes.push(ref.details);
    }
    for (const k of [...s.thinkingRefs.keys()]) {
      if (!validKeys.has(k)) s.thinkingRefs.delete(k);
    }
    const needAttach = s.thinkingWrap.children.length !== orderedNodes.length
      || orderedNodes.some((node, idx) => s.thinkingWrap.children[idx] !== node);
    if (needAttach) s.thinkingWrap.replaceChildren(...orderedNodes);
  }

  // Delegation tree
  if (Array.isArray(run.delegationTree)) {
    s.treeSection.hidden = false;
    const treeSig = run.delegationTree.map(e => e.parent + '>' + e.id + ':' + e.status).join('|');
    if (treeSig !== s.lastTreeSig) {
      s.lastTreeSig = treeSig;
      const branches = parent => {
        const list = el('ul', undefined, parent === 'main' ? 'tree' : undefined);
        for (const edge of run.delegationTree.filter(edge => edge.parent === parent)) {
          const item = el('li');
          item.append(group('tree-row', el('span', edge.id, 'mono'), badge(edge.status, 'step')));
          const descendants = branches(edge.id);
          if (descendants.childElementCount) item.append(descendants);
          list.append(item);
        }
        return list;
      };
      const tree = branches('main');
      s.treeWrap.replaceChildren(tree.childElementCount ? tree : el('p', '暂无委派。', 'hint'));
    }
  } else {
    s.treeSection.hidden = true;
    s.lastTreeSig = '';
  }

  // Recent events log with scroll preservation
  const logText = (run.events ?? []).map(event =>
    [event.step, event.type, event.text || (event.data && JSON.stringify(event.data))].filter(Boolean).join(' · ')).join('\n') || '等待事件…';
  if (logText !== s.lastLogText) {
    s.lastLogText = logText;
    s.logPre.textContent = logText;
  }
  s.logPre.scrollTop = scroll ?? s.logPre.scrollHeight;

  // Artifacts & report links
  const linkItems = [
    ...(run.artifacts ?? []).map(name => [name, 'artifacts/' + encodeURIComponent(name)]),
    ...(run.reportPath ? [['查看报告', 'report.md']] : []),
  ];
  const linksSig = linkItems.map(([l, p]) => l + ':' + p).join('|');
  if (linksSig !== s.lastLinksSig) {
    s.lastLinksSig = linksSig;
    s.linksList.replaceChildren(...linkItems.map(([label, path]) => {
      const item = el('li');
      const anchor = el('a', label);
      anchor.href = '/api/runs/' + id + '/files/' + path;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      item.append(anchor);
      return item;
    }));
  }
  s.linksSection.hidden = linkItems.length === 0;

  s.cancelWrap.hidden = Boolean(run.finishedAt);
}

// ============================================================================
// 协作动画：专门展示 agent 之间每一次交接的独立页面
// ============================================================================
const routePageState = { runId: '', live: true, busy: false, factsSig: '', rowsSig: '', replayUntil: 0 };

function countText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  return value >= 1000 ? (value / 1000).toFixed(value >= 10_000 ? 0 : 1) + 'k' : String(value);
}
function tokenText(tokens) {
  if (!tokens) return '';
  const parts = [];
  if (countText(tokens.inputTokens)) parts.push('入 ' + countText(tokens.inputTokens));
  if (countText(tokens.outputTokens)) parts.push('出 ' + countText(tokens.outputTokens));
  if (countText(tokens.reasoningTokens)) parts.push('思考 ' + countText(tokens.reasoningTokens));
  return parts.join(' · ');
}
function stepActorText(info) {
  if (!info) return '—';
  const who = [agentLabel(info.agent), info.model, info.effort].filter(Boolean).join(' · ');
  return who || '—';
}
function producedNames(run, stepId) {
  const planned = flowPlans.get(run?.runId)?.producesOf?.[stepId];
  if (planned?.length) return planned;
  // 历史运行没有本次会话的计划缓存，产物文件名约定是「步骤 ID - 产物名.md」。
  return (run?.artifacts ?? [])
    .filter(name => name === stepId + '.md' || name.startsWith(stepId + '-'))
    .map(name => name.replace(/\.md$/, ''));
}

function routeFacts(run, model) {
  const entries = Object.entries(run.steps ?? {});
  const totals = entries.reduce((acc, [, info]) => {
    acc.input += info?.tokens?.inputTokens ?? 0;
    acc.output += info?.tokens?.outputTokens ?? 0;
    acc.reasoning += info?.tokens?.reasoningTokens ?? 0;
    return acc;
  }, { input: 0, output: 0, reasoning: 0 });
  const handoffs = model.edges.filter(edge => edge.kind !== 'loop').length;
  const rounds = model.edges.filter(edge => edge.kind === 'loop').length;
  return {
    entries, totals, handoffs, rounds,
    agentsInvolved: new Set(entries.map(([, info]) => info?.agent).filter(Boolean)).size,
    artifacts: run.artifacts ?? [],
  };
}

function factCard(label, value, options = {}) {
  const valueEl = el('span', value || '—', 'fact-value' + (options.mono ? ' mono' : ''));
  if (options.wrap !== false) valueEl.classList.add('fact-wrap');
  return group('fact', el('span', label, 'fact-label'), valueEl);
}

function renderRouteFacts(run, model, facts) {
  const box = $('route-facts');
  const tx = tokenText({ inputTokens: facts.totals.input, outputTokens: facts.totals.output, reasoningTokens: facts.totals.reasoning });
  const sig = [run.runId, run.status, run.finishedAt, facts.handoffs, facts.rounds, facts.agentsInvolved,
    facts.totals.input, facts.totals.output, facts.totals.reasoning, facts.artifacts.join(','), run.task].join('|');
  if (sig === routePageState.factsSig) return;
  routePageState.factsSig = sig;

  const statusCard = group('fact', el('span', '状态', 'fact-label'), badge(run.status, 'run'));
  const cards = [
    statusCard,
    factCard('模式', runKinds[run.kind] ?? run.kind),
    factCard('总耗时', formatDuration(runDurationMs(run)), { mono: true }),
    factCard('Agent', facts.agentsInvolved + ' 个'),
    factCard('交接', facts.handoffs + ' 次' + (facts.rounds ? '（含 ' + facts.rounds + ' 条评审回环）' : '')),
    factCard('Token', tx || '—', { mono: true }),
    factCard('开始', formatClock(run.startedAt), { mono: true }),
    factCard('产物', facts.artifacts.length ? facts.artifacts.length + ' 个' : '—'),
  ];
  const task = group('fact fact-task',
    el('span', '任务目标', 'fact-label'),
    el('p', run.task || '（未命名任务）', 'fact-task-text'));

  const artifactChips = facts.artifacts.map(name => {
    const link = el('a', name, 'chip-link mono');
    link.href = '/api/runs/' + run.runId + '/files/artifacts/' + encodeURIComponent(name);
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
  });
  const chips = artifactChips.length ? group('fact artifact-row',
    el('span', '产物文件', 'fact-label'), group('chip-row', ...artifactChips)) : null;

  const runIdCard = group('fact', el('span', '运行 ID', 'fact-label'), el('span', run.runId, 'fact-value mono'));
  box.replaceChildren(...cards, runIdCard, task, ...(chips ? [chips] : []));
}

function renderRouteHandoffs(run, model) {
  const box = $('route-handoffs');
  const forward = model.edges.filter(edge => edge.kind !== 'loop');
  const loops = model.edges.filter(edge => edge.kind === 'loop');

  const rows = forward.map(edge => {
    const up = run.steps?.[edge.from];
    const down = run.steps?.[edge.to];
    const names = producedNames(run, edge.from);
    const deliver = names.length ? names.join('、') : (up ? '上游产出（见产物文件）' : '任务文本');
    const cells = [
      group('handoff-flow',
        el('span', edge.from, 'handoff-step mono'),
        el('span', '→', 'handoff-arrow'),
        el('span', edge.to, 'handoff-step mono')),
      el('span', deliver, 'handoff-deliver'),
      el('span', stepActorText(up), 'handoff-actor'),
      el('span', formatDuration(up?.durationMs), 'handoff-metric mono'),
      el('span', tokenText(up?.tokens) || '—', 'handoff-metric mono'),
      badge(edge.state === 'active' ? 'running' : (down?.status ?? 'pending'), 'step'),
    ];
    const row = group('handoff-row', ...cells);
    row.dataset.state = edge.state ?? '';
    return row;
  });

  const loopRows = loops.map(edge => {
    const row = group('handoff-row handoff-loop',
      group('handoff-flow',
        el('span', edge.from, 'handoff-step mono'),
        el('span', '↺', 'handoff-arrow'),
        el('span', edge.to, 'handoff-step mono')),
      el('span', edge.label || '评审结论回写', 'handoff-deliver'),
      el('span', '评审循环', 'handoff-actor mono'),
      el('span', String(run.loopRounds?.[edge.to] ?? '—'), 'handoff-metric mono'),
      el('span', '最多 ' + (edge.maxRounds ?? 2) + ' 轮', 'handoff-metric mono'),
      badge('pending', 'step'));
    return row;
  });

  const sig = JSON.stringify([forward.map(e => [e.from, e.to, e.state, run.steps?.[e.to]?.status]), loops.length]);
  if (sig !== routePageState.rowsSig) {
    routePageState.rowsSig = sig;
    if (!forward.length && !loops.length) {
      box.replaceChildren(group('empty', el('p', '还没有交接', 'empty-title'), el('p', '这条运行只有一步，或尚未开始交接。', 'hint')));
    } else {
      const header = group('handoff-row handoff-header',
        el('span', '交接', 'handoff-head'), el('span', '交付内容', 'handoff-head'),
        el('span', '上游 Agent / 模型 / 强度', 'handoff-head'), el('span', '上游耗时', 'handoff-head'),
        el('span', '上游 Token', 'handoff-head'), el('span', '下游状态', 'handoff-head'));
      box.replaceChildren(header, ...rows, ...loopRows);
    }
  }
}

async function loadRoutePage() {
  if (routePageState.busy) return;
  routePageState.busy = true;
  try {
    const runs = await api('/runs');
    const picker = $('route-run');
    const sig = runs.map(run => run.runId + ':' + run.status).join(',');
    if (picker.dataset.sig !== sig) {
      picker.dataset.sig = sig;
      picker.replaceChildren(...runs.map(run => {
        const opt = el('option', (runKinds[run.kind] ?? run.kind ?? '任务') + ' · ' + (run.task || run.runId).slice(0, 40));
        opt.value = run.runId;
        return opt;
      }));
    }
    if (!routePageState.runId || !runs.some(run => run.runId === routePageState.runId)) {
      routePageState.runId = runs[0]?.runId ?? '';
    }
    if (picker.value !== routePageState.runId) picker.value = routePageState.runId;

    if (!routePageState.runId) {
      $('route-title').textContent = '还没有运行记录';
      $('route-summary').textContent = '去模式 A 发起一次编排，或在模式 B 里让主 Agent 派活。';
      $('route-body').replaceChildren(group('empty', el('p', '这里会显示 agent 之间的交接动画', 'empty-title')));
      $('route-legend').replaceChildren();
      $('route-facts').replaceChildren();
      $('route-handoffs').replaceChildren();
      return;
    }

    const run = await api('/runs/' + routePageState.runId);
    if (tab !== 'route' || routePageState.runId !== run.runId) return;

    const model = buildRunRouting(run, flowPlans.get(run.runId));
    model.nodeWidth = 210;
    model.gapX = 108;
    const facts = routeFacts(run, model);
    for (const node of model.nodes) {
      const info = run.steps?.[node.key];
      const total = (info?.tokens?.inputTokens ?? 0) + (info?.tokens?.outputTokens ?? 0);
      const meta = [];
      if (typeof info?.durationMs === 'number') meta.push(formatDuration(info.durationMs));
      if (total) meta.push(countText(total) + ' tok');
      if (meta.length) node.meta = meta.join(' · ');
    }

    // 线上标交付物本身（节点与表格里已经有耗时与 token，线上只留最短的辨识信息）。
    for (const edge of model.edges) {
      if (edge.kind === 'loop') continue;
      const short = producedNames(run, edge.from)
        .map(name => (name.startsWith(edge.from + '-') ? name.slice(edge.from.length + 1) : name))
        .filter(Boolean);
      edge.label = short.slice(0, 2).join('、');
    }

    // 重播：把已完成的交接临时标记为「正在流动」，让历史运行也能看到数据包。
    if (Date.now() < routePageState.replayUntil) {
      for (const edge of model.edges) {
        if (edge.kind === 'loop') continue;
        edge.state = 'active';
        edge.activePacket = true;
      }
    }

    const headline = (run.task || run.runId).split('\n')[0].trim();
    $('route-title').textContent = headline.length > 70 ? headline.slice(0, 70) + '…' : headline;
    $('route-title').title = run.task || run.runId;
    $('route-summary').textContent = [runKinds[run.kind] ?? run.kind, formatClock(run.startedAt), formatDuration(runDurationMs(run)), facts.artifacts.length + ' 个产物'].filter(Boolean).join(' · ');
    $('route-live-badge').hidden = run.status !== 'running';

    renderRouteFacts(run, model, facts);
    renderRouting($('route-figure'), model);
    renderRouteHandoffs(run, model);
  } finally {
    routePageState.busy = false;
  }
}

wire('route-refresh', loadRoutePage);
wire('route-replay', async () => {
  const run = await api('/runs/' + routePageState.runId);
  const edges = Object.keys(run.steps ?? {}).length - 1;
  const span = 1500 + Math.max(0, edges) * 260;
  routePageState.replayUntil = Date.now() + span;
  routePageState.factsSig = '';
  routePageState.rowsSig = '';
  await loadRoutePage();
  setTimeout(() => {
    routePageState.replayUntil = 0;
    if (tab === 'route') void loadRoutePage();
  }, span + 120);
});
$('route-run').addEventListener('change', async event => {
  routePageState.runId = event.target.value;
  routePageState.factsSig = '';
  routePageState.rowsSig = '';
  await loadRoutePage();
});
$('route-live').addEventListener('change', event => {
  routePageState.live = event.target.checked;
  if (routePageState.live) void loadRoutePage();
});

wire('refresh-runs', loadRuns);
wire('mcp-switch', toggleSwitch);

renderAppbar();
renderPeople();
renderSteps();

loadAgents().then(renderSettings).then(loadBridges).then(loadHealth).catch(error => message(error.message, true));
loadPresets().catch(error => message(error.message, true));
loadUpdate().catch(() => {});
wire('check-bridges', () => loadBridges());
wire('check-health', () => loadHealth());
wire('check-update', async () => {
  updateDismissed = false;
  await loadUpdate(true);
});
wire('install-shortcut', async () => {
  const startup = $('shortcut-startup').checked;
  const { created } = await api('/shortcuts', 'POST', { startup });
  message('已创建快捷方式：' + created.join('、'));
});
wire('remove-shortcut', async () => {
  const { removed } = await api('/shortcuts/remove', 'POST', {});
  message(removed.length ? '已删除快捷方式：' + removed.join('、') : '没有找到已安装的快捷方式。');
});
wire('stop-service', async () => {
  try {
    await api('/shutdown', 'POST', {});
  } catch {
    // The process may drop the connection while exiting; that still means it stopped.
  }
  message('服务已停止，可以关闭此页面。');
});
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
poll(() => tab === 'route' && routePageState.live && Date.now() >= routePageState.replayUntil && loadRoutePage(), 1000);
