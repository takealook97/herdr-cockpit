import test from 'node:test';
import legacyAssets, { legacyShortcutDefaults } from './legacy-install.test.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const hubKeys = JSON.parse(readFileSync(new URL('../../keys/hub.json', import.meta.url))).global;
const nexusKeys = { 'cmd-shift-n': 'space-tree.nexus', 'cmd-shift-space': 'space-tree.nexus-listen' };
const root = fileURLToPath(new URL('../../', import.meta.url));
function sandbox(fn) {
  const folder = mkdtempSync(join(root, '.test-install-'));
  try {
    for (const sub of ['app', 'tmp', 'mock']) mkdirSync(join(folder, sub));
    writeFileSync(join(folder, 'mock', 'go'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf "#!/bin/sh\\nexit 0\\n" > "$1"; exit 0; fi; shift; done\n');
    writeFileSync(join(folder, 'mock', 'rsync'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(folder, 'mock', 'swiftc'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "-o" ]; then shift; printf "#!/bin/sh\\nexit 0\\n" > "$1"; exit 0; fi; shift; done\n');
    writeFileSync(join(folder, 'mock', 'codesign'), '#!/bin/sh\nexit 0\n');
    for (const name of ['go', 'rsync', 'swiftc', 'codesign']) chmodSync(join(folder, 'mock', name), 0o755);
    const keys = join(folder, 'app', 'keys.json');
    const run = (args = []) => spawnSync('/bin/bash', [join(root, 'scripts', 'install.sh'), ...args], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: folder, HERDR_APP_HOME: join(folder, 'app'), HERDR_SKIP_LISTEN_PREPARE: '1',
        TMPDIR: join(folder, 'tmp'), PATH: `${join(folder, 'mock')}:${process.env.PATH}` },
    });
    fn({ folder, keys, run });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
test('dry-run reports skipped listen preparation', () => sandbox(({ folder, run }) => {
  writeFileSync(join(folder, 'mock', 'uname'), '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Darwin; else echo arm64; fi\n', { mode: 0o755 });
  const result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skip herdr-listen prepare \(HERDR_SKIP_LISTEN_PREPARE\)/);
  assert.doesNotMatch(result.stdout, /nohup .*herdr-listen/);
}));
test('installer backs up keys and adds only missing bindings, idempotently', () => sandbox(({ folder, keys, run }) => {
  const original = '{"global":{"ctrl-x":"app.help"},"terminal":{"ctrl-a":"home"}}\n';
  writeFileSync(keys, original, { mode: 0o640 });
  let result = run(); assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(readFileSync(keys, 'utf8'));
  assert.deepEqual(data, { global: { 'ctrl-x': 'app.help', ...hubKeys, ...nexusKeys }, terminal: { 'ctrl-a': 'home' } });
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
  assert.equal(JSON.parse(readFileSync(keys)).global['ctrl-shift-h'], 'app.help');
}));
test('empty-home dry-run previews the key and malformed configs fail before installs', () => sandbox(({ folder, keys, run }) => {
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Merge missing keys: global:cmd-shift-h/);
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

for (const previous of ['cerberus.toggle', 'hub.toggle']) test(`installer migrates ${previous}: only the exact previous hub shortcut and backs it up`, () => sandbox(({ folder, keys, run }) => {
  const original = JSON.stringify({global: {'ctrl-shift-h': previous, 'ctrl-a': 'app.help'}});
  writeFileSync(keys, original);
  let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('migrate ' + previous));
  assert.equal(readFileSync(keys, 'utf8'), original);
  result = run(); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(keys)).global['cmd-shift-h'], 'space-tree.hub');
  assert.equal(JSON.parse(readFileSync(keys)).global['ctrl-shift-h'], undefined);
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

test('app-generated editor files do not prevent safe legacy removal', () => sandbox(({ folder, run }) => {
  for (const name of Object.keys(legacyAssets)) {
    const dir = oldInstall(folder, name);
    writeFileSync(join(dir, 'gpui-kit.d.ts'), '// app generated');
    writeFileSync(join(dir, 'jsconfig.json'), '{}');
  }
  const result = run(); assert.equal(result.status, 0, result.stderr);
  for (const name of Object.keys(legacyAssets)) assert.ok(!readdirSync(join(folder, 'app', 'mods')).includes(name));
}));

for (const name of ['hub', 'hub-bar', 'hub-cell'])
for (const change of ['modified', 'extra', 'symlink']) test(`installer preserves previous ${name} with ${change} files`, () => sandbox(({ folder, run }) => {
  const dir = oldInstall(folder, name);
  if (change === 'modified') writeFileSync(join(dir, 'main.js'), '// custom controller');
  if (change === 'extra') writeFileSync(join(dir, 'notes.txt'), 'user notes');
  if (change === 'symlink') symlinkSync(join(dir, 'main.js'), join(dir, 'gpui-kit.d.ts'));
  const result = run(); assert.equal(result.status, 0, result.stderr);
  assert.ok(statSync(dir).isDirectory());
  assert.match(result.stdout, /Preserve legacy mod/);
}));

for (const [key, builtin] of Object.entries({ 'cmd-alt-left': 'pane.go:left', 'cmd-alt-right': 'pane.go:right', 'cmd-alt-up': 'pane.go:up', 'cmd-alt-down': 'pane.go:down', 'cmd-shift-enter': 'pane.zoom' })) {
  test(`installer migrates only built-in ${key}, preserves custom and bracket shortcuts`, () => sandbox(({ folder, keys, run }) => {
    const original = JSON.stringify({ global: { [key]: builtin, 'cmd-[': 'agent.prev', 'cmd-]': 'agent.next' } });
    writeFileSync(keys, original);
    let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(keys, 'utf8'), original);
    result = run(); assert.equal(result.status, 0, result.stderr);
    const global = JSON.parse(readFileSync(keys)).global;
    assert.equal(global[key], hubKeys[key]);
    assert.equal(global['cmd-['], 'agent.prev'); assert.equal(global['cmd-]'], 'agent.next');
    const backup = readdirSync(join(folder, 'app')).find(n => n.startsWith('keys.json.bak-'));
    assert.equal(readFileSync(join(folder, 'app', backup), 'utf8'), original);
    global[key] = 'custom.action'; writeFileSync(keys, JSON.stringify({ global }));
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(keys)).global[key], 'custom.action');
  }));
}

for (const [oldKey, action] of Object.entries(legacyShortcutDefaults)) {
  const suffix = oldKey.slice('ctrl-shift-'.length);
  test(`installer removes exact Ctrl default ${suffix}, previews removal and backs up`, () => sandbox(({ folder, keys, run }) => {
    const old = `ctrl-shift-${suffix}`, replacement = `cmd-shift-${suffix}`;
    const original = JSON.stringify({ global: { [old]: action } });
    writeFileSync(keys, original);
    let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`global:${old} (remove ${action})`));
    assert.equal(readFileSync(keys, 'utf8'), original);
    result = run(); assert.equal(result.status, 0, result.stderr);
    const bindings = JSON.parse(readFileSync(keys)).global;
    assert.equal(bindings[old], undefined);
    assert.equal(bindings[replacement], action);
    const backup = readdirSync(join(folder, 'app')).find(n => n.startsWith('keys.json.bak-'));
    assert.equal(readFileSync(join(folder, 'app', backup), 'utf8'), original);
  }));
  test(`installer keeps Ctrl default ${suffix} when Cmd is customized`, () => sandbox(({ keys, run }) => {
    const old = `ctrl-shift-${suffix}`, replacement = `cmd-shift-${suffix}`;
    writeFileSync(keys, JSON.stringify({ global: { [old]: action, [replacement]: 'app.help' } }));
    let result = run(['--dry-run']); assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(`global:${old} (remove`));
    result = run(); assert.equal(result.status, 0, result.stderr);
    const bindings = JSON.parse(readFileSync(keys)).global;
    assert.equal(bindings[old], action);
    assert.equal(bindings[replacement], 'app.help');
  }));
}
