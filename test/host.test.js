import './env.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { startServer } from '../src/server.js';

openDb();

// A non-loopback IPv4 address of this machine (e.g. its Wi-Fi/LAN address), if any.
const lanIp = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const canConnect = (host, port) => new Promise((resolve) => {
  const s = net.connect({ host, port, timeout: 2000 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});

async function listening(opts) {
  const server = startServer(opts);
  await new Promise((r) => server.once('listening', r));
  return server;
}

test('defaults to 127.0.0.1 (this computer only)', async () => {
  assert.equal(config.host, '127.0.0.1');
  const server = await listening({ port: 0 });
  try {
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    assert.equal(await canConnect('127.0.0.1', port), true);
    if (lanIp) assert.equal(await canConnect(lanIp, port), false, `reachable on ${lanIp}`);
  } finally {
    server.close();
  }
});

test('HOST=0.0.0.0 listens on all interfaces', async () => {
  const server = await listening({ host: '0.0.0.0', port: 0 });
  try {
    const { address, port } = server.address();
    assert.equal(address, '0.0.0.0');
    if (lanIp) assert.equal(await canConnect(lanIp, port), true);
  } finally {
    server.close();
  }
});

test('HOST is read from the environment', () => {
  const read = (env) => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    "import { config } from './src/config.js'; process.stdout.write(config.host);"], { env: { ...process.env, ...env } }).toString();
  assert.equal(read({ HOST: '0.0.0.0' }), '0.0.0.0');
});

test('Docker images listen on 0.0.0.0 explicitly', () => {
  assert.match(fs.readFileSync('Dockerfile', 'utf8'), /^ENV .*\bHOST=0\.0\.0\.0\b/m);
  assert.match(fs.readFileSync('docker-compose.yml', 'utf8'), /web:[\s\S]*?environment: \{[^}]*HOST: 0\.0\.0\.0/);
});
