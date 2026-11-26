// Lambda MicroVM spike: lifecycle hooks on :9000, status on :8080.
// The run hook (once per MicroVM, after it starts from the snapshot) starts
// spike.sh; its output goes to stdout, which Lambda ships to CloudWatch.
import http from 'node:http';
import { spawn } from 'node:child_process';

const P = '/aws/lambda-microvms/runtime/v1';
const state = { started: null, exit: null };

function body(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
}

http.createServer(async (req, res) => {
  const payload = await body(req);
  if (req.url === `${P}/run` && !state.started) {
    state.started = new Date().toISOString();
    console.log(`SPIKE run hook at ${state.started} payload ${payload.slice(0, 200)}`);
    const child = spawn('bash', ['/opt/spike/spike.sh'], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code) => { state.exit = code; console.log(`SPIKE spike.sh exited ${code}`); });
  }
  res.writeHead(200).end();
}).listen(9000, '0.0.0.0');

http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
}).listen(8080, '0.0.0.0');

console.log('SPIKE runner listening');
