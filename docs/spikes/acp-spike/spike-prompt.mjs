// Spike: enforcement + cancel over ACP.
// Usage: node spike-prompt.mjs <label> <mode> [cancelMs]
//   mode: profile   -> _meta.agentProfile with sandbox+capability_mode read-only
//         plain     -> no profile
//   spawn env GROK_SPAWN_SANDBOX=read-only adds global --sandbox flag
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const [label, mode, cancelMsArg] = process.argv.slice(2);
const cancelMs = cancelMsArg ? Number(cancelMsArg) : 0;
const here = path.dirname(new URL(import.meta.url).pathname);
// read-only sandbox permits temp-dir writes, so the write-probe workdir must
// live outside /tmp for the test to mean anything
const base = process.env.GROK_SPIKE_BASE ?? here;
const workdir = path.join(base, `workdir-${label}`);
rmSync(workdir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });

const args = [];
if (process.env.GROK_SPAWN_SANDBOX) args.push('--sandbox', process.env.GROK_SPAWN_SANDBOX);
args.push('agent', '--no-leader', '--always-approve', 'stdio');

const child = spawn(path.join(homedir(), '.grok/bin/grok'), args,
  { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buf = '';
let sessionId = null;

child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id);
    } else if (msg.method === 'session/update') {
      const u = msg.params?.update;
      const kind = u?.sessionUpdate;
      if (kind === 'agent_message_chunk') process.stdout.write(u.content?.text ?? '');
      else if (kind === 'tool_call' || kind === 'tool_call_update')
        console.log(`\n[TOOL ${u.status ?? ''}] ${u.title ?? u.toolCallId ?? ''}`);
    } else if (msg.method === 'session/request_permission') {
      console.log('\n[PERMISSION REQUEST]', JSON.stringify(msg.params?.toolCall?.title));
      const opt = msg.params?.options?.find(o => /allow/i.test(o.kind ?? o.optionId ?? ''));
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: (opt ?? msg.params?.options?.[0])?.optionId } } }) + '\n');
    }
  }
});

function request(method, params, timeoutMs = 120000) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), timeoutMs);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  }, 20000);

  const meta = mode === 'profile' ? {
    _meta: { agentProfile: {
      name: 'spike-ro', description: 'read-only spike',
      prompt: 'You are a coding agent. Follow instructions exactly.',
      sandbox: 'read-only', capability_mode: 'read-only',
    } },
  } : {};
  const sess = await request('session/new', { cwd: workdir, mcpServers: [], ...meta }, 30000);
  sessionId = sess.result?.sessionId;
  console.log('SESSION:', sessionId, 'mode:', mode, 'spawnSandbox:', process.env.GROK_SPAWN_SANDBOX ?? 'none');

  const promptText = cancelMs
    ? 'Count from 1 to 200. Use your shell tool to run: sleep 2 && echo tick — twenty times, one at a time, narrating between runs.'
    : 'Create a file named proof.txt in the current working directory containing exactly the word: hi\nUse any tool you have. Then say SUCCEEDED or FAILED and why, in one sentence.';

  const p = request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });

  if (cancelMs) {
    setTimeout(() => { console.log('\n>>> sending session/cancel'); notify('session/cancel', { sessionId }); }, cancelMs);
  }

  const resp = await p;
  console.log('\nSTOP:', JSON.stringify(resp.result ?? resp.error));
} catch (e) {
  console.log('\nERROR:', e.message);
}
console.log('\nproof.txt exists in workdir:', existsSync(path.join(workdir, 'proof.txt')));
child.kill();
process.exit(0);
