import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Job } from '../shared/types.js';
import { digest, discoveryExport, emptyCheckpoint } from '../server/discovery-export.js';

async function main() {
  const options: Record<string, string> = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i];
    if (
      !['--job', '--output', '--checkpoint', '--seed', '--pause-file'].includes(flag) ||
      !process.argv[i + 1] ||
      options[flag]
    )
      throw new Error('Invalid/missing/repeated argument');
    options[flag] = process.argv[i + 1];
  }
  if (!options['--job'] || !options['--output'] || !options['--checkpoint'])
    throw new Error('--job --output NEW_DIRECTORY --checkpoint required');
  const output = path.resolve(options['--output']);
  await fs.access(path.dirname(output));
  if (
    await fs.stat(output).then(
      () => true,
      () => false,
    )
  )
    throw new Error('Output exists; preserve previous evidence');
  const checkpoint = path.resolve(options['--checkpoint']);
  const prior = await fs.readFile(checkpoint, 'utf8').then(JSON.parse, (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return emptyCheckpoint();
  });
  const text = (await fs.readFile(options['--job'], 'utf8')).replace(/^\uFEFF/, '');
  let pause: object | null = null;
  if (options['--pause-file']) pause = JSON.parse(await fs.readFile(options['--pause-file'], 'utf8'));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    encoding: 'utf8',
  }).trim();
  const report = discoveryExport(
    JSON.parse(text) as Job,
    digest(text),
    { seed: options['--seed'], paused: pause !== null, commit },
    prior,
  );
  await fs.mkdir(output);
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
  const lines = (values: unknown[]) => values.map((value) => JSON.stringify(value) + '\n').join('');
  const files: Record<string, string> = {
    'job.json': text,
    'nodes.jsonl': lines(report.nodes),
    'edges.jsonl': lines(report.edges),
    'queries.jsonl': lines(report.queries),
    'frontier.json': json(report.frontier),
    'capabilities.json': json(report.capabilities),
    'trial_summary.json': json(report.summary),
    'media_manifest.jsonl': lines(
      report.frontier
        .filter((request) => request.kind === 'media_descriptor')
        .map((request) => ({
          schema_version: 'platform-collection-v1',
          platform: 'douyin',
          video_id: request.video_id,
          canonical_url: `https://www.douyin.com/video/${request.video_id}`,
          request_id: request.request_id,
          state: request.state,
          media_sha: null,
          local_media_path: null,
          origin_verified: false,
          rule_reason: request.reason,
          required_step: 'shared_collector_resolve_then_source_media_descriptor',
          ocr_owner: 'shared_collector',
        })),
    ),
    'pause.json': json(pause),
  };
  for (const page of report.rawPages) files[`comment-${page.sha256}.json`] = page.body;
  for (const [name, body] of Object.entries(files))
    await fs.writeFile(path.join(output, name), body, { flag: 'wx' });
  await fs.writeFile(
    path.join(output, 'manifest.json'),
    json({
      files: Object.entries(files).map(([name, body]) => ({ path: name, sha256: digest(body) })),
      public_import_authorized: false,
    }),
    { flag: 'wx' },
  );
  // Single-writer local checkpoint; shared queue/database ownership remains external.
  await fs.writeFile(checkpoint + '.tmp', json(report.state));
  await fs.rename(checkpoint + '.tmp', checkpoint);
  console.log(JSON.stringify(report.summary));
}
main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, automatic_retry: false }));
  process.exitCode = 2;
});
