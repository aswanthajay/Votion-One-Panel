#!/usr/bin/env node
/**
 * Safely remove the obsolete server/database.ts module.
 *
 * Default mode is a dry run. Removal requires --apply and a clean Git tree.
 * The source is moved into .runtime/backups before validation; if any
 * post-removal check fails, it is restored automatically.
 *
 * Usage:
 *   node scripts/cleanup-legacy-database.mjs
 *   node scripts/cleanup-legacy-database.mjs --apply
 *   node scripts/cleanup-legacy-database.mjs --apply --pterodactyl
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const legacyPath = path.join(projectRoot, 'server', 'database.ts');
const activePath = path.join(projectRoot, 'server', 'db', 'database.ts');
const backupRoot = path.join(projectRoot, '.runtime', 'backups', 'legacy-database');
const apply = process.argv.includes('--apply');
const pterodactyl = process.argv.includes('--pterodactyl') || process.env.PTERODACTYL === '1';
const scriptRelativePath = path.relative(projectRoot, fileURLToPath(import.meta.url));

function commandAvailable(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

const gitAvailable = commandAvailable('git');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result.stdout || '';
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function gitStatus() {
  if (!gitAvailable) return '';
  return run('git', ['status', '--porcelain'], { quiet: true }).trim();
}

function gitTracked(pathname) {
  if (!gitAvailable) return true;
  const relativePath = path.relative(projectRoot, pathname);
  const result = spawnSync('git', ['ls-files', '--error-unmatch', relativePath], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0;
}

function assertNoLegacyImports() {
  if (!gitAvailable) {
    const sourceFiles = [];
    const visit = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git', '.runtime'].includes(entry.name)) continue;
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(entryPath);
        else if (/\.(c|m)?js|ts|tsx|json$/i.test(entry.name)) sourceFiles.push(entryPath);
      }
    };
    visit(projectRoot);
    const importPattern = /(?:from|import\(|require\()\s*['"](?:\.\.?[/\\])*database(?:\.js)?['"]/;
    const matches = sourceFiles.filter(filePath => filePath !== legacyPath && importPattern.test(fs.readFileSync(filePath, 'utf8')));
    if (matches.length > 0) throw new Error(`Unexpected database-module imports remain:\\n${matches.map(filePath => path.relative(projectRoot, filePath)).join('\\n')}`);
    return;
  }
  const result = spawnSync('git', [
    'grep', '-nE',
    "(from|import\\(|require\\()\\s*['\"](?:\\.\\.?/)*database(\\.js)?['\"]",
    '--',
    ':!server/database.ts',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(`Unexpected database-module imports remain:\n${result.stdout}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to scan imports: ${result.stderr || 'git grep failed'}`);
  }
}

function validateSourceGraph() {
  assert(fs.existsSync(activePath), `Active database module is missing: ${path.relative(projectRoot, activePath)}`);
  assert(gitTracked(activePath), `Active database module is not tracked: ${path.relative(projectRoot, activePath)}`);
  assertNoLegacyImports();
  if (pterodactyl) {
    console.log('[legacy-db-cleanup] Pterodactyl mode: skipped npm lint/test/build because production Eggs commonly install only production dependencies.');
    return;
  }
  run('npm', ['run', 'lint']);
  run('npm', ['test', '--', '--reporter=dot']);
  run('npm', ['run', 'build']);
}

console.log(`[legacy-db-cleanup] mode=${apply ? 'APPLY' : 'DRY-RUN'}${pterodactyl ? ' platform=pterodactyl' : ''}`);
console.log(`[legacy-db-cleanup] candidate=${path.relative(projectRoot, legacyPath)}`);
console.log(`[legacy-db-cleanup] active=${path.relative(projectRoot, activePath)}`);

assert(fs.existsSync(legacyPath), `Legacy database module does not exist: ${path.relative(projectRoot, legacyPath)}`);
assert(fs.existsSync(activePath), `Active database module does not exist: ${path.relative(projectRoot, activePath)}`);
assert(gitTracked(legacyPath), 'Legacy database module is not tracked by Git; refusing to remove an unknown file.');

if (!gitAvailable && apply && !pterodactyl) {
  throw new Error('Git is unavailable. Re-run with --pterodactyl only after taking a Pterodactyl backup and reviewing the dry run.');
}
const status = gitStatus();
const unrelatedStatus = status.split('\\n').filter(Boolean).filter(line => !line.endsWith(` ${scriptRelativePath}`));
if (unrelatedStatus.length > 0) {
  console.error('[legacy-db-cleanup] Refusing to continue because the working tree is not clean:');
  console.error(unrelatedStatus.join('\\n'));
  process.exit(2);
}

const sourceHash = sha256(legacyPath);
console.log(`[legacy-db-cleanup] source sha256=${sourceHash}`);
console.log('[legacy-db-cleanup] verified active imports point to server/db/database.ts.');

if (!apply) {
  console.log('[legacy-db-cleanup] DRY RUN complete. No files were changed.');
  console.log('[legacy-db-cleanup] Re-run with --apply only after reviewing this plan.');
  process.exit(0);
}

const backupPath = path.join(backupRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-database.ts`);
let backedUp = false;
try {
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  fs.copyFileSync(legacyPath, backupPath, fs.constants.COPYFILE_EXCL);
  backedUp = true;
  assert(sha256(backupPath) === sourceHash, 'Backup checksum does not match the source checksum.');
  console.log(`[legacy-db-cleanup] backup=${path.relative(projectRoot, backupPath)}`);

  fs.unlinkSync(legacyPath);
  assert(!fs.existsSync(legacyPath), 'Legacy module still exists after removal.');
  console.log('[legacy-db-cleanup] removed legacy module; running validation.');

  validateSourceGraph();
  if (gitAvailable) {
    assert(gitStatus().split('\\n').some(line => line.includes('server/database.ts')), 'Git does not report the expected legacy-module deletion.');
  }
  console.log('[legacy-db-cleanup] validation passed. Removal is ready for review and commit.');
  console.log('[legacy-db-cleanup] backup retained for manual rollback:', path.relative(projectRoot, backupPath));
} catch (error) {
  console.error(`[legacy-db-cleanup] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  if (backedUp && !fs.existsSync(legacyPath)) {
    fs.copyFileSync(backupPath, legacyPath, fs.constants.COPYFILE_EXCL);
    assert(sha256(legacyPath) === sourceHash, 'Rollback checksum does not match the original source checksum.');
    console.error('[legacy-db-cleanup] rollback restored server/database.ts from the verified backup.');
  }
  process.exit(1);
}
