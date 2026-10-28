import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const cwd = fileURLToPath(new URL('../', import.meta.url));
async function fixtureServer(directory: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/family-studio.ts', directory], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Fixture API startup timeout'));
    }, 15_000);
    let text = '';
    child.stdout.on('data', (body) => {
      text += body.toString();
      if (text.includes('\n')) {
        clearTimeout(timer);
        resolve(JSON.parse(text.split('\n')[0]).origin);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Fixture exited before startup: ' + code));
    });
  });
  return {
    origin,
    close: async () => {
      if (child.exitCode !== null) return;
      await fetch(origin + '/fixture/checkpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
        body: '{}',
      });
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      });
    },
  };
}

test('separate action/Studio processes preserve keyed receipts, new head epochs, and persistent cancellation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'family-process-'));
  let server: Awaited<ReturnType<typeof fixtureServer>> | undefined;
  try {
    const action = path.join(root, 'action.json');
    await fs.writeFile(
      action,
      JSON.stringify({
        action_type: 'search',
        target_platform: 'douyin',
        family_id: '00000000-0000-4000-8000-000000000001',
        query: '甲表达',
        purpose: 'find_independent_uses',
        evidence_refs: [],
        query_layer: 'rule_seed',
        is_actual_search_log: false,
      }),
    );
    const cli = async (command: string, extra: string[]) =>
      execute(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/family-bundle.ts',
          command,
          '--action',
          action,
          '--state',
          path.join(root, 'action-state'),
          '--material',
          'fixture',
          ...extra,
        ],
        { cwd },
      );
    server = await fixtureServer(path.join(root, 'studio-state'));
    const run = (epoch: string, output: string) =>
      cli('run', [
        '--epoch',
        epoch,
        '--mode',
        'head',
        '--studio-url',
        server!.origin,
        '--pause-file',
        path.join(root, 'absent.pause'),
        '--output',
        path.join(root, output),
      ]);
    await run('epoch-1', 'bundle-1');
    await server.close();
    server = await fixtureServer(path.join(root, 'studio-state'));
    await run('epoch-1', 'replayed');
    let state = await (await fetch(server.origin + '/api/state')).json();
    assert.equal(state.jobs.length, 1);
    await run('epoch-2', 'bundle-2');
    state = await (await fetch(server.origin + '/api/state')).json();
    assert.equal(state.jobs.length, 2);
    assert.notEqual(state.jobs[0].idempotencyKey, state.jobs[1].idempotencyKey);
    const one = JSON.parse(await fs.readFile(path.join(root, 'bundle-1/manifest.json'), 'utf8'));
    const replay = JSON.parse(await fs.readFile(path.join(root, 'replayed/manifest.json'), 'utf8'));
    assert.equal(one.records_sha256, replay.records_sha256);
    await cli('cancel', ['--reason', 'fixture operator cancellation']);
    await run('epoch-3', 'cancelled');
    const cancelled = JSON.parse(await fs.readFile(path.join(root, 'cancelled/manifest.json'), 'utf8'));
    assert.equal(cancelled.reader_outcome, 'cancelled');
    assert.equal(cancelled.record_count, 0);
    state = await (await fetch(server.origin + '/api/state')).json();
    assert.equal(state.jobs.length, 2);
  } finally {
    if (server) await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
