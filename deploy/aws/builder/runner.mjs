// The builder MicroVM's runner (deploy/aws/builder). Lifecycle hooks on :9000:
//   /ready     the image is ready to snapshot
//   /validate  warm the snapshot (warm.sh), so Lambda prefetches what a build uses
//   /run       start run.sh with the payload from the trigger; when it exits,
//              terminate this MicroVM
// Status on :8080. Everything goes to stdout, which Lambda ships to CloudWatch.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from '@aws-sdk/client-lambda-microvms';

const P = '/aws/lambda-microvms/runtime/v1';
const state = { warm: 'no', build: null, exit: null };

const body = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });

function warm() {
  if (state.warm !== 'no') return;
  state.warm = 'running';
  const t = Date.now();
  const child = spawn('bash', ['/opt/builder/warm.sh'], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('exit', (code) => { state.warm = 'done'; console.log(`[runner] warm exit ${code} in ${Date.now() - t} ms`); });
}

async function terminate(id, region) {
  if (!id || process.env.BUILDER_KEEP_ALIVE) return;
  try {
    await new LambdaMicrovmsClient({ region }).send(new TerminateMicrovmCommand({ microvmIdentifier: id }));
  } catch (e) { console.log(`[runner] could not terminate ${id}: ${e.name}: ${e.message}`); }
}

function build(payload) {
  if (state.build) return;
  let p = {};
  try { p = JSON.parse(payload || '{}'); } catch { console.log('[runner] payload is not JSON'); }
  // The trigger's runHookPayload may arrive nested, as an object or a string.
  let inner = p.runHookPayload ?? p.payload;
  if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { inner = undefined; } }
  if (inner && typeof inner === 'object') p = { ...inner, ...p };
  const region = p.region || process.env.AWS_REGION || 'us-east-2';
  state.build = { commit: p.commit, started: new Date().toISOString() };
  console.log(`[runner] build ${p.commit} release=${p.release === true} microvm=${p.microvmId}`);
  const env = {
    ...process.env, COMMIT: String(p.commit || ''), RELEASE: p.release === true ? 'true' : 'false',
    MICROVM_ID: String(p.microvmId || ''), REPO_URL: String(p.repoUrl || ''), BRANCH: String(p.branch || 'main'),
    ARTIFACT_BUCKET: String(p.artifactBucket || ''), SIGNING_KEY_ARN: String(p.signingKeyArn || ''),
    DEPLOY_DOCUMENT: String(p.deployDocument || ''), DEPLOY_TAG_VALUE: String(p.deployTagValue || 'dev'),
    AWS_REGION: region,
  };
  const child = spawn('bash', ['/opt/builder/run.sh'], { stdio: ['ignore', 'inherit', 'inherit'], env });
  child.on('exit', async (code) => {
    state.exit = code;
    console.log(`[runner] run.sh exited ${code}; terminating`);
    await terminate(p.microvmId, region);
  });
}

http.createServer(async (req, res) => {
  const payload = await body(req);
  if (req.url === `${P}/validate`) {
    warm();
    res.writeHead(state.warm === 'done' ? 200 : 503).end();
    return;
  }
  if (req.url === `${P}/run`) build(payload);
  res.writeHead(200).end();
}).listen(9000, '0.0.0.0');

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
}).listen(8080, '0.0.0.0');

console.log('[runner] listening');
