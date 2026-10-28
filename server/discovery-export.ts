/** Offline platform-collection-v1 bridge. Shared collector owns scheduling and downloads. */
import { createHash } from 'node:crypto';
import type { Job, CommentCollection } from '../shared/types.js';

export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Identity = { platform: 'douyin'; entity_type: 'video' | 'author' | 'topic' | 'tag'; entity_id: string };
type Evidence = { observed_at: string | null; evidence_sha: string; locator: string };
export type Node = Identity &
  Evidence & {
    schema_version: 'platform-collection-v1';
    canonical_url: string | null;
    [key: string]: unknown;
  };
type Edge = Evidence & {
  schema_version: 'platform-collection-v1';
  from: Identity;
  to: Identity;
  relation: string;
};
export type Recipe = {
  request_id: string;
  kind: 'search' | 'detail' | 'media_descriptor';
  method: 'POST' | 'GET';
  path: string;
  body?: object;
  video_id?: string;
  state: 'pending' | 'blocked_verification';
  input_layer?: 'rule_seed';
  reason: string;
};
export type Checkpoint = {
  version: 1;
  processed: string[];
  nodes: Record<string, Node>;
  edges: Record<string, Edge>;
  requests: Record<string, Recipe>;
};
export const emptyCheckpoint = (): Checkpoint => ({
  version: 1,
  processed: [],
  nodes: {},
  edges: {},
  requests: {},
});
const identity = (kind: Identity['entity_type'], id: string): Identity => ({
  platform: 'douyin',
  entity_type: kind,
  entity_id: id,
});
const key = (node: Identity) => `${node.platform}:${node.entity_type}:${node.entity_id}`;

export function discoveryExport(
  job: Job,
  evidenceSha: string,
  options: { seed?: string; paused?: boolean; commit: string },
  previous = emptyCheckpoint(),
) {
  if (!/^[a-f0-9]{64}$/.test(evidenceSha) || previous.version !== 1)
    throw new Error('Invalid evidence/checkpoint version');
  const state: Checkpoint = structuredClone(previous);
  const nodes: Node[] = [],
    edges: Edge[] = [],
    frontier: Recipe[] = [];
  const queries: object[] = [],
    rawPages: { sha256: string; body: string }[] = [];
  const blocked =
    options.paused === true ||
    /人工验证|扫码|重新登录|限制|HTTP (403|412|429|461|471|567)/.test(job.error ?? '');
  const capability = (name: string, implemented: boolean, reason: string) => ({
    name,
    status: implemented ? (blocked ? 'blocked' : 'unverified') : 'unsupported',
    reason,
    version: options.commit,
    verified_at: null,
    evidence_sha: evidenceSha,
  });
  const capabilities = [
    capability('search', true, 'Bounded existing reader; current implementation is not live acceptance'),
    capability('detail', true, 'Exact video-ID reader'),
    capability('trends', true, 'Observed hot words can seed bounded searches'),
    capability('comments', true, 'Bounded top-level responses, not all comments'),
    capability(
      'source_media_descriptor',
      true,
      'Completed resolve receipt only; download/OCR belong to shared collector',
    ),
    capability('author_feed', false, 'No verified author-list reader; author identity is metadata only'),
    capability(
      'topic_feed',
      false,
      'No verified topic-page reader; native topic membership is metadata only',
    ),
    capability('related_videos', false, 'No verified related endpoint; never infer recommendation edges'),
    capability('search_cursor', false, 'Reader exposes bounded scrolls, not a resumable native page cursor'),
  ];
  const addNode = (id: Identity, evidence: Evidence, fields: Record<string, unknown>) => {
    const node: Node = {
      ...id,
      ...evidence,
      schema_version: 'platform-collection-v1',
      canonical_url: null,
      ...fields,
    };
    if (JSON.stringify(state.nodes[key(id)]) !== JSON.stringify(node)) {
      state.nodes[key(id)] = node;
      const index = nodes.findIndex((row) => key(row) === key(id));
      if (index < 0) nodes.push(node);
      else nodes[index] = node;
    }
  };
  const addEdge = (from: Identity, to: Identity, relation: string, evidence: Evidence) => {
    const edge: Edge = { schema_version: 'platform-collection-v1', from, to, relation, ...evidence };
    const edgeId = digest(JSON.stringify(edge));
    if (!state.edges[edgeId]) {
      state.edges[edgeId] = edge;
      edges.push(edge);
    }
  };
  const addRequest = (recipe: Omit<Recipe, 'request_id' | 'state'>) => {
    const requestId = digest(JSON.stringify(recipe));
    if (!state.requests[requestId]) {
      const request: Recipe = {
        ...recipe,
        request_id: requestId,
        state: blocked ? 'blocked_verification' : 'pending',
      };
      state.requests[requestId] = request;
      frontier.push(request);
    }
  };
  const seed = (text: string, evidence: Evidence, layer: 'rule_seed' | 'platform_search_clue') => {
    // Synthetic seed identity is explicitly not a native Douyin topic ID.
    const id = identity('topic', 'seed:' + digest(text));
    addNode(id, evidence, {
      label: text,
      identity_basis: 'seed_text_not_native_topic',
      input_layer: layer,
      is_actual_search_log: false,
    });
    return id;
  };
  if (!state.processed.includes(evidenceSha) && job.status === 'completed') {
    if (job.type === 'trends') {
      for (const [index, trend] of (job.result?.trends ?? []).entries()) {
        const evidence = {
          evidence_sha: evidenceSha,
          observed_at: job.result?.fetchedAt ?? null,
          locator: `/result/trends/${index}/word`,
        };
        seed(trend.word, evidence, 'platform_search_clue');
        queries.push({
          original_text: trend.word,
          source_kind: 'observed_hot_word',
          full_context: trend.word,
          evidence_layer: 'platform_search_clue',
          ...evidence,
          is_actual_search_log: false,
        });
        addRequest({
          kind: 'search',
          method: 'POST',
          path: '/api/search',
          body: { query: trend.word, limit: 8, maxScrolls: 0 },
          input_layer: 'rule_seed',
          reason: 'observed_hot_word',
        });
      }
    } else if (job.type === 'comments') {
      // Both existing API jobs and collect.ts comment archives are supported.
      const collection = job.result?.commentCollection ?? (job.result as unknown as CommentCollection);
      if (!collection || !/^\d{8,30}$/.test(collection.videoId) || !Array.isArray(collection.pages))
        throw new Error('Invalid comment collection');
      for (const page of collection.pages) {
        if (digest(page.rawBody) !== page.bodySha256 || page.videoId !== collection.videoId)
          throw new Error('Comment page evidence mismatch');
        rawPages.push({ sha256: page.bodySha256, body: page.rawBody });
      }
      for (const comment of collection.comments) {
        const page = collection.pages.find((row) => row.bodySha256 === comment.bodySha256);
        const index = /^\/comments\/(\d+)\/text$/.exec(comment.locator)?.[1];
        if (
          !page ||
          index === undefined ||
          JSON.parse(page.rawBody).comments[Number(index)]?.text !== comment.text ||
          comment.videoId !== collection.videoId
        )
          throw new Error('Comment text/identity locator mismatch');
        queries.push({
          original_text: comment.text,
          source_id: `${comment.videoId}:comment:${comment.id}`,
          public_url: `https://www.douyin.com/video/${comment.videoId}`,
          full_context: comment.text,
          context_coverage: 'top_level_comment_only_parent_title_not_in_comment_job',
          video_id: comment.videoId,
          author_id: comment.authorId,
          evidence_layer: 'real_expression',
          observed_at: comment.observedAt,
          evidence_sha: comment.bodySha256,
          locator: comment.locator,
          is_actual_search_log: false,
          association_status: 'unreviewed_expression_not_material_naming',
        });
      }
    } else if (job.type === 'search' || job.type === 'resolve') {
      if (!Array.isArray(job.result?.videos)) throw new Error('Completed job omitted video results');
      for (const [index, video] of job.result.videos.entries()) {
        if (!/^\d{8,30}$/.test(video.id) || video.url !== `https://www.douyin.com/video/${video.id}`)
          throw new Error('Video identity mismatch');
        if (options.seed && options.seed !== video.searchContext?.requestedQuery)
          throw new Error('Seed lacks matching actual search context');
        const evidence = {
          evidence_sha: evidenceSha,
          observed_at:
            video.searchContext?.observedAt ??
            video.detailContext?.observedAt ??
            job.result.fetchedAt ??
            null,
          locator: `/result/videos/${index}`,
        };
        const id = identity('video', video.id);
        addNode(id, evidence, {
          canonical_url: video.url,
          title: video.title,
          author_id: video.authorId ?? null,
          published_at_raw: video.createdAt,
          metrics: { likes: video.likes, comments: video.comments },
          media_verified: false,
        });
        if (options.seed && job.type === 'search')
          addEdge(
            seed(
              options.seed,
              { ...evidence, locator: `/result/videos/${index}/searchContext/requestedQuery` },
              'rule_seed',
            ),
            id,
            'search_result',
            evidence,
          );
        queries.push({
          original_text: video.title,
          source_id: video.id,
          public_url: video.url,
          full_context: video.title,
          evidence_layer: 'real_expression',
          ...evidence,
          locator: evidence.locator + '/title',
          is_actual_search_log: false,
          association_status: 'unreviewed_expression',
        });
        if (video.authorId) {
          const author = identity('author', video.authorId);
          addNode(
            author,
            { ...evidence, locator: evidence.locator + '/authorId' },
            { label: video.author, identity_basis: 'returned_public_uid' },
          );
          addEdge(author, id, 'author_post', { ...evidence, locator: evidence.locator + '/authorId' });
        }
        for (const [topicIndex, topic] of (video.topics ?? []).entries()) {
          const topicId = identity('topic', topic.id);
          const location = { ...evidence, locator: `${evidence.locator}/topics/${topicIndex}` };
          addNode(topicId, location, { label: topic.name, identity_basis: 'returned_cha_list_cid' });
          addEdge(id, topicId, 'topic_member', location);
        }
        for (const match of video.title.matchAll(/#([^#\s]+)/gu)) {
          const label = match[1];
          const tag = identity('tag', 'text:' + digest(label));
          const location = { ...evidence, locator: evidence.locator + '/title' };
          addNode(tag, location, {
            label,
            identity_basis: 'observed_caption_hashtag_not_native_topic',
            span_utf16: [match.index, match.index + match[0].length],
          });
          addEdge(id, tag, 'tag_member', location);
          addRequest({
            kind: 'search',
            method: 'POST',
            path: '/api/search',
            body: { query: label, limit: 8, maxScrolls: 0 },
            input_layer: 'rule_seed',
            reason: 'caption_hashtag_rule_expansion',
          });
        }
        addRequest({
          kind: 'detail',
          method: 'POST',
          path: '/api/search',
          body: { query: video.url, limit: 1, maxScrolls: 0 },
          video_id: video.id,
          reason: 'discovered_video_detail',
        });
        if (/是什么梗|梗的由来|梗来源|梗科普|梗解释|meme explained/iu.test(video.title))
          addRequest({
            kind: 'media_descriptor',
            method: 'GET',
            path: '/api/jobs/{completed_resolve_job_id}/source-media',
            video_id: video.id,
            reason: 'explainer_title_rule_candidate_not_semantic_confirmation',
          });
      }
    } else throw new Error('Unsupported discovery job type');
    state.processed.push(evidenceSha);
  }
  // A stored frontier is a handoff, never an instruction to bypass a current pause.
  if (blocked) for (const request of Object.values(state.requests)) request.state = 'blocked_verification';
  return {
    nodes,
    edges,
    frontier,
    queries,
    rawPages,
    state,
    capabilities,
    summary: {
      schema_version: 'platform-collection-v1',
      status: blocked ? 'blocked_verification' : job.status === 'completed' ? 'partial' : 'failed',
      reason: blocked
        ? 'persistent_verification_pause_requires_operator'
        : job.status === 'completed'
          ? 'bounded_evidence_export_not_platform_exhaustion'
          : (job.error ?? job.status),
      nodes: nodes.length,
      edges: edges.length,
      frontier: frontier.length,
      media_downloads: 0,
      platform_requests: 0,
      cursor: {
        kind: 'local_evidence_checkpoint',
        processed_evidence: state.processed.length,
        native_platform_cursor: null,
      },
      live_access_verified: false,
    },
  };
}
