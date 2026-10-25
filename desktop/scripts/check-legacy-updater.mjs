import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, copyFileSync, existsSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const target = process.argv[2];
if (target !== 'x86_64-pc-windows-msvc') throw new Error('Run the released-source replay on the Windows CI target.');
const released = 'd7d7331e6294efd002d6b9e2d77a8490462914ba'; // desktop-v0.4.4
const tests = join(root, 'desktop/src-tauri/tests');
const fixture = join(tests, 'ownership-legacy');
const harness = join(tests, 'ownership_legacy.rs');
if (existsSync(fixture) || existsSync(harness)) throw new Error('Refuse to overwrite existing test work.');
execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', released], { cwd: root, stdio: 'inherit' });
const source = execFileSync('git', ['show', `${released}:desktop/src-tauri/src/update_check.rs`], { cwd: root });
mkdirSync(fixture, { recursive: true });
const sourceFile = join(fixture, 'released_update_check.rs');
try {
  writeFileSync(sourceFile, source);
  copyFileSync(join(root, 'desktop/scripts/fixtures/ownership-legacy-updater.rs'), harness);
  execFileSync('cargo', ['test', '--manifest-path', 'desktop/src-tauri/Cargo.toml', '--locked', '--target', target,
    '--test', 'ownership_legacy', 'ownership_legacy_'], { cwd: root, stdio: 'inherit' });
} finally {
  // Only remove these newly created fixture files; never clear an existing tree.
  if (existsSync(harness)) unlinkSync(harness);
  if (existsSync(sourceFile)) unlinkSync(sourceFile);
  rmdirSync(fixture);
}
console.log(JSON.stringify({ released_tag: 'desktop-v0.4.4', source: released,
  pre_transfer_bridge_offer: true, post_transfer_new_owner_accepted: false,
  repository_transfer_approved: false, scope: 'released-source replay, not installed-binary acceptance' }));
