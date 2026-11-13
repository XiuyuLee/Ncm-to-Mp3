// Extract selected members from an Electron asar archive to a real directory.
// Usage: node extract-asar.mjs <archive.asar> <outDir> <memberPrefix> [<memberPrefix> ...]
// Member names use forward slashes, e.g. node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const [archive, outDir, ...prefixes] = process.argv.slice(2)
if (!archive || !outDir || prefixes.length === 0) {
  console.error('usage: node extract-asar.mjs <archive.asar> <outDir> <memberPrefix> [...]')
  process.exit(2)
}

const buf = readFileSync(archive)
// asar header layout: 8-byte size-pickle prefix, then a JSON header of jsonSize bytes at offset 16.
const headerSize = buf.readUInt32LE(4)
const jsonSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'))
const dataOffset = 8 + headerSize

const extracted = []
const missing = []

function norm(p) {
  return p.replace(/\\/g, '/').replace(/^\/+/, '')
}

function walk(node, pathParts) {
  if (!node || typeof node !== 'object') return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, [...pathParts, name])
    return
  }
  if (typeof node.offset !== 'string') return
  const memberPath = pathParts.join('/')
  const wanted = prefixes.some((prefix) => memberPath === prefix || memberPath.startsWith(prefix))
  if (!wanted) return
  const offset = dataOffset + Number(node.offset)
  const size = Number(node.size)
  const outPath = join(outDir, memberPath)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, buf.subarray(offset, offset + size))
  extracted.push(`${memberPath} (${size} bytes)`)
}

walk({ files: header.files }, [])
for (const prefix of prefixes) {
  if (!extracted.some((line) => line.startsWith(norm(prefix)) || norm(prefix) === '')) missing.push(prefix)
}
console.log(JSON.stringify({ dataOffset, extracted, missing }, null, 2))
