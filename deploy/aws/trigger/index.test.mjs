// The build trigger's routing and signature check (deploy/aws/trigger/index.mjs).
import crypto from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { route, verifySignature } from './index.mjs';

const SECRET = 'synthetic-test-secret';
const SHA = 'a'.repeat(40);
Object.assign(process.env, {
  REPO_FULL_NAME: 'jssmith/shfs', REPO_URL: 'https://github.com/jssmith/shfs', BRANCH: 'main',
  BUILDER_IMAGE_ARN: 'arn:aws:lambda:us-east-2:111122223333:microvm-image:builder', BUILDER_IMAGE_VERSION: '1.0',
  BUILDER_ROLE_ARN: 'arn:aws:iam::111122223333:role/builder', BUILDER_LOG_GROUP: '/aws/lambda-microvms/builder',
  ARTIFACT_BUCKET: 'bucket', SIGNING_KEY_ARN: 'key', DEPLOY_DOCUMENT: 'AgentDrive-Deploy', DEPLOY_TAG_VALUE: 'dev',
});

function deps(running = []) {
  const runs = [];
  return { runs, secret: async () => SECRET, list: async () => running, run: async (input) => { runs.push(input); return { microvmId: 'microvm-1' }; } };
}
function hook(body, { event = 'push', secret = SECRET, sig } = {}) {
  const raw = JSON.stringify(body);
  const signature = sig ?? 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return { requestContext: { http: { method: 'POST' } }, headers: { 'X-Hub-Signature-256': signature, 'X-GitHub-Event': event }, body: raw, isBase64Encoded: false };
}
const push = (over = {}) => ({ ref: 'refs/heads/main', after: SHA, deleted: false, repository: { full_name: 'jssmith/shfs' }, ...over });

describe('build trigger', () => {
  let d;
  beforeEach(() => { d = deps(); });

  test('a signed push to main starts one release build with only the sha from the event', async () => {
    const r = await route(hook(push()), d);
    expect(r.statusCode).toBe(201);
    expect(d.runs).toHaveLength(1);
    const payload = JSON.parse(d.runs[0].runHookPayload);
    expect(payload).toMatchObject({ commit: SHA, release: true, repoUrl: 'https://github.com/jssmith/shfs', branch: 'main' });
    expect(d.runs[0].maximumDurationInSeconds).toBe(3600);
  });

  test('a bad or missing signature starts nothing', async () => {
    expect((await route(hook(push(), { secret: 'wrong' }), d)).statusCode).toBe(401);
    expect((await route(hook(push(), { sig: '' }), d)).statusCode).toBe(401);
    expect(d.runs).toHaveLength(0);
  });

  test('other refs, repositories, deletes and events start nothing', async () => {
    for (const ev of [hook(push({ ref: 'refs/heads/feature' })), hook(push({ repository: { full_name: 'someone/fork' } })),
      hook(push({ deleted: true })), hook(push(), { event: 'pull_request' })]) {
      expect((await route(ev, d)).statusCode).toBe(202);
    }
    expect((await route(hook({}, { event: 'ping' }), d)).statusCode).toBe(200);
    expect(d.runs).toHaveLength(0);
  });

  test('while a build runs, a push starts no second one', async () => {
    d = deps([{ microvmId: 'microvm-0', imageArn: process.env.BUILDER_IMAGE_ARN, state: 'RUNNING' }]);
    expect((await route(hook(push()), d)).statusCode).toBe(202);
    expect(d.runs).toHaveLength(0);
  });

  test('a direct invoke builds a given sha, a test build unless release is asked', async () => {
    expect((await route({ commit: 'nope' }, d)).statusCode).toBe(400);
    expect((await route({ commit: SHA }, d)).statusCode).toBe(201);
    expect(JSON.parse(d.runs[0].runHookPayload).release).toBe(false);
  });

  test('signature check is exact', async () => {
    const raw = Buffer.from('{}');
    const good = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    expect(await verifySignature(raw, good, SECRET)).toBe(true);
    expect(await verifySignature(raw, good.slice(0, -1) + '0', SECRET)).toBe(good.endsWith('0') ? true : false);
    expect(await verifySignature(raw, 'sha1=abc', SECRET)).toBe(false);
  });
});
