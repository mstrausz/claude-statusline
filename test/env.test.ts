import { expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { splitPathList, withLock, writeAtomic } from '../src/env.ts'
import { tempConfig } from './helpers.ts'

const cfg = tempConfig()

test('withLock runs the job and releases the lock', async () => {
  const lock = join(cfg.dir, 'a.lock')
  let ran = false
  expect(await withLock(lock, async () => void (ran = true))).toBe(true)
  expect(ran).toBe(true)
  expect(existsSync(lock)).toBe(false)
})

test('withLock skips while a live process holds the lock', async () => {
  const lock = join(cfg.dir, 'b.lock')
  writeFileSync(lock, String(process.pid))
  let ran = false
  expect(await withLock(lock, async () => void (ran = true))).toBe(false)
  expect(ran).toBe(false)
  expect(readFileSync(lock, 'utf8')).toBe(String(process.pid))
})

test('withLock takes over a lock whose process is gone', async () => {
  const lock = join(cfg.dir, 'c.lock')
  const gone = Bun.spawnSync([process.execPath, '-e', 'process.pid']).pid // exited already
  writeFileSync(lock, String(gone))
  let ran = false
  expect(await withLock(lock, async () => void (ran = true))).toBe(true)
  expect(ran).toBe(true)
})

test('withLock releases the lock when the job throws', async () => {
  const lock = join(cfg.dir, 'd.lock')
  await expect(withLock(lock, async () => { throw new Error('boom') })).rejects.toThrow('boom')
  expect(existsSync(lock)).toBe(false)
})

test('writeAtomic creates folders and replaces the file', () => {
  const f = join(cfg.dir, 'x', 'y', 'f.txt')
  writeAtomic(f, 'one')
  writeAtomic(f, 'two')
  expect(readFileSync(f, 'utf8')).toBe('two')
})

test('splitPathList', () => {
  expect(splitPathList('/a::/b', ':')).toEqual(['/a', '/b'])
  expect(splitPathList('C:\\a;D:\\b', ';')).toEqual(['C:\\a', 'D:\\b'])
  expect(splitPathList(undefined, ':')).toEqual([])
})

test('logError moves a full log aside', async () => {
  const { logError } = await import('../src/env.ts')
  const log = join(cfg.dir, 'cache', 'statusline.log')
  logError('job', new Error('first'))
  writeFileSync(log, 'x'.repeat(1_000_001))
  logError('job', new Error('second'))
  expect(readFileSync(`${log}.1`, 'utf8').length).toBe(1_000_001)
  expect(readFileSync(log, 'utf8')).toContain('job: Error: second')
})
