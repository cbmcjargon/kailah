// check-vault.mjs — OFFLINE. Vault v2 checks: Argon2id round trip, transparent v1 (PBKDF2) -> v2 upgrade,
// wrong password, tampered parameters, and the password-strength policy.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const { webcrypto } = await import('node:crypto')
if (!globalThis.crypto) globalThis.crypto = webcrypto
const { base64 } = await import('@scure/base')
const { saveVault, unlockVault, vaultKdf } = await import('../src/lib/vault.ts')
const { passwordProblem, passwordStrength } = await import('../src/components/PasswordForm.tsx')

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
let failures = 0
const check = (name, cond, detail = '') => { if (!cond) failures++; console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`) }
const rec = () => JSON.parse(localStorage.getItem('kailah.vault.v1'))

// --- v2 round trip ----------------------------------------------------------
let t0 = Date.now(); await saveVault(M, 'correct horse battery staple'); const saveMs = Date.now() - t0
check('saveVault writes a v2 argon2id record', rec().v === 2 && rec().kdf === 'argon2id' && rec().m === 32768 && rec().t === 3, `${saveMs} ms`)
t0 = Date.now(); check('unlockVault v2 returns the mnemonic', (await unlockVault('correct horse battery staple')) === M, `${Date.now() - t0} ms`)
check('vaultKdf reports argon2id', vaultKdf() === 'argon2id')
{ let msg = ''; try { await unlockVault('wrong password here') } catch (e) { msg = e.message }; check('v2 wrong password -> Wrong password', msg === 'Wrong password', msg) }
{ const r = rec(); r.m = 99999999; localStorage.setItem('kailah.vault.v1', JSON.stringify(r)); let msg = ''; const s = Date.now(); try { await unlockVault('correct horse battery staple') } catch (e) { msg = e.message }
  check('v2 absurd memory parameter refused immediately as damaged', /damaged/.test(msg) && Date.now() - s < 1000, `${msg} (${Date.now() - s}ms)`) }

// --- v1 legacy record built exactly as the old code did -> upgrade on unlock --
async function writeV1(mnemonic, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(mnemonic))
  localStorage.setItem('kailah.vault.v1', JSON.stringify({ v: 1, kdf: 'pbkdf2-sha256', iter: 600000, salt: base64.encode(salt), iv: base64.encode(iv), ct: base64.encode(new Uint8Array(ct)) }))
}
await writeV1(M, 'legacy pass 123')
check('legacy record is v1', rec().v === 1 && vaultKdf() === 'pbkdf2')
check('v1 unlock returns the mnemonic', (await unlockVault('legacy pass 123')) === M)
check('…and the record is now v2 argon2id', rec().v === 2 && rec().kdf === 'argon2id')
check('v2 unlock with the same password still works after upgrade', (await unlockVault('legacy pass 123')) === M)
await writeV1(M, 'legacy pass 123')
{ let msg = ''; try { await unlockVault('nope nope nope') } catch (e) { msg = e.message }; check('v1 wrong password -> Wrong password, no upgrade', msg === 'Wrong password' && rec().v === 1, msg) }
{ const r = rec(); r.iter = 2000000000; localStorage.setItem('kailah.vault.v1', JSON.stringify(r)); let msg = ''; try { await unlockVault('legacy pass 123') } catch (e) { msg = e.message }; check('v1 absurd iter still refused as damaged', /damaged/.test(msg), msg) }

// --- a damaged record is not a wrong password (bug audit 2026-10-27, BL38) --
{
  await saveVault(M, 'correct horse battery staple')
  const good = localStorage.getItem('kailah.vault.v1')
  const tryWith = async (raw) => {
    localStorage.setItem('kailah.vault.v1', raw)
    try { await unlockVault('correct horse battery staple'); return 'unlocked' } catch (e) { return e.message }
  }
  const r = JSON.parse(good)
  const cases = {
    'not JSON': '{"v":2,"kdf":',
    'bad base64': JSON.stringify({ ...r, iv: '***not base64***' }),
    'an unknown version': JSON.stringify({ ...r, v: 7 }),
    'a short IV': JSON.stringify({ ...r, iv: base64.encode(new Uint8Array(4)) }),
    'a ciphertext shorter than its tag': JSON.stringify({ ...r, ct: base64.encode(new Uint8Array(8)) }),
  }
  const answers = {}
  for (const [what, raw] of Object.entries(cases)) answers[what] = await tryWith(raw)
  check('a record that can\'t be read says it is damaged, not "Wrong password": ' + Object.keys(cases).join(', '),
    Object.values(answers).every((m) => /damaged/.test(m)), JSON.stringify(answers))
  check('...while a readable record with the wrong password still says Wrong password', (await tryWith(good).then(async () => { try { await unlockVault('wrong password here'); return '' } catch (e) { return e.message } })) === 'Wrong password')
  localStorage.setItem('kailah.vault.v1', good)
  check('...and the intact record still unlocks', (await unlockVault('correct horse battery staple')) === M)
}

// --- every BIP39 phrase length restores (BL37) --------------------------------
{
  const { PHRASE_LENGTHS } = await import('../src/components/RestoreFlow.tsx')
  const { isValidMnemonic } = await import('../src/lib/keys.ts')
  const { generateMnemonic } = await import('@scure/bip39')
  const { wordlist } = await import('@scure/bip39/wordlists/english')
  const phrases = [128, 160, 192, 224, 256].map((bits) => generateMnemonic(wordlist, bits))
  check('the restore form takes 12, 15, 18, 21 and 24 words, and each length validates (15/18/21 read "Not a valid phrase")',
    PHRASE_LENGTHS.join() === '12,15,18,21,24' && phrases.every((p) => PHRASE_LENGTHS.includes(p.split(' ').length) && isValidMnemonic(p)))
}

// --- a biometric setup that fails gives its passkey back (BL39) ---------------
{
  const signals = []
  globalThis.location = { hostname: 'wallet.example' }
  const rawId = Uint8Array.from([1, 2, 3, 250, 251, 252]).buffer
  Object.defineProperty(globalThis, 'navigator', {
    value: { credentials: { create: async () => ({ rawId, getClientExtensionResults: () => ({ prf: { enabled: false } }) }) } },
    configurable: true,
    writable: true,
  })
  globalThis.PublicKeyCredential = { signalUnknownCredential: async (o) => void signals.push(o) }
  const { enrollBiometric } = await import('../src/lib/biometric.ts')
  let msg = ''
  try { await enrollBiometric(M) } catch (e) { msg = e.message }
  check('a passkey created by a setup that then failed is signalled unknown, so the device drops it (it was left behind)',
    /does not support biometric key protection/.test(msg) && signals.length === 1 && signals[0].rpId === 'wallet.example' && signals[0].credentialId === 'AQID-vv8', `${msg} / ${JSON.stringify(signals)}`)
  delete globalThis.PublicKeyCredential
  msg = ''
  try { await enrollBiometric(M) } catch (e) { msg = e.message }
  check('...and where the browser can\'t be asked, the message says where the leftover passkey is', /may be left in this device's passkey list/.test(msg), msg)
  check('...and nothing was stored', localStorage.getItem('kailah.biovault.v1') === null)
  delete globalThis.navigator
  delete globalThis.location
}

// --- the shell and the wallet (BL40, BL41), read from the source -------------
{
  const { readFileSync } = await import('node:fs')
  const read = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
  const shell = read('Shell.tsx')
  check('an erase while a (slow) unlock runs wins: that unlock opens nothing (BL40)',
    /const erase = useCallback\(\(\) => \{\n    eraseEpochRef\.current \+= 1/.test(shell) &&
      /const erased = \(\) => epoch !== eraseEpochRef\.current \|\| !hasVault\(\)/.test(shell) && /onUnlockStart=\{handleUnlockStart\}/.test(shell))
  const app = read('App.tsx')
  check('the wallet zeroes its keys whenever it unmounts — a render error included — but not on StrictMode\'s rehearsal (BL41)',
    /if \(!mountedRef\.current\) wipeRef\.current\(\)/.test(app) && /mountedRef\.current = true/.test(app))
}

// --- password policy ------------------------------------------------------
check('short password rejected', passwordProblem('abc12345') !== null)
check('common password rejected', passwordProblem('iloveyou') !== null && passwordProblem('password1') !== null)
check('obvious word in a short password rejected', passwordProblem('bitcoin2026') !== null)
check('single-class short password rejected', passwordProblem('abcdefghijkl') !== null)
check('four random words accepted', passwordProblem('correct horse battery staple') === null)
check('mixed 12-char accepted', passwordProblem('Tr0ub4dor&3x') === null)
check('strength: passphrase is strong', passwordStrength('correct horse battery staple') === 'strong')
check('strength: 10-char mixed is okay', passwordStrength('Abcdef1234') === 'okay', passwordStrength('Abcdef1234'))

console.log(failures === 0 ? '\nAll vault checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
