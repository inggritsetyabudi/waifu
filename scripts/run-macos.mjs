import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'darwin') throw new Error('Use npm run tauri dev on non-macOS platforms.');
const build = spawnSync('npm', ['run','tauri','--','build','--debug','--bundles','app'], {cwd:root,stdio:'inherit',env:{...process.env,CARGO_INCREMENTAL:process.env.CARGO_INCREMENTAL ?? '0'}});
if (build.status !== 0) process.exit(build.status ?? 1);
const app = join(root,'src-tauri/target/debug/bundle/macos/ai-vtuber-assistant.app');
// A running app keeps the previous embedded frontend; reopen this exact bundle.
const executable = join(app,'Contents/MacOS/ai-vtuber-assistant');
const processes = spawnSync('/bin/ps',['-axo','pid=,command='],{encoding:'utf8'});
for (const line of (processes.stdout ?? '').split('\n')) {
  const match=line.trim().match(/^(\d+)\s+(.+)$/);
  if(match && match[2]===executable) { try {process.kill(Number(match[1]),'SIGTERM');} catch {} }
}
await new Promise(resolve=>setTimeout(resolve,350));
const open = spawnSync('/usr/bin/open', [app], {stdio:'inherit'});
process.exit(open.status ?? 1);
