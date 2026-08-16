// Regenerates src-tauri/tests/fixtures/placeholder-mask.json.
//
// The Rust hit test and the frontend mask builder have to agree on bit order,
// row order and coordinate space. Rather than hand-writing a fixture, this
// runs the real `buildHitMask` in a headless browser against the real
// placeholder sprite and stores what comes out — so the Rust test checks the
// actual contract, not a restatement of it.
//
//   node scripts/gen-hitmask-fixture.mjs
//
// Needs a Chromium/Chrome binary; override the lookup with DESKPET_CHROMIUM.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;
const SINK_PORT = 5200;
const OUT = resolve(root, 'src-tauri/tests/fixtures/placeholder-mask.json');

const CANDIDATES = [
  process.env['DESKPET_CHROMIUM'],
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
];

const chromium = CANDIDATES.find((path) => path && existsSync(path));
if (!chromium) {
  console.error('No Chromium found. Set DESKPET_CHROMIUM to a browser binary.');
  process.exit(1);
}

// The page posts its result here; polling the DOM raced with the module's
// async work.
const collected = new Promise((resolveResult, rejectResult) => {
  const sink = createServer((request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      response.writeHead(204).end();
      sink.close();
      if (body.startsWith('ERROR')) rejectResult(new Error(body));
      else resolveResult(body);
    });
  });
  sink.on('error', rejectResult);
  sink.listen(SINK_PORT);
});

const vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  cwd: root,
  stdio: 'ignore',
});

let browser = null;
const shutdown = () => {
  vite.kill('SIGTERM');
  browser?.kill('SIGTERM');
};
process.on('exit', shutdown);

try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const probe = await fetch(`http://localhost:${PORT}/pet-placeholder.png`);
      if (probe.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('vite did not come up');
    await new Promise((wait) => setTimeout(wait, 250));
  }

  browser = spawn(chromium, [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    `http://localhost:${PORT}/scripts/hitmask-fixture.html?sink=${SINK_PORT}`,
  ], { stdio: 'ignore' });

  const mask = JSON.parse(
    await Promise.race([
      collected,
      new Promise((_, rejectTimeout) =>
        setTimeout(() => rejectTimeout(new Error('browser did not report a mask')), 60_000),
      ),
    ]),
  );
  mkdirSync(dirname(OUT), { recursive: true });
  // Keep `bits` on one line: 254 numbers, one per row, would drown the diff.
  const { bits, ...rest } = mask;
  const body = Object.entries(rest)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(',\n');
  writeFileSync(OUT, `{\n${body},\n  "bits": ${JSON.stringify(bits)}\n}\n`);

  // ASCII preview, so a regenerated fixture can be eyeballed in a diff.
  const at = (col, row) => {
    const index = row * mask.cols + col;
    return (mask.bits[index >> 3] & (1 << (index & 7))) !== 0;
  };
  const lines = [];
  for (let row = 0; row < mask.rows; row += 1) {
    let line = '';
    for (let col = 0; col < mask.cols; col += 1) line += at(col, row) ? '#' : '.';
    lines.push(line);
  }
  console.log(`${mask.cols}x${mask.rows} cells, ${mask.bits.length} bytes -> ${OUT}`);
  console.log(lines.join('\n'));
} finally {
  shutdown();
}
