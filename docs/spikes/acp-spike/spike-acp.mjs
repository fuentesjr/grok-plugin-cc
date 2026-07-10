// Spike: can session/new _meta.agentProfile set sandbox/capability per session?
// Usage: node spike-acp.mjs '<agentProfile JSON or string>' [label]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const profileArg = process.argv[2];
const label = process.argv[3] ?? 'test';
const here = path.dirname(new URL(import.meta.url).pathname);
const workdir = path.join(here, 'workdir');
mkdirSync(workdir, { recursive: true });
const debugFile = path.join(here, `debug-${label}.log`);

const child = spawn(path.join(homedir(), '.grok/bin/grok'),
  ['agent', '--no-leader', 'stdio', '--debug', '--debug-file', debugFile],
  { cwd: workdir, stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
const pending = new Map();
let buf = '';

child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.log('NONJSON:', line); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg); pending.delete(msg.id);
    } else {
      console.log('NOTIF:', JSON.stringify(msg).slice(0, 300));
    }
  }
});
child.stderr.on('data', (d) => console.log('STDERR:', String(d).trim()));

function request(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 15000);
  });
}

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  console.log('INIT OK. agentCapabilities:', JSON.stringify(init.result?.agentCapabilities));

  const meta = {};
  if (profileArg) {
    meta.agentProfile = profileArg.trim().startsWith('{') ? JSON.parse(profileArg) : profileArg;
  }
  const sess = await request('session/new', {
    cwd: workdir,
    mcpServers: [],
    ...(profileArg ? { _meta: meta } : {}),
  });
  console.log('SESSION/NEW:', JSON.stringify(sess).slice(0, 500));
} catch (e) {
  console.log('ERROR:', e.message);
}
child.kill();
process.exit(0);
