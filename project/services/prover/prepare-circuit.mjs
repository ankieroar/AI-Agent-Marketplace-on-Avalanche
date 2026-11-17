import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const circuitDir = path.join(root, 'circuits/hello_world');
const nargo = path.join(root, '.tools/noir/nargo');
if (!fs.existsSync(nargo)) throw new Error('Install pinned Noir beta.3 first; see README-ZK-DAY1.md');
if (!fs.existsSync(path.join(circuitDir, 'Prover.toml'))) {
  fs.copyFileSync(path.join(circuitDir, 'Prover.example.toml'), path.join(circuitDir, 'Prover.toml'));
}
for (const command of ['--version', 'test', 'execute']) {
  const result = process.platform === 'win32'
    ? spawnSync('docker', ['run', '--rm', '-v', root.replaceAll('\\', '/') + ':/work', '-w', '/work/circuits/hello_world',
      '--entrypoint', '/work/.tools/noir/nargo', 'mirror.gcr.io/library/ubuntu:24.04', command], { encoding: 'utf8', windowsHide: true })
    : spawnSync(nargo, [command], { cwd: circuitDir, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || 'nargo failed');
  if (command === '--version' && !result.stdout.includes('1.0.0-beta.3')) throw new Error('Expected nargo 1.0.0-beta.3');
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
}
