import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Job, Video } from '../shared/types.js';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
type Note = {
  id: string;
  text: string;
  span: [number, number];
  targetIds: string[];
  relation?: 'derivative' | 'observed_use';
};

export function validateVideo(video: Video): void {
  if (!/^\d{8,30}$/.test(video.id) || video.url !== `https://www.douyin.com/video/${video.id}`)
    throw new Error('作品数字 ID 与规范 URL 不一致，停止证据关联');
}

export async function waitForJob(
  id: string,
  readState: () => Promise<{ jobs: Job[] }>,
  timeoutMs = 120_000,
  pollMs = 1000,
): Promise<{ job: Job | null; clientStatus: string }> {
  const deadline = Date.now() + timeoutMs;
  let job: Job | null = null;
  do {
    job = (await readState()).jobs.find((item) => item.id === id) ?? null;
    if (!job) throw new Error(`任务 ${id} 不在工作台状态中；不自动重提`);
    if (terminal.has(job.status)) return { job, clientStatus: job.status };
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return { job, clientStatus: 'client_timeout' };
}

export async function saveEvidence(job: Job, output: string, notes: Note[] = [], input: unknown = null) {
  if (job.type === 'comments') return saveComments(job, output, input);
  if (!['search', 'resolve'].includes(job.type)) throw new Error('只归档搜索、详情或评论任务');
  // Only a completed job supplies content evidence; failed/partial results are not successes.
  const videos = job.status === 'completed' ? (job.result?.videos ?? []) : [];
  for (const video of videos) validateVideo(video);
  const safeVideo = (video: Video) => {
    const {
      id,
      title,
      author,
      url,
      duration,
      likes,
      comments,
      createdAt,
      source,
      searchContext,
      detailContext,
    } = video;
    return {
      id,
      title,
      author,
      url,
      duration,
      likes,
      comments,
      createdAt,
      source,
      searchContext,
      detailContext,
    };
  };
  const archived = {
    id: job.id,
    type: job.type,
    status: job.status,
    title: job.title,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
    logs: job.logs,
    result: { fetchedAt: job.result?.fetchedAt ?? null, videos: videos.map(safeVideo) },
  };
  const jobText = json(archived);
  const evidence = { path: path.resolve(output, 'job.json'), sha256: hash(jobText) };
  const sources = videos.map((video, index) => ({
    source_id: `douyin:${video.id}`,
    platform: 'douyin',
    platform_item_id: video.id,
    public_url: video.url,
    title: video.title,
    author_display_name: video.author,
    author_public_id: null,
    observed_at: video.searchContext?.observedAt ?? video.detailContext?.observedAt ?? null,
    observation_basis: video.searchContext
      ? 'search_response_body_parse'
      : (video.detailContext?.observationBasis ?? 'unknown_legacy_export'),
    publication_unix_seconds: video.createdAt,
    publication_raw: null,
    published_at: video.createdAt === null ? null : new Date(video.createdAt * 1000).toISOString(),
    publication_precision: video.createdAt === null ? null : 'platform_reported_second_not_verified_original',
    metrics: { like_count: video.likes, comment_count: video.comments },
    raw_metrics: null,
    search_context: video.searchContext ?? null,
    detail_context: video.detailContext ?? null,
    evidence: { ...evidence, locator: `/result/videos/${index}` },
    title_locator: `/result/videos/${index}/title`,
    media_verified: false,
    origin_verified: false,
  }));
  const applicableNotes = job.status === 'completed' ? notes : [];
  const queries = applicableNotes.map((note) => {
    const source = sources.find((row) => row.platform_item_id === note.id);
    if (!source) throw new Error('原句标注指向未完成或不存在的作品');
    const [start, end] = note.span;
    const points = Array.from(source.title);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end <= start ||
      end > points.length ||
      points.slice(start, end).join('') !== note.text
    )
      throw new Error('原句与 Unicode 半开定位不一致；不自动改写');
    if (!Array.isArray(note.targetIds) || !note.targetIds.every((id) => typeof id === 'string'))
      throw new Error('targetIds 必须是字符串数组，可为空以保留未知关联');
    if (note.relation && !['derivative', 'observed_use'].includes(note.relation))
      throw new Error('不支持的提案类型');
    return {
      source_id: source.source_id,
      original_text: note.text,
      full_context: source.title,
      span: note.span,
      span_unit: 'zero_based_unicode_codepoints_half_open',
      evidence_layer: 'real_expression',
      target_ids: note.targetIds,
      observed_at: source.observed_at,
      evidence: { ...source.evidence, locator: source.title_locator },
      is_actual_search_log: false,
      confirmed_alias: null,
      status: 'awaiting_human',
      human_decision: null,
      ingest_approved: false,
    };
  });
  const candidates = applicableNotes.flatMap((note, index) =>
    note.relation
      ? [
          {
            source_id: queries[index].source_id,
            operation_proposal: `append_${note.relation}`,
            target_ids: note.targetIds,
            evidence: queries[index].evidence,
            original_text: note.text,
            full_context: queries[index].full_context,
            status: 'awaiting_human',
            human_decision: null,
            ingest_approved: false,
            definition_change: false,
            usage_context_change: false,
            media_verified: false,
            origin_verified: false,
          },
        ]
      : [],
  );
  // Notes only anchor an explicit review proposal. No title automatically becomes a query or derivative.
  const textFiles: Record<string, string> = {
    'job.json': jobText,
    'sources.jsonl': sources.map((row) => JSON.stringify(row) + '\n').join(''),
    'queries.jsonl': queries.map((row) => JSON.stringify(row) + '\n').join(''),
    'candidates.jsonl': candidates.map((row) => JSON.stringify(row) + '\n').join(''),
    'input.json': json(input),
    'notes.json': json(notes),
  };
  await fs.mkdir(output, { recursive: false });
  for (const [name, text] of Object.entries(textFiles))
    await fs.writeFile(path.join(output, name), text, { flag: 'wx' });
  const manifest = {
    artifact_kind: 'normalized_public_job_metadata_not_original_HTTP',
    files: Object.entries(textFiles).map(([name, text]) => ({ path: name, sha256: hash(text) })),
    source_count: sources.length,
    query_count: queries.length,
    candidate_count: candidates.length,
    job_status: job.status,
    public_import_authorized: false,
    recorded_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(output, 'manifest.json'), json(manifest), { flag: 'wx' });
  return manifest;
}

export async function saveComments(job: Job, output: string, input: unknown = null) {
  const collection = job.status === 'completed' ? job.result?.commentCollection : undefined;
  if (job.status === 'completed' && !collection) throw new Error('完成的评论任务缺少结果');
  if (collection) {
    for (const page of collection.pages) {
      if (hash(page.rawBody) !== page.bodySha256 || page.videoId !== collection.videoId)
        throw new Error('评论响应指纹或作品ID不一致');
    }
    for (const comment of collection.comments) {
      const page = collection.pages.find((page) => page.bodySha256 === comment.bodySha256);
      const index = /^\/comments\/(\d+)\/text$/.exec(comment.locator)?.[1];
      if (
        !page ||
        index === undefined ||
        JSON.parse(page.rawBody).comments[Number(index)]?.text !== comment.text ||
        comment.videoId !== collection.videoId
      )
        throw new Error('评论原句与来源定位不一致');
    }
  }
  const jobText = json({
    id: job.id,
    type: job.type,
    status: job.status,
    error: job.error ?? null,
    result: collection ?? null,
    input,
  });
  const evidence = { path: 'job.json', sha256: hash(jobText) };
  const records = (collection?.comments ?? []).map((comment) => ({
    ...comment,
    platform: 'douyin',
    source_id: `douyin:${comment.videoId}:comment:${comment.id}`,
    public_url: `https://www.douyin.com/video/${comment.videoId}`,
    evidence_layer: 'real_expression',
    status: 'source_archived',
    human_decision: null,
    evidence,
    is_actual_search_log: false,
    definition_change: false,
    usage_context_change: false,
  }));
  const files = {
    'job.json': jobText,
    'comments.jsonl': records.map((r) => JSON.stringify(r) + '\n').join(''),
  };
  await fs.mkdir(output, { recursive: false });
  for (const [name, content] of Object.entries(files))
    await fs.writeFile(path.join(output, name), content, { flag: 'wx' });
  const manifest = {
    artifact_kind: 'original_comment_response_and_normalized_text',
    files: Object.entries(files).map(([name, content]) => ({ path: name, sha256: hash(content) })),
    source_count: records.length,
    query_count: 0,
    candidate_count: 0,
    job_status: job.status,
    end_reason: collection?.endReason ?? null,
    coverage: collection?.coverage ?? null,
    public_import_authorized: false,
  };
  await fs.writeFile(path.join(output, 'manifest.json'), json(manifest), { flag: 'wx' });
  return manifest;
}

async function main() {
  const options: Record<string, string> = {};
  const allowed = [
    'query',
    'job-id',
    'from-job',
    'output',
    'url',
    'limit',
    'timeout-ms',
    'notes',
    'input-layer',
    'input-evidence',
    'kind',
    'max-scrolls',
  ];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, '');
    if (!process.argv[i].startsWith('--') || !allowed.includes(key) || !process.argv[i + 1] || options[key])
      throw new Error('未知、重复或缺值参数');
    options[key] = process.argv[i + 1];
  }
  if (!options.output || ['query', 'job-id', 'from-job'].filter((key) => options[key]).length !== 1)
    throw new Error('提供 --output 新目录，以及 --query / --job-id / --from-job 三者之一');
  await fs.access(path.dirname(path.resolve(options.output)));
  if (
    await fs.stat(options.output).then(
      () => true,
      () => false,
    )
  )
    throw new Error('输出目录已存在，不覆盖原证据');
  const kind = options.kind ?? 'search';
  if (!['search', 'comments'].includes(kind)) throw new Error('kind范围search/comments');
  if (kind === 'comments' && options.query && !/^\d{8,30}$/.test(options.query))
    throw new Error('评论输入必须是作品数字ID');
  const maxScrolls = Number(options['max-scrolls'] ?? 0);
  if (!Number.isInteger(maxScrolls) || maxScrolls < 0 || maxScrolls > 2)
    throw new Error('max-scrolls范围0–2');
  const notes: Note[] = options.notes ? JSON.parse(await fs.readFile(options.notes, 'utf8')) : [];
  if (!Array.isArray(notes)) throw new Error('notes 必须是数组');
  const layer = options['input-layer'] ?? 'researcher_seed';
  if (!['researcher_seed', 'real_expression', 'platform_search_clue'].includes(layer))
    throw new Error('输入层级不合法；本入口不生成AI query');
  if (layer !== 'researcher_seed' && !options['input-evidence'])
    throw new Error('人的原句/平台线索输入需 --input-evidence 指向出处');
  const inputEvidence = options['input-evidence']
    ? await fs.readFile(options['input-evidence'], 'utf8')
    : null;
  const input = {
    query: options.query ?? null,
    layer,
    provenance: options['from-job'] ? 'offline_replay' : 'local_api',
    source_evidence:
      inputEvidence === null
        ? null
        : {
            path: path.resolve(options['input-evidence']),
            sha256: hash(inputEvidence),
            content: JSON.parse(inputEvidence),
          },
    // Researcher seeds are control inputs, never emitted as observed human queries.
    is_actual_user_search_log: false,
  };
  let job: Job;
  let clientStatus: string;
  if (options['from-job']) {
    job = JSON.parse((await fs.readFile(options['from-job'], 'utf8')).replace(/^\uFEFF/, ''));
    clientStatus = terminal.has(job.status) ? job.status : 'nonterminal_replay';
  } else {
    const url = new URL(options.url ?? 'http://127.0.0.1:4321');
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('仅允许本机工作台HTTP origin');
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(`${url.origin}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Studio-Client': '1' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(`本机接口 HTTP ${response.status}: ${value.error ?? '请求失败'}`);
      return value;
    };
    const limit = Number(options.limit ?? 8),
      timeout = Number(options['timeout-ms'] ?? 120_000);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 8 ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 300_000
    )
      throw new Error('limit范围1–8；timeout-ms范围1–300000');
    let id = options['job-id'];
    if (!id) {
      // Never repeat this mutation on error: an HTTP timeout can mean acceptance is unknown.
      const submitted = await request(
        kind,
        kind === 'comments' ? { videoId: options.query, limit, maxScrolls } : { query: options.query, limit },
      ).catch((error) => {
        throw new Error(`提交结果未知或失败；先检查 /api/state，不自动重提。${error.message}`);
      });
      id = submitted.id;
      console.error(JSON.stringify({ job_id: id, state: 'submitted', resume: '--job-id ' + id }));
    }
    try {
      const result = await waitForJob(id!, () => request('state'), timeout);
      if (!result.job) throw new Error('没有任务快照');
      job = result.job;
      clientStatus = result.clientStatus;
    } catch (error) {
      throw new Error(
        `任务 ${id} 状态读取失败；使用 --job-id 继续读取，禁止自动重提。${error instanceof Error ? error.message : ''}`,
      );
    }
  }
  const manifest = await saveEvidence(job, options.output, notes, input);
  const needsHuman = /人工验证|重新登录|扫码|限制|操作频繁|访问过于频繁|HTTP 403/.test(job.error ?? '');
  const report = {
    job_id: job.id,
    client_status: clientStatus,
    job_status: job.status,
    error: job.error ?? null,
    needs_human: needsHuman,
    counts: {
      sources: manifest.source_count,
      queries: manifest.query_count,
      candidates: manifest.candidate_count,
    },
    output: path.resolve(options.output),
  };
  await fs.writeFile(path.join(options.output, 'run.json'), json(report), { flag: 'wx' });
  console.log(JSON.stringify(report));
  process.exitCode =
    clientStatus === 'completed' ? 0 : needsHuman ? 3 : clientStatus === 'client_timeout' ? 4 : 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message, automatic_retry: false }));
    process.exitCode = 2;
  });
