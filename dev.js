require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const enabled = /^(?:1|true|yes|on)$/i.test(
  String(
    process.env.logging_to_file ??
    process.env.LOGGING_TO_FILE ??
    'true'
  )
);

const sessionId =
  'dev-' +
  Date.now() +
  '-' +
  crypto.randomBytes(4).toString('hex');

process.env.logging_to_file =
  enabled ? 'true' : 'false';

process.env.SIFRA_SESSION_ID =
  sessionId;

if (enabled) {
  const file =
    path.join(__dirname, 'context.md');

  fs.closeSync(
    fs.openSync(file, 'a')
  );

  fs.appendFileSync(
    file,
    '\n\n---\n\n' +
    '# Sifra Session\n\n' +
    '- started: ' +
    new Date().toISOString() +
    '\n' +
    '- mode: npm run dev\n' +
    '- session: ' +
    sessionId +
    '\n\n',
    'utf8'
  );

  console.log(
    'Live AI token logging -> context.md'
  );
}

const child =
  spawn(
    process.execPath,
    ['--watch', 'server.js'],
    {
      cwd: __dirname,
      stdio: 'inherit',
      env: process.env
    }
  );

let stopping = false;

function stop(signal) {
  if (stopping) return;
  stopping = true;

  if (
    child &&
    !child.killed
  ) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => {
  stop('SIGINT');
});

process.on('SIGTERM', () => {
  stop('SIGTERM');
});

child.on('exit', (code, signal) => {
  if (signal && !stopping) {
    console.error(
      'Dev server stopped by ' + signal
    );
  }

  process.exit(
    Number.isInteger(code)
      ? code
      : 0
  );
});
