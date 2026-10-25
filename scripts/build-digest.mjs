// SHA-256 of every file in a build, listed as `sha256sum` would list them, and
// one digest over that list. CI prints these for every push, so anyone can
// rebuild a commit (Node 20, `npm ci`, `npm run build && npm run build:extension`)
// and compare:  node scripts/build-digest.mjs [--list] [dir ...]
// (default dirs: dist dist-extension). verify-live.mjs uses the same digest.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Every file under dir as a forward-slash path relative to it, in byte order. */
export function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** { files: [{ path, sha }], list, digest }. The list is `sha256sum` format. */
export function buildDigest(dir) {
  const files = listFiles(dir).map((path) => ({ path, sha: sha256(readFileSync(join(dir, path))) }))
  const list = files.map((f) => `${f.sha}  ./${f.path}\n`).join('')
  return { files, list, digest: sha256(list) }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const showList = args.includes('--list')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const dirs = args.filter((a) => a !== '--list')
  for (const dir of dirs.length ? dirs : ['dist', 'dist-extension']) {
    const abs = join(root, dir)
    if (!existsSync(abs)) {
      console.log(`${dir}: missing (build it first)`)
      process.exitCode = 1
      continue
    }
    const d = buildDigest(abs)
    console.log(`${dir}: ${d.digest}  (${d.files.length} files)`)
    if (showList) process.stdout.write(d.list)
  }
}
