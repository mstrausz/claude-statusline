// bun scripts/build.ts          -> dist/claude-statusline[.exe] for this machine
// bun scripts/build.ts --all    -> dist/claude-statusline-<os>-<arch>[.exe] for every target

import { join } from 'node:path'

const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64', 'windows-arm64']
const root = join(import.meta.dir, '..')
const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`

const builds = process.argv.includes('--all')
  ? TARGETS.map(t => ({ target: t, out: `claude-statusline-${t}${t.startsWith('windows') ? '.exe' : ''}` }))
  : [{ target: host, out: `claude-statusline${process.platform === 'win32' ? '.exe' : ''}` }]

for (const { target, out } of builds) {
  const outfile = join(root, 'dist', out)
  // --bytecode only for the host: it is compiled by the running bun's own engine.
  const bytecode = target === host ? ['--bytecode'] : []
  const r = Bun.spawnSync(
    [process.execPath, 'build', '--compile', '--minify', ...bytecode, `--target=bun-${target}`,
      join(root, 'src', 'main.ts'), '--outfile', outfile],
    { stdout: 'inherit', stderr: 'inherit' },
  )
  if (r.exitCode !== 0) process.exit(r.exitCode ?? 1)
  console.log(`built ${outfile}`)
}
