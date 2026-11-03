import test from 'node:test';
import legacyAssets from './legacy-install.test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
function sandbox(fn) {
  const folder = mkdtempSync(join(root, '.test-install-'));
  try {
    for (const sub of ['app', 'tmp', 'mock']) mkdirSync(join(folder, sub));
    writeFileSync(join(folder, 'mock', 'go'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf "#!/bin/sh\\nexit 0\\n" > "$1"; exit 0; fi; shift; done\n');
    writeFileSync(join(folder, 'mock', 'rsync'), '#!/bin/sh\nexit 0\n');
    for (const name of ['go', 'rsync']) chmodSync(join(folder, 'mock', name), 0o755);
    const keys = join(folder, 'app', 'keys.json');
    const run = (args = []) => spawnSync('/bin/bash', [join(root, 'scripts', 'install.sh'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: folder, HERDR_APP_HOME: join(folder, 'app'),
        TMPDIR: join(folder, 'tmp'), PATH: `${join(folder, 'mock')}:${process.env.PATH}` },
    });
    fn({ folder, keys, run });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
test('installer backs up keys and adds only missing bindings, idempotently', () => sandbox(({ folder, keys, run }) => {
  const original = '{"global":{"ctrl-x":"app.help"},"terminal":{"ctrl-a":"home"}}\n';
  writeFileSync(keys, original, { mode: 0o640 });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(readFileSync(keys, 'utf8'));
  assert.deepEqual(data, { global: { 'ctrl-x': 'app.help', 'ctrl-shift-h': 'hub.toggle' }, terminal: { 'ctrl-a': 'home' } });
  const backups = readdirSync(join(folder, 'app')).filter(n => n.startsWith('keys.json.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(folder, 'app', backups[0]), 'utf8'), original);
  assert.equal(statSync(keys).mode & 0o777, 0o640);
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readdirSync(join(folder, 'app')).filter(n => n.startsWith('keys.json.bak-')).length, 1);
}));
test('installer preserves an existing shortcut and dry-run makes no writes', () => sandbox(({ folder, keys, run }) => {
  const original = '{"global":{"ctrl-shift-h":"app.help"}}';
  writeFileSync(keys, original);
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(keys, 'utf8'), original);
  assert.deepEqual(readdirSync(join(folder, 'app')), ['keys.json']);
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(keys, 'utf8'), original);
}));
test('empty-home dry-run previews the key and malformed configs fail before installs', () => sandbox(({ folder, keys, run }) => {
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Merge missing keys: global:ctrl-shift-h/);
  assert.deepEqual(readdirSync(join(folder, 'app')), []);
  writeFileSync(keys, '{"global":[]}');
  result = run(); assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(join(folder, 'app')), ['keys.json']);
}));
test('installer rejects a symlink key file before writing', () => sandbox(({ folder, keys, run }) => {
  const other = join(folder, 'other.json'); writeFileSync(other, '{}'); symlinkSync(other, keys);
  const result = run(); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing symlink keys.json/);
  assert.equal(readFileSync(other, 'utf8'), '{}');
}));

test('installer migrates only the exact previous hub shortcut and backs it up', () => sandbox(({ folder, keys, run }) => {
  const original = '{"global":{"ctrl-shift-h":"cerberus.toggle","ctrl-a":"app.help"}}';
  writeFileSync(keys, original);
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /migrate cerberus.toggle/);
  assert.equal(readFileSync(keys, 'utf8'), original);
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(keys)).global['ctrl-shift-h'], 'hub.toggle');
  const backup = readdirSync(join(folder, 'app')).find(n => n.startsWith('keys.json.bak-'));
  assert.equal(readFileSync(join(folder, 'app', backup), 'utf8'), original);
}));

function oldInstall(folder, name) {
  const dir = join(folder, 'app', 'mods', name); mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(legacyAssets[name]))
    writeFileSync(join(dir, file), content);
  return dir;
}
test('installer removes only exact legacy installs and previews without deletion', () => sandbox(({ folder, run }) => {
  const clean = oldInstall(folder, 'cerberus');
  const modified = oldInstall(folder, 'cerberus-bar');
  const extra = oldInstall(folder, 'cerberus-cell');
  writeFileSync(join(modified, 'main.js'), '// user customization');
  writeFileSync(join(extra, 'notes.txt'), 'my file');
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Would remove unmodified legacy mod/);
  assert.ok(statSync(clean).isDirectory());
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.ok(!readdirSync(join(folder, 'app', 'mods')).includes('cerberus'));
  assert.equal(readFileSync(join(modified, 'main.js'), 'utf8'), '// user customization');
  assert.equal(readFileSync(join(extra, 'notes.txt'), 'utf8'), 'my file');
}));
test('legacy mod directory symlinks and contained symlinks are preserved', () => sandbox(({ folder, run }) => {
  const outside = join(folder, 'personal'); mkdirSync(outside);
  mkdirSync(join(folder, 'app', 'mods')); symlinkSync(outside, join(folder, 'app', 'mods', 'cerberus'));
  const other = oldInstall(folder, 'cerberus-cell'); symlinkSync(outside, join(other, 'personal'));
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.ok(statSync(join(folder, 'app', 'mods', 'cerberus')).isDirectory());
  assert.ok(statSync(join(other, 'personal')).isDirectory());
}));
