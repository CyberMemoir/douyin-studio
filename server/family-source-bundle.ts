import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Job } from '../shared/types.js';

export const sha256 = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');
export type PublicationUnit = 'seconds' | 'milliseconds' | 'unknown';
export type FamilyAction = {
  action_type: 'search';
  target_platform: 'douyin';
  family_id: string;
  query: string;
  purpose: 'find_independent_uses' | 'find_original_reference' | 'find_explainer';
  evidence_refs: { evidence_sha: string; locator: string; span: [number, number]; original_text: string }[];
  query_layer: 'rule_seed';
  is_actual_search_log: false;
};

export function validateAction(value: FamilyAction): FamilyAction {
  if (
    value.action_type !== 'search' ||
    value.target_platform !== 'douyin' ||
    typeof value.family_id !== 'string' ||
    !value.family_id ||
    typeof value.query !== 'string' ||
    !value.query.trim() ||
    value.query.trim().length > 400 ||
    value.query_layer !== 'rule_seed' ||
    value.is_actual_search_log !== false ||
    !['find_independent_uses', 'find_original_reference', 'find_explainer'].includes(value.purpose) ||
    !Array.isArray(value.evidence_refs)
  )
    throw new Error('Unsupported family search action contract');
  for (const ref of value.evidence_refs) {
    if (
      !/^[a-f0-9]{64}$/.test(ref.evidence_sha) ||
      typeof ref.locator !== 'string' ||
      !ref.locator.startsWith('/') ||
      !Array.isArray(ref.span) ||
      ref.span.length !== 2 ||
      !ref.span.every(Number.isInteger) ||
      typeof ref.original_text !== 'string'
    )
      throw new Error('Invalid family action evidence reference');
  }
  // Only the public action contract is retained; ignore caller-local transport/config fields.
  return {
    action_type: value.action_type,
    target_platform: value.target_platform,
    family_id: value.family_id,
    query: value.query,
    purpose: value.purpose,
    evidence_refs: value.evidence_refs.map((ref) => ({
      evidence_sha: ref.evidence_sha,
      locator: ref.locator,
      span: ref.span,
      original_text: ref.original_text,
    })),
    query_layer: value.query_layer,
    is_actual_search_log: false,
  };
}

export function readerOutcome(job: Job) {
  const error = job.error ?? '';
  if (/HTTP 429|访问过于频繁|操作频繁/.test(error))
    return { outcome: 'blocked_verification', reader_outcome: 'blocked_rate_limit' };
  if (/扫码|重新登录|HTTP 401/.test(error))
    return { outcome: 'blocked_login', reader_outcome: 'blocked_login' };
  if (/人工验证|限制|HTTP (403|412|461|471|567)/.test(error))
    return { outcome: 'blocked_verification', reader_outcome: 'blocked_verification' };
  if (job.status === 'completed')
    return {
      outcome: job.type === 'search' ? 'partial' : 'succeeded',
      reader_outcome: job.type === 'search' ? 'bounded_search' : 'completed_detail',
    };
  return { outcome: 'failed', reader_outcome: job.status };
}

function epochTime(raw: number, unit: PublicationUnit, proof: object) {
  if (!Number.isSafeInteger(raw)) throw new Error('Publication epoch must retain an exact integer');
  const ms = unit === 'seconds' ? raw * 1000 : raw;
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw new Error('Invalid publication epoch');
  // Matches Python datetime.isoformat exactly, including six-digit fractional seconds.
  const iso = date.toISOString();
  const fraction = date.getUTCMilliseconds();
  const instant = iso.slice(0, 19) + (fraction ? `.${String(fraction).padStart(3, '0')}000` : '') + '+00:00';
  return {
    start_at: instant,
    end_at: instant,
    precision: unit === 'seconds' ? 'second' : 'millisecond',
    basis: unit === 'seconds' ? 'unix_seconds' : 'unix_milliseconds',
    source_evidence: proof,
  };
}

export function pointer(document: unknown, locator: string): unknown {
  let value = document;
  for (const part of locator.slice(1).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export async function actionEvidence(action: FamilyAction | null, directory?: string) {
  const objects = new Map<string, Buffer>();
  for (const ref of action?.evidence_refs ?? []) {
    if (!directory) throw new Error('Action evidence objects directory required');
    let file = path.join(directory, ref.evidence_sha + '.bin');
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      file = path.join(directory, ref.evidence_sha.slice(0, 2), ref.evidence_sha + '.bin');
      bytes = await fs.readFile(file);
    }
    if (sha256(bytes) !== ref.evidence_sha) throw new Error('Family action evidence hash mismatch');
    const original = pointer(JSON.parse(bytes.toString('utf8')), ref.locator);
    const [start, end] = ref.span;
    if (
      typeof original !== 'string' ||
      start < 0 ||
      end <= start ||
      end > Array.from(original).length ||
      Array.from(original).slice(start, end).join('') !== ref.original_text
    )
      throw new Error('Family action original text/span mismatch');
    objects.set(ref.evidence_sha, bytes);
  }
  return objects;
}

export async function produceBundle(
  job: Job,
  output: string,
  options: {
    sourceId: string;
    publicationUnit: PublicationUnit;
    material: 'fixture' | 'historical_replay' | 'real';
    action?: FamilyAction;
    actionObjects?: string;
    execution?: { execution_id: string; mode: string; epoch: string; status: string; reader_origin: string };
  },
) {
  if (!['search', 'resolve'].includes(job.type))
    throw new Error('Family producer currently supports search/resolve video jobs only');
  if (!options.sourceId || !['seconds', 'milliseconds', 'unknown'].includes(options.publicationUnit))
    throw new Error('Explicit source identity/publication unit required');
  const action = options.action ? validateAction(options.action) : null;
  const videos = (job.result?.videos ?? []).map((video) => {
    if (!/^\d{8,30}$/.test(video.id) || video.url !== `https://www.douyin.com/video/${video.id}`)
      throw new Error('Video identity mismatch');
    const observed =
      video.searchContext?.observedAt ?? video.detailContext?.observedAt ?? job.result?.fetchedAt;
    if (!observed || !/([zZ]|[+-]\d\d:\d\d)$/.test(observed) || !Number.isFinite(Date.parse(observed)))
      throw new Error('Actual timezone-qualified observation time required');
    if (action && video.searchContext?.requestedQuery !== action.query.trim())
      throw new Error('Family action query differs from reader evidence');
    if (typeof video.title !== 'string') throw new Error('Original title required');
    return {
      id: video.id,
      url: video.url,
      title: video.title,
      author_id: video.authorId ?? null,
      published_at_raw: video.createdAt ?? null,
      publication_unit: options.publicationUnit,
      observed_at: observed,
      observation_basis: video.searchContext
        ? 'response_body_parse'
        : video.detailContext
          ? 'detail_result_assembly'
          : 'reader_fetched_at',
      metrics: { likes: video.likes, comments: video.comments },
    };
  });
  if (videos.length > 1000) throw new Error('Bundle record budget exceeded');
  const outcome = readerOutcome(job);
  const view = {
    schema_version: 1,
    reader: { id: job.id, type: job.type, status: job.status, stop_code: outcome.reader_outcome },
    videos,
    action,
  };
  const body = Buffer.from(JSON.stringify(view));
  const evidenceSha = sha256(body);
  const objects = new Map<string, Buffer>([[evidenceSha, body]]);
  for (const [sha, bytes] of await actionEvidence(action, options.actionObjects)) objects.set(sha, bytes);
  const records = videos.map((video, index) => {
    const proof = {
      evidence_sha: evidenceSha,
      locator: `/videos/${index}/published_at_raw`,
      raw_value: video.published_at_raw,
    };
    const normalized =
      video.published_at_raw === null || options.publicationUnit === 'unknown'
        ? null
        : epochTime(video.published_at_raw, options.publicationUnit, proof);
    return {
      schema_version: 1,
      platform: 'douyin',
      kind: 'video',
      item_id: video.id,
      url: video.url,
      author_id: video.author_id,
      observed_at: video.observed_at,
      evidence_sha: evidenceSha,
      texts: [{ kind: 'title', text: video.title, locator: `/videos/${index}/title` }],
      published_at_raw: video.published_at_raw,
      publication_unit: video.published_at_raw === null ? 'unknown' : options.publicationUnit,
      normalized_published_time: normalized,
      metrics: video.metrics,
      is_actual_search_log: false,
      source_material: options.material,
      observation_basis: video.observation_basis,
      analysis_profile: {
        source_role: action?.purpose === 'find_explainer' ? 'explainer_candidate' : 'unknown',
      },
    };
  });
  const recordsBody = records.map((row) => JSON.stringify(row) + '\n').join('');
  if (Buffer.byteLength(recordsBody) > 16 * 1024 ** 2) throw new Error('Bundle byte budget exceeded');
  const manifest = {
    schema_name: 'family-source-bundle-v1',
    schema_version: 1,
    platform: 'douyin',
    source_id: options.sourceId,
    ...outcome,
    ...(options.execution
      ? {
          execution: options.execution,
          reader_outcome:
            options.execution.reader_origin === 'local_action_gate'
              ? options.execution.status
              : outcome.reader_outcome,
        }
      : {}),
    records_sha256: sha256(recordsBody),
    objects: [...objects.keys()].sort(),
    material: options.material,
    record_count: records.length,
    native_history_cursor: null,
    history_capability: 'unsupported',
    public_import_authorized: false,
  };
  // Manifest appears last. Incomplete directories are diagnostic evidence, never complete bundles.
  await fs.mkdir(output, { recursive: false });
  await fs.mkdir(path.join(output, 'objects'));
  for (const [sha, bytes] of objects)
    await fs.writeFile(path.join(output, 'objects', sha + '.bin'), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'records.jsonl'), recordsBody, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
  });
  return manifest;
}
