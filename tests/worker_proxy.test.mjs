import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.ts';

for (const pathname of ['/normal?x=1', '//attacker.example/payload', '///attacker.example/payload', '/%2f%2fattacker.example/path']) {
  test('proxy pins configured origin for ' + pathname, async () => {
    const original = globalThis.fetch;
    let destination;
    globalThis.fetch = async (url, init) => {
      destination = new URL(url);
      assert.equal(init.headers.get('X-API-Key'), 'dummy-test-key');
      return new Response('origin response');
    };
    try {
      const response = await worker.fetch(new Request('https://edge.example' + pathname, {headers: {'X-API-Key': 'dummy-test-key'}}), {BACKEND_URL: 'https://origin.example'});
      assert.equal(destination.origin, 'https://origin.example');
      assert.equal(await response.text(), 'origin response');
    } finally { globalThis.fetch = original; }
  });
}

for (const backend of ['ftp://origin.example', 'https://user:password@origin.example', 'https://origin.example/prefix', 'https://origin.example?secret=yes']) {
  test('reject unsafe backend configuration ' + backend, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('must not fetch'); };
    try {
      const response = await worker.fetch(new Request('https://edge.example/'), {BACKEND_URL: backend});
      assert.equal(response.status, 500);
      assert.equal((await response.text()).includes('password'), false);
    } finally { globalThis.fetch = original; }
  });
}

test('missing backend fails closed', async () => {
  assert.equal((await worker.fetch(new Request('https://edge.example/'), {})).status, 503);
});

test('invalid and unreachable backend errors do not reveal secret details', async () => {
  const invalid = await worker.fetch(new Request('https://edge.example/'), {BACKEND_URL: 'bad backend secret-value'});
  assert.equal(invalid.status, 500);
  assert.equal((await invalid.text()).includes('secret-value'), false);
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('secret-value upstream detail'); };
  try {
    const response = await worker.fetch(new Request('https://edge.example/'), {BACKEND_URL: 'https://origin.example'});
    assert.equal(response.status, 502);
    assert.equal((await response.text()).includes('secret-value'), false);
  } finally { globalThis.fetch = original; }
});
