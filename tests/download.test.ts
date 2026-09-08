import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mp4Validator } from '../server/download.js';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from('ftypisom'), Buffer.alloc(20)]);
test('MP4 validation handles split headers and reports actual bytes', async () => {
  let bytes = 0;
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([mp4.subarray(0, 4), mp4.subarray(4, 8), mp4.subarray(8)]),
    mp4Validator((n) => {
      bytes = n;
    }),
    new Writable({
      write(chunk, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  assert.equal(bytes, mp4.length);
  assert.deepEqual(Buffer.concat(chunks), mp4);
});
test('HTML errors, empty files and oversized transfers cannot become videos', async () => {
  for (const content of [Buffer.from('<html>access denied</html>'), Buffer.from('')])
    await assert.rejects(
      pipeline(
        Readable.from([content]),
        mp4Validator(() => {}),
        new Writable({
          write(_c, _e, cb) {
            cb();
          },
        }),
      ),
    );
  await assert.rejects(
    pipeline(
      Readable.from([mp4]),
      mp4Validator(() => {}, 10),
      new Writable({
        write(_c, _e, cb) {
          cb();
        },
      }),
    ),
    /大小上限/,
  );
});
