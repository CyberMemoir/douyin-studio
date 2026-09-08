import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVideoInput,
  mediaUrl,
  safeFileName,
  localFile,
  localCdpUrl,
  searchSchema,
} from '../server/validation.js';

test('recognizes keyword, full links, numeric IDs and copied share text', () => {
  assert.equal(parseVideoInput('AI 工具'), null);
  assert.equal(parseVideoInput('7581705595816791302'), 'https://www.douyin.com/video/7581705595816791302');
  assert.equal(
    parseVideoInput('看看这个视频 https://v.douyin.com/abcdEFG/ 复制此链接'),
    'https://v.douyin.com/abcdEFG/',
  );
  assert.equal(
    parseVideoInput('https://www.douyin.com/?modal_id=7581705595816791302'),
    'https://www.douyin.com/video/7581705595816791302',
  );
  assert.equal(
    parseVideoInput('https://www.iesdouyin.com/share/video/7581705595816791302/?x=1'),
    'https://www.douyin.com/video/7581705595816791302',
  );
});
test('rejects unsupported URLs, credentials, misleading domains and invalid IDs', () => {
  for (const value of [
    'https://localhost/video/7581705595816791302',
    'https://www.douyin.com.evil.test/video/7581705595816791302',
    'https://x@www.douyin.com/video/7581705595816791302',
    'https://www.douyin.com:8888/video/7581705595816791302',
    'https://www.douyin.com/video/abc',
  ])
    assert.throws(() => parseVideoInput(value));
  assert.throws(() => searchSchema.parse({ query: '', limit: 100 }));
});
test('media egress has strict HTTPS and host allowlist', () => {
  assert.equal(mediaUrl('https://v3-web.douyinvod.com/path/video.mp4').hostname, 'v3-web.douyinvod.com');
  for (const url of [
    'http://v3-web.douyinvod.com/a',
    'https://douyinvod.com.evil.test/a',
    'https://127.0.0.1/a',
    'https://v3-web.douyinvod.com:444/a',
    'https://x@v3-web.douyinvod.com/a',
    'file:///etc/passwd',
  ])
    assert.throws(() => mediaUrl(url));
});
test('file paths cannot escape the download directory', () => {
  const name = safeFileName('../恶意/标题\\\n:test\u202e', '1234-abc');
  assert(!/[\\/\n\u202e:]/.test(name));
  assert(!name.startsWith('.'));
  assert(name.endsWith('_1234-abc.mp4'));
  assert.equal(localFile('/tmp/downloads', name), `/tmp/downloads/${name}`);
  for (const unsafe of ['../x.mp4', '/etc/a.mp4', '.hidden.mp4', 'x.txt'])
    assert.throws(() => localFile('/tmp/downloads', unsafe));
});
test('CDP target must be a local origin', () => {
  assert.equal(localCdpUrl('http://127.0.0.1:9421'), 'http://127.0.0.1:9421');
  for (const value of [
    'https://remote.test:9421',
    'http://user@localhost:9421',
    'http://localhost:9421/path',
    'http://localhost:9421/?x=1',
  ])
    assert.throws(() => localCdpUrl(value));
});
