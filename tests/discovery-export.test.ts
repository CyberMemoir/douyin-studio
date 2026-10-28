import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryExport, digest } from '../server/discovery-export.js';
import { normalizeVideo } from '../server/normalize.js';
import type { Job } from '../shared/types.js';

function job(seed: string, title = '普通视频 #日常'): Job {
  return {
    id: seed,
    type: 'search',
    status: 'completed',
    title: seed,
    createdAt: '2026-10-28T00:00:00Z',
    updatedAt: '2026-10-28T00:00:01Z',
    progress: 100,
    phase: 'done',
    logs: [],
    result: {
      videos: [
        {
          id: '1234567890123456789',
          url: 'https://www.douyin.com/video/1234567890123456789',
          title,
          author: 'fixture',
          authorId: '987654321',
          topics: [{ id: '123', name: '日常' }],
          cover: '',
          source: 'network',
          duration: 5,
          likes: 0,
          comments: null,
          createdAt: null,
          searchContext: {
            requestedQuery: seed,
            responseKeyword: seed,
            keywordMatches: true,
            observedAt: '2026-10-28T00:00:01Z',
            responsePath: 'https://www.douyin.com/aweme/v1/web/search/item/',
            pagePath: 'https://www.douyin.com/search/fixture',
          },
        },
      ],
    },
  };
}

test('metadata normalization retains exact public author/topic identities and rejects lossy numeric IDs', () => {
  const video = normalizeVideo({
    aweme_id: '1234567890123456789',
    desc: 'fixture',
    author: { uid: '9999999999999999999' },
    cha_list: [{ cid: '123', cha_name: '话题' }],
  })!;
  assert.equal(video.authorId, '9999999999999999999');
  assert.deepEqual(video.topics, [{ id: '123', name: '话题' }]);
  assert.equal(
    normalizeVideo({ aweme_id: video.id, desc: 'fixture', author: { uid: 9999999999999999999 } })!.authorId,
    null,
  );
});

test('restart replay deduplicates nodes/frontier while retaining two real search paths', () => {
  const first = discoveryExport(job('one'), digest('first'), { seed: 'one', commit: 'fixture' });
  assert.equal(first.edges.filter((row) => row.relation === 'search_result').length, 1);
  assert(first.edges.some((row) => row.relation === 'author_post'));
  assert(first.edges.some((row) => row.relation === 'topic_member'));
  assert(first.edges.some((row) => row.relation === 'tag_member'));
  assert(!first.frontier.some((row) => row.kind === 'media_descriptor'));
  const restored = JSON.parse(JSON.stringify(first.state));
  const replay = discoveryExport(job('one'), digest('first'), { seed: 'one', commit: 'fixture' }, restored);
  assert.equal(replay.nodes.length + replay.edges.length + replay.frontier.length, 0);
  const second = discoveryExport(job('two'), digest('second'), { seed: 'two', commit: 'fixture' }, restored);
  assert.equal(Object.values(second.state.nodes).filter((row) => row.entity_type === 'video').length, 1);
  assert.equal(Object.values(second.state.edges).filter((row) => row.relation === 'search_result').length, 2);
  assert(!second.frontier.some((row) => row.kind === 'detail'));
  assert(!second.edges.some((row) => row.relation === 'recommended_after'));
});

test('only rule-marked explainers stage a descriptor recipe; current pause blocks all recipes', () => {
  const report = discoveryExport(job('seed', '这是什么梗 #梗科普'), digest('explainer'), {
    seed: 'seed',
    commit: 'fixture',
    paused: true,
  });
  assert(report.frontier.some((row) => row.kind === 'media_descriptor'));
  assert(report.frontier.every((row) => row.state === 'blocked_verification'));
  assert.equal(report.summary.media_downloads, 0);
  assert(report.capabilities.find((row) => row.name === 'search')?.status === 'blocked');
  assert(report.capabilities.find((row) => row.name === 'related_videos')?.status === 'unsupported');
});

test('source identity and seed mismatches fail instead of silently inventing graph edges', () => {
  assert.throws(
    () => discoveryExport(job('actual'), digest('one'), { seed: 'wrong', commit: 'fixture' }),
    /matching/,
  );
  const mismatch = job('actual');
  mismatch.result!.videos![0].url = 'https://www.douyin.com/video/2234567890123456789';
  assert.throws(() => discoveryExport(mismatch, digest('two'), { commit: 'fixture' }), /identity/);
});

test('comments preserve original speech and byte-bound JSON locator, without material naming', () => {
  const body = JSON.stringify({ comments: [{ text: '咕咕嘎嘎' }] }),
    sha = digest(body);
  const record = job('comments');
  record.type = 'comments';
  record.result = {
    commentCollection: {
      videoId: '1234567890123456789',
      coverage: 'bounded_top_level_comments',
      endReason: 'limit',
      pages: [
        {
          videoId: '1234567890123456789',
          rawBody: body,
          bodySha256: sha,
          observedAt: '2026-10-28T00:00:01Z',
          comments: [],
          hasMore: true,
          cursor: 20,
        },
      ],
      comments: [
        {
          id: '1',
          videoId: '1234567890123456789',
          text: '咕咕嘎嘎',
          authorId: null,
          likes: null,
          createdAt: null,
          observedAt: '2026-10-28T00:00:01Z',
          bodySha256: sha,
          locator: '/comments/0/text',
          isActualSearchLog: false,
        },
      ],
    },
  };
  const result = discoveryExport(record, digest('comment-job'), { commit: 'fixture' });
  assert.equal(result.queries.length, 1);
  assert.equal(result.edges.length, 0);
  assert.equal(result.rawPages[0].sha256, sha);
  record.result.commentCollection!.comments[0].text = 'renamed';
  assert.throws(() => discoveryExport(record, digest('invalid'), { commit: 'fixture' }), /mismatch/);
});
