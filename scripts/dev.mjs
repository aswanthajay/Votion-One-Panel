import { spawn } from 'node:child_process';
import process from 'node:process';

const bin = name => process.platform === 'win32'
  ? `.\\node_modules\\.bin\\${name}.cmd`
  : `node_modules/.bin/${name}`;

const children = [
  spawn(bin('tsx'), ['server/index.ts'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  }),
  spawn(bin('vite'), ['--host', '0.0.0.0'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  }),
];

let shuttingDown = false;

const shutdown = code => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 250);
};

for (const child of children) {
  child.on('error', error => {
    console.error(`[DEV] Unable to start process: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code !== 0 || signal)) {
      console.error(`[DEV] A development process stopped (code=${code ?? 'none'}, signal=${signal ?? 'none'}).`);
      shutdown(code || 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[DEV] Vite frontend and Express backend are running together.');
console.log('[DEV] Frontend: http://localhost:3000 | API: http://localhost:5000/api/v1/health');
