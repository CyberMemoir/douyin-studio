import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPayload, normalizeVideo } from '../server/normalize.js';
import { publicVideo } from '../shared/types.js';

export const fixture = {
  aweme_id: '1234567890123456789',
  desc: '测试视频',
  author: { nickname: '测试作者' },
  video: {
    duration: 81000,
    cover: { url_list: ['https://p3.douyinpic.com/cover.jpeg'] },
    play_addr: { url_list: ['https://v3.douyinvod.com/video.mp4', 'https://evil.test/tracker'] },
  },
  statistics: { digg_count: 12, comment_count: 0 },
  create_time: 1770000000,
};
test('normalizes metadata and retains only platform media', () => {
  const video = normalizeVideo(fixture)!;
  assert.equal(video.duration, 81);
  assert.equal(video.author, '测试作者');
  assert.equal(video.comments, 0);
  assert.deepEqual(video.mediaUrls, ['https://v3.douyinvod.com/video.mp4']);
  assert(!('mediaUrls' in publicVideo(video)));
});
test('handles nested API responses, de-duplicates video and ranks trends', () => {
  const result = extractPayload({
    data: [{ aweme_info: fixture }, { aweme_info: fixture }],
    word_list: [
      { word: '第二热点', position: 2, hot_value: '123' },
      { word: '第一热点', position: 1, hot_value: 456 },
    ],
  });
  assert.equal(result.videos.length, 1);
  assert.equal(result.trends[0].word, '第一热点');
  assert.equal(result.trends[1].heat, 123);
});
test('does not manufacture missing metrics or videos', () => {
  assert.equal(normalizeVideo({ aweme_id: 'bad', desc: 'oops' }), null);
  const video = normalizeVideo({ aweme_id: '1234567890123456789', desc: '视频' })!;
  assert.equal(video.likes, null);
  assert.equal(video.createdAt, null);
  assert.deepEqual(extractPayload({ status_code: 0 }), { videos: [], trends: [] });
});
test('pinned hot-list entries keep rank zero instead of duplicating rank one', () => {
  const result = extractPayload({
    word_list: [
      { word: '置顶', position: 0, hot_value: 0 },
      { word: '第一', position: 1, hot_value: 10 },
    ],
  });
  assert.deepEqual(
    result.trends.map((t) => t.rank),
    [0, 1],
  );
});
