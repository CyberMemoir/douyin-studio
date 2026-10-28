import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job } from '../shared/types.js';
import {
  produceBundle,
  validateAction,
  actionEvidence,
  type PublicationUnit,
  type FamilyAction,
} from '../server/family-source-bundle.js';
import {
  cancelFamilyAction,
  recoverActionLock,
  runFamilyAction,
  studioRequest,
} from '../server/family-action.js';

async function main() {
  const command = process.argv[2];
  if (!['export', 'prepare', 'run', 'cancel', 'recover-lock'].includes(command))
    throw new Error('Use export/prepare/run/cancel/recover-lock');
  const args: Record<string, string> = {};
  const allowed = [
    'job',
    'output',
    'source-id',
    'unit',
    'material',
    'action',
    'action-objects',
    'state',
    'epoch',
    'mode',
    'pause-file',
    'studio-url',
    'reason',
  ];
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index].replace(/^--/, '');
    if (!allowed.includes(flag) || !process.argv[index + 1] || args[flag])
      throw new Error('Invalid/missing/repeated argument');
    args[flag] = process.argv[index + 1];
  }
  const material = args.material;
  if (!['fixture', 'historical_replay', 'real'].includes(material))
    throw new Error('Explicit --material fixture/historical_replay/real required');
  const read = async (file: string) => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  const action: FamilyAction | undefined = args.action ? validateAction(await read(args.action)) : undefined;
  if (action && ['prepare', 'run'].includes(command)) await actionEvidence(action, args['action-objects']);
  if (args.output && ['export', 'prepare', 'run'].includes(command)) {
    await fs.access(path.dirname(path.resolve(args.output)));
    const exists = await fs.stat(args.output).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      },
    );
    if (exists) throw new Error('Output exists; do not submit another reader action');
  }
  let job: Job;
  let execution:
    { execution_id: string; mode: string; epoch: string; status: string; reader_origin: string } | undefined;
  if (command === 'export') {
    if (!args.job || !args.output || !args['source-id'] || !args.unit)
      throw new Error('Export requires --job --output --source-id --unit seconds/milliseconds/unknown');
    job = await read(args.job);
  } else {
    if (!action || !args.state) throw new Error('Action commands require --action --state');
    if (command === 'cancel') {
      console.log(
        JSON.stringify({ cancelled_recipe: await cancelFamilyAction(action, args.state, args.reason ?? '') }),
      );
      return;
    }
    if (!args.epoch || !['head', 'history'].includes(args.mode))
      throw new Error('Explicit --epoch and --mode head/history required');
    if (command === 'recover-lock') {
      console.log(
        JSON.stringify(
          await recoverActionLock(action, args.state, args.epoch, args.mode as 'head' | 'history'),
        ),
      );
      return;
    }
    if (!args['pause-file'])
      throw new Error('--pause-file must bind the actual private Studio data directory');
    if (command === 'run' && !args['studio-url'])
      throw new Error('Live action requires explicit local --studio-url');
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const journal = await runFamilyAction(action, {
      directory: args.state,
      epoch: args.epoch,
      mode: args.mode as 'head' | 'history',
      pauseFile: args['pause-file'],
      signal: controller.signal,
      request: command === 'run' ? studioRequest(args['studio-url']) : undefined,
    });
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    console.log(
      JSON.stringify({
        execution_id: journal.execution_id,
        status: journal.status,
        reason: journal.reason,
        job_id: journal.job_id,
      }),
    );
    if (!args.output) return;
    if (['prepared', 'waiting', 'submission_unknown', 'running'].includes(journal.status))
      throw new Error('Reader has not reached a terminal outcome; state retained, no bundle');
    execution = {
      execution_id: journal.execution_id,
      mode: journal.mode,
      epoch: journal.epoch,
      status: journal.status,
      reader_origin: journal.job ? 'studio_job' : 'local_action_gate',
    };
    job = journal.job ?? {
      id: journal.execution_id,
      type: 'search',
      title: action.query,
      status: journal.status === 'cancelled' ? 'cancelled' : 'failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: null,
      phase: journal.status,
      logs: [],
      error: journal.status === 'blocked_verification' ? '人工验证暂停' : (journal.reason ?? journal.status),
    };
    if (journal.status === 'prepared')
      throw new Error('Prepared request is not a reader outcome; no source bundle');
    args['source-id'] ??= `douyin-family-${journal.recipe_id}`;
    args.unit ??= 'seconds';
  }
  const manifest = await produceBundle(job, args.output, {
    sourceId: args['source-id'],
    publicationUnit: args.unit as PublicationUnit,
    material: material as 'fixture' | 'historical_replay' | 'real',
    action,
    actionObjects: args['action-objects'],
    execution,
  });
  console.log(JSON.stringify(manifest));
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, automatic_retry: false }));
  process.exitCode = 2;
});
