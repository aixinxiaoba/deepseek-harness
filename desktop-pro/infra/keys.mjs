#!/usr/bin/env node
/**
 * Ed25519 key management for the update pipeline (design §4.1).
 *
 * The private key lives on the release machine only (infra/keys/, gitignored);
 * the public key is embedded in the client updater where every install
 * verifies update manifests against it — publisher identity, not just
 * transport integrity.
 *
 * Usage:
 *   node infra/keys.mjs generate                 # create infra/keys/{private,public}.pem
 *   node infra/keys.mjs sign <file>              # write <file>.sig (over raw bytes)
 *   node infra/keys.mjs verify <file> <sig> <pub> # exit 0 when valid
 *   node infra/keys.mjs public                   # print the embedded-form public key
 */
import { generateKeyPairSync, sign, verify, createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const keysDir = resolve(import.meta.dirname, 'keys')

function loadPrivate() {
  const file = join(keysDir, 'private.pem')
  if (!existsSync(file)) throw new Error(`no private key at ${file}; run: node infra/keys.mjs generate`)
  return readFileSync(file, 'utf8')
}

const command = process.argv[2]
switch (command) {
  case 'generate': {
    if (existsSync(join(keysDir, 'private.pem'))) throw new Error('private key already exists; refusing to overwrite')
    mkdirSync(keysDir, { recursive: true })
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    writeFileSync(join(keysDir, 'private.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }))
    writeFileSync(join(keysDir, 'public.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
    console.log(`keys written to ${keysDir} (keep private.pem offline-only)`)
    break
  }
  case 'sign': {
    const file = process.argv[3]
    const data = readFileSync(file)
    const signature = sign(null, data, loadPrivate())
    writeFileSync(`${file}.sig`, signature)
    console.log(`signed ${file} (sha256 ${createHash('sha256').update(data).digest('hex').slice(0, 12)}…)`)
    break
  }
  case 'verify': {
    const [, , , file, sigFile, pubFile] = process.argv
    const okSig = verify(null, readFileSync(file), readFileSync(pubFile), readFileSync(sigFile))
    console.log(okSig ? 'VALID' : 'INVALID')
    process.exit(okSig ? 0 : 1)
  }
  case 'public': {
    console.log(loadPublicRaw())
    break
  }
  default:
    console.log('usage: keys.mjs generate | sign <file> | verify <file> <sig> <pub> | public')
}

function loadPublicRaw() {
  return readFileSync(join(keysDir, 'public.pem'), 'utf8')
}
