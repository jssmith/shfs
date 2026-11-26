// Build trigger (deploy/aws/trigger). Two ways in:
//   - GitHub's push webhook, through the function URL: the signature
//     (X-Hub-Signature-256, HMAC-SHA256 with the secret in Secrets Manager) must
//     verify; only pushes to the branch of the one repository start a build.
//   - A direct invoke (IAM-authenticated): {"commit": "<sha>", "release": false}
//     builds any commit, released only if it is on the branch (run.sh checks).
// It starts one builder MicroVM, unless one is already building: that builder
// checks the branch head before it stops and builds it if it moved (run.sh).
// The builder trusts nothing here but the commit sha: it clones the public
// repository itself and verifies the commit is on the branch before releasing.
import crypto from 'node:crypto';

const env = process.env;
let secret;

const reply = (statusCode, message, extra = {}) => {
  console.log(JSON.stringify({ statusCode, message, ...extra }));
  return { statusCode, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, ...extra }) };
};

export async function verifySignature(raw, header, key) {
  if (!header || !header.startsWith('sha256=')) return false;
  const want = Buffer.from('sha256=' + crypto.createHmac('sha256', key).update(raw).digest('hex'));
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// The AWS calls, loaded only when the function runs for real, so the routing
// below can be tested without the SDK (index.test.mjs).
async function awsDeps() {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { LambdaMicrovmsClient, RunMicrovmCommand, ListMicrovmsCommand } = await import('@aws-sdk/client-lambda-microvms');
  const microvms = new LambdaMicrovmsClient({});
  const secrets = new SecretsManagerClient({});
  return {
    secret: async () => {
      if (!secret) secret = (await secrets.send(new GetSecretValueCommand({ SecretId: env.WEBHOOK_SECRET_ARN }))).SecretString;
      return secret;
    },
    list: async () => { const out = await microvms.send(new ListMicrovmsCommand({})); return out.items ?? out.microvms ?? []; },
    run: async (input) => microvms.send(new RunMicrovmCommand(input)),
  };
}

async function start(deps, commit, release) {
  const imageArn = env.BUILDER_IMAGE_ARN;
  const running = (await deps.list()).find((v) => (v.imageArn ?? imageArn) === imageArn && ['PENDING', 'RUNNING', 'STARTING'].includes(v.state));
  if (running) return reply(202, 'a build is running; it builds the new head of the branch before it stops', { microvm: running.microvmId });
  const payload = {
    commit, release, repoUrl: env.REPO_URL, branch: env.BRANCH, region: env.AWS_REGION,
    artifactBucket: env.ARTIFACT_BUCKET, signingKeyArn: env.SIGNING_KEY_ARN,
    deployDocument: env.DEPLOY_DOCUMENT, deployTagValue: env.DEPLOY_TAG_VALUE,
  };
  const out = await deps.run({
    imageIdentifier: env.BUILDER_IMAGE_ARN, imageVersion: env.BUILDER_IMAGE_VERSION,
    executionRoleArn: env.BUILDER_ROLE_ARN,
    idlePolicy: { maxIdleDurationSeconds: 3600, suspendedDurationSeconds: 60, autoResumeEnabled: false },
    maximumDurationInSeconds: Number(env.BUILD_MAX_SECONDS || 3600),
    logging: { cloudWatch: { logGroup: env.BUILDER_LOG_GROUP } },
    runHookPayload: JSON.stringify(payload),
  });
  return reply(201, 'build started', { commit, release, microvm: out.microvmId });
}

export async function route(event, deps) {
  // A direct invoke, by someone with lambda:InvokeFunction.
  if (!event.requestContext?.http) {
    const commit = String(event.commit ?? '');
    if (!/^[0-9a-f]{40}$/.test(commit)) return reply(400, 'commit must be a 40-character sha');
    return start(deps, commit, event.release === true);
  }
  const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64') : Buffer.from(event.body ?? '', 'utf8');
  if (!(await verifySignature(raw, headers['x-hub-signature-256'], await deps.secret()))) return reply(401, 'bad signature');
  const kind = headers['x-github-event'];
  if (kind === 'ping') return reply(200, 'pong');
  if (kind !== 'push') return reply(202, `ignored event ${kind}`);
  let push;
  try { push = JSON.parse(raw.toString('utf8')); } catch { return reply(400, 'body is not JSON'); }
  if (push.repository?.full_name !== env.REPO_FULL_NAME) return reply(202, `ignored repository ${push.repository?.full_name}`);
  if (push.ref !== `refs/heads/${env.BRANCH}` || push.deleted) return reply(202, `ignored ref ${push.ref}`);
  if (!/^[0-9a-f]{40}$/.test(push.after ?? '')) return reply(400, 'no head commit');
  return start(deps, push.after, true);
}

export const handler = async (event) => route(event, await awsDeps());
