// check-contacts.mjs — OFFLINE. The contact book (src/lib/contacts.ts), the
// engine-free address checks behind it (src/lib/addrcheck.ts) and its place in
// the lookalike-address warning (src/lib/lookalike.ts).
// It proves:
//   A. the book's network table is the engines' own: every chain id, its name
//      and whether it is a practice network; 0x networks share one scope,
//      practice never shares with real, each UTXO chain stands alone;
//   B. the address rules it restates say exactly what each engine's own
//      validator says, on a few thousand addresses good and bad, and no
//      address of one kind passes as another; one stored spelling per address;
//   C. names: one line, 32 characters, nothing invisible (a right-to-left
//      override, a zero-width space, a control character);
//   D. the book itself: scopes, one name per address and one address per name
//      within a scope, found again in any spelling, never by a lookalike,
//      rename, remove, the cap;
//   E. storage: ciphertext at rest, nothing readable while locked, gone on
//      erase, another wallet can't read it, and every record is checked on
//      the way back in;
//   F. the lookalike check: a contact is trusted, an address that imitates
//      one warns under the contact's name, and "who is this" (findKnown)
//      speaks for contacts, own addresses and the send log only, never for a
//      history row;
//   G. only the user's hand writes a contact: the three places that call
//      addContact, none of them fed from a history row; no engine is pulled
//      into the App chunk (the whole static import graph is walked); the
//      forms show the name beside the full address; activity names only
//      what this wallet sent.
// Every address here is made up (a hash of a label) or the public BIP39 test
// vector's: a real wallet's counterparties don't belong in a public test.
import { readFileSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2'
import { secp256k1 } from '@noble/curves/secp256k1'
import { base58, createBase58check } from '@scure/base'
import { p2pkh, p2sh, p2tr, p2wpkh, p2wsh } from '@scure/btc-signer'
import { getAddress } from 'viem'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
}
const sec = await import('../src/lib/securestore.ts')
const { CHAINS } = await import('../src/lib/networks.ts')
const { EVM_CHAINS, isValidEvmAddress } = await import('../src/lib/evm.ts')
const { SOL_CHAINS, isValidSolAddress, parseSolScanned } = await import('../src/lib/sol.ts')
const { TRON_CHAINS, isValidTronAddress } = await import('../src/lib/tron.ts')
const { isValidAddress } = await import('../src/lib/txbuild.ts')
const { NETWORK_LABELS, PRACTICE_TWINS, REAL_NETWORKS } = await import('../src/lib/netprefs.ts')
const { isAddressOn, canonicalAddress, addressKey } = await import('../src/lib/addrcheck.ts')
const contacts = await import('../src/lib/contacts.ts')
const { findLookalike, findKnown, knownAddresses, EVM_FORMAT, SOL_FORMAT, TRON_FORMAT, UTXO_FORMAT } = await import('../src/lib/lookalike.ts')
const { recordSentTo, sentToAddresses } = await import('../src/lib/sentlog.ts')
const {
  CONTACT_NETWORKS, CONTACT_LIMIT, CONTACT_NAME_MAX, ContactError, addContact, allContacts, cleanContactName, contactNetwork,
  contactsFor, contactsRevision, contactsUnstored, findContact, onContactsChange, removeContact, renameContact, syncContacts,
} = contacts

let failures = 0
const check = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const refuses = (fn) => {
  try {
    fn()
    return null
  } catch (e) {
    return e
  }
}
const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER_MN = 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const settle = async (key = 'kailah.sec.contacts') => {
  for (let i = 0; i < 40 && !store.has(key); i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 25))
}

// --- made-up addresses -------------------------------------------------------
const bytes = (label, n = 32) => {
  let out = new Uint8Array(0)
  for (let i = 0; out.length < n; i++) out = Uint8Array.from([...out, ...sha256(new TextEncoder().encode(`${label}#${i}`))])
  return out.slice(0, n)
}
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
const b58check = createBase58check(sha256)
const evmAddr = (label) => getAddress(`0x${hex(bytes(`evm ${label}`, 20))}`)
const solAddr = (label) => base58.encode(bytes(`sol ${label}`, 32))
const tronAddr = (label) => b58check.encode(Uint8Array.from([0x41, ...bytes(`tron ${label}`, 20)]))
const pub = (label) => secp256k1.getPublicKey(bytes(`key ${label}`, 32), true)
const utxoAddr = (id, label, kind = 'wpkh') => {
  const net = CHAINS[id].network
  const pk = pub(`${id} ${label}`)
  if (kind === 'pkh') return p2pkh(pk, net).address
  if (kind === 'sh') return p2sh(p2wpkh(pk, net), net).address
  if (kind === 'wsh') return p2wsh(p2pkh(pk, net), net).address
  if (kind === 'tr') return p2tr(pk.slice(1), undefined, net).address
  return p2wpkh(pk, net).address
}

console.log('--- A. the network table is the engines\' own ---')
{
  const engines = [
    ...Object.values(CHAINS).map((c) => ({ id: c.id, name: c.name, mainnet: c.mainnet, kind: 'utxo' })),
    ...Object.values(EVM_CHAINS).map((c) => ({ id: c.id, name: c.name, mainnet: c.mainnet, kind: 'evm' })),
    ...Object.values(SOL_CHAINS).map((c) => ({ id: c.id, name: c.name, mainnet: c.mainnet, kind: 'sol' })),
    ...Object.values(TRON_CHAINS).map((c) => ({ id: c.id, name: c.name, mainnet: c.mainnet, kind: 'tron' })),
  ]
  const wrong = engines.filter((e) => {
    const n = contactNetwork(e.id)
    return n === undefined || n.name !== e.name || n.practice !== !e.mainnet || n.kind !== e.kind
  })
  const extra = CONTACT_NETWORKS.filter((n) => !engines.some((e) => e.id === n.id))
  check('A1 every chain of every engine is in the table, with its own name, kind and real-or-practice flag; nothing else is',
    wrong.length === 0 && extra.length === 0 && CONTACT_NETWORKS.length === engines.length && engines.length === 13, [...wrong.map((e) => e.id), ...extra.map((n) => n.id)].join() || '13 networks')
  const realIds = CONTACT_NETWORKS.filter((n) => !n.practice).map((n) => n.id)
  check('A2 the real networks are the nine the dashboard shows, in its order, under the names Settings uses; the practice ones are their twins',
    realIds.join() === REAL_NETWORKS.join() && realIds.every((id) => NETWORK_LABELS[id].name === contactNetwork(id).name) &&
      CONTACT_NETWORKS.filter((n) => n.practice).map((n) => n.id).sort().join() === Object.keys(PRACTICE_TWINS).sort().join())
  const scope = (id) => contactNetwork(id).scope
  check('A3 Base, Ethereum, Arbitrum and BNB Chain share one scope (a 0x address is one account on all four)',
    new Set(['base', 'ethereum', 'arbitrum', 'bnb'].map(scope)).size === 1)
  check('A4 Bitcoin, Bitcoin testnet, Dogecoin, Litecoin, Solana and TRON each stand alone',
    new Set(['btc', 'btc-testnet', 'doge', 'ltc', 'sol', 'tron', 'base'].map(scope)).size === 7)
  const mixed = CONTACT_NETWORKS.filter((a) => CONTACT_NETWORKS.some((b) => a.scope === b.scope && a.practice !== b.practice))
  check('A5 no scope holds both a practice and a real network: a practice address never shows on a real send form',
    mixed.length === 0 && scope('sol') !== scope('sol-devnet') && scope('tron') !== scope('tron-nile') && scope('base') !== scope('base-sepolia'), mixed.map((n) => n.id).join())
  check('A6 within a scope every network has the same kind of address', CONTACT_NETWORKS.every((a) => CONTACT_NETWORKS.every((b) => a.scope !== b.scope || a.kind === b.kind)))
}

console.log('--- B. the address rules say what each engine\'s own validator says ---')
{
  // EVM: lowercase, uppercase hex, checksummed, one letter's case flipped, wrong shapes
  const evm = []
  for (let i = 0; i < 400; i++) {
    const good = evmAddr(i)
    const lower = good.toLowerCase()
    const upper = `0x${good.slice(2).toUpperCase()}`
    const k = 2 + [...good.slice(2)].findIndex((ch) => /[a-fA-F]/.test(ch))
    const flipped = k >= 2 ? good.slice(0, k) + (good[k] === good[k].toLowerCase() ? good[k].toUpperCase() : good[k].toLowerCase()) + good.slice(k + 1) : good
    evm.push(good, lower, upper, flipped, good.slice(0, -1), `${good}0`, `0X${good.slice(2)}`, good.slice(2), `${good.slice(0, 10)}g${good.slice(11)}`, ` ${good}`)
  }
  const evmDiff = evm.filter((a) => isAddressOn('evm', 'base', a) !== isValidEvmAddress(a))
  check(`B1 EVM: ${evm.length} addresses (checksummed, one case, a flipped letter, wrong length, wrong prefix, a bad character) get the engine's verdict`,
    evmDiff.length === 0 && evm.filter((a) => isAddressOn('evm', 'base', a)).length > 1000 && evm.filter((a) => !isAddressOn('evm', 'base', a)).length > 1000, evmDiff.slice(0, 2).join())
  const flippedWrong = evm.filter((_, i) => i % 10 === 3).filter((a) => a !== getAddress(a.toLowerCase()))
  check('B1b a mixed-case address with one letter in the wrong case is refused: its checksum is the only integrity check it has',
    flippedWrong.length > 350 && flippedWrong.every((a) => !isAddressOn('evm', 'base', a)), `${flippedWrong.length} flipped`)
  check('B1c the stored spelling of a 0x address is its EIP-55 checksum form, whatever case it was typed in (what viem writes)',
    Array.from({ length: 200 }, (_, i) => evmAddr(`c${i}`)).every((a) => canonicalAddress('evm', a.toLowerCase()) === a && canonicalAddress('evm', `0x${a.slice(2).toUpperCase()}`) === a && canonicalAddress('evm', a) === a))

  // Solana: 32 bytes of base58, and what isn't
  const sol = []
  for (let i = 0; i < 400; i++) {
    const good = solAddr(i)
    sol.push(good, base58.encode(bytes(`s31 ${i}`, 31)), base58.encode(bytes(`s33 ${i}`, 33)), `${good.slice(0, 5)}0${good.slice(6)}`, `${good.slice(0, 5)}l${good.slice(6)}`, good.slice(1), `${good}1`, '')
  }
  const solDiff = sol.filter((a) => isAddressOn('sol', 'sol', a) !== isValidSolAddress(a))
  check(`B2 Solana: ${sol.length} addresses (32 bytes, 31, 33, a character base58 doesn't have, cut, padded, empty) get the engine's verdict`,
    solDiff.length === 0 && sol.filter((a) => isAddressOn('sol', 'sol', a)).length >= 400, solDiff.slice(0, 2).join())

  // TRON: 0x41 + 20 bytes, base58check
  const tron = []
  for (let i = 0; i < 400; i++) {
    const good = tronAddr(i)
    const last = good[good.length - 1]
    tron.push(good, b58check.encode(Uint8Array.from([0x42, ...bytes(`t42 ${i}`, 20)])), b58check.encode(Uint8Array.from([0x41, ...bytes(`t19 ${i}`, 19)])),
      good.slice(0, -1) + (last === 'a' ? 'b' : 'a'), good.toLowerCase(), good.slice(1), `${good}1`)
  }
  const tronDiff = tron.filter((a) => isAddressOn('tron', 'tron', a) !== isValidTronAddress(a))
  check(`B3 TRON: ${tron.length} addresses (good, another version byte, 19 bytes, a broken checksum, lowercased, cut, padded) get the engine's verdict`,
    tronDiff.length === 0 && tron.filter((a) => isAddressOn('tron', 'tron', a)).length === 400, tronDiff.slice(0, 2).join())

  // UTXO: every script type on every chain, against every chain
  const utxo = []
  for (const id of Object.keys(CHAINS)) {
    for (let i = 0; i < 25; i++) {
      for (const kind of id === 'doge' ? ['pkh', 'sh'] : ['pkh', 'sh', 'wpkh', 'wsh', 'tr']) utxo.push({ id, kind, address: utxoAddr(id, i, kind) })
    }
  }
  const utxoDiff = []
  for (const u of utxo) for (const id of Object.keys(CHAINS)) {
    for (const a of [u.address, u.address.toUpperCase(), u.address.slice(0, -1), `${u.address}q`]) {
      if (isAddressOn('utxo', id, a) !== isValidAddress(a, CHAINS[id])) utxoDiff.push(`${a}@${id}`)
    }
  }
  const home = utxo.filter((u) => isAddressOn('utxo', u.id, u.address)).length
  const away = utxo.filter((u) => Object.keys(CHAINS).some((id) => id !== u.id && isAddressOn('utxo', id, u.address)))
  check(`B4 the UTXO chains: ${utxo.length} addresses of every script type, on all four chains and in four spellings, get the send form's verdict (it is the same function)`,
    utxoDiff.length === 0 && home === utxo.length, utxoDiff.slice(0, 2).join())
  check('B4b a Bitcoin address is no Litecoin, Dogecoin or testnet address, and the other way round', away.length === 0, away.slice(0, 2).map((u) => `${u.id}:${u.address}`).join())
  const upperBech = utxo.filter((u) => u.kind === 'wpkh' && u.id !== 'doge')
  check('B4c bech32 typed in capitals is the same address, stored in lowercase; base58 keeps its case',
    upperBech.every((u) => canonicalAddress('utxo', u.address.toUpperCase()) === u.address && addressKey('utxo', u.address.toUpperCase()) === addressKey('utxo', u.address)) &&
      utxo.filter((u) => u.kind === 'pkh').every((u) => canonicalAddress('utxo', u.address) === u.address && addressKey('utxo', u.address) !== addressKey('utxo', u.address.toLowerCase())))

  // A Litecoin segwit address in capitals (as a QR code often has it) is, three
  // times in ten, also 32 bytes of valid base58: a "Solana address" no key
  // controls. The Solana form took it, typed or scanned (review 2026-11-21).
  const ltcCaps = Array.from({ length: 600 }, (_, i) => utxoAddr('ltc', `caps ${i}`).toUpperCase())
  const alsoBase58 = ltcCaps.filter((a) => { try { return base58.decode(a).length === 32 } catch { return false } })
  const scanned = alsoBase58.slice(0, 20).map((a) => { try { parseSolScanned(a); return 'accepted' } catch (e) { return e.message } })
  check(`B5a a Litecoin address in capitals is never a Solana address: ${alsoBase58.length} of ${ltcCaps.length} made-up ones are valid base58 of 32 bytes, and the Solana engine, its QR reader and the book all refuse every one`,
    alsoBase58.length > 100 && alsoBase58.every((a) => !isValidSolAddress(a) && !isAddressOn('sol', 'sol', a) && !isAddressOn('sol', 'sol-devnet', a) && isAddressOn('utxo', 'ltc', a)) &&
      scanned.every((m) => /Bitcoin-family address, not a Solana address/.test(m)), scanned.find((m) => !/Bitcoin-family/.test(m)) ?? `${alsoBase58.length} collisions refused`)
  check('B5b ...and the Solana rule still matches its engine on them, and on ordinary Solana addresses that merely start like one',
    [...ltcCaps, ...ltcCaps.map((a) => a.toLowerCase()), 'LTC1' + solAddr('x').slice(4), 'BC1' + solAddr('y').slice(3), 'ltc1' + solAddr('z').slice(4)].every((a) => isAddressOn('sol', 'sol', a) === isValidSolAddress(a)) &&
      Array.from({ length: 300 }, (_, i) => solAddr(`still ${i}`)).every((a) => isValidSolAddress(a) && isAddressOn('sol', 'sol', a)))

  // no address of one kind passes as another, in ANY spelling: as it is, in capitals, in lowercase
  const one = { evm: evm.filter((a) => isValidEvmAddress(a)).slice(0, 300), sol: sol.filter((a) => isValidSolAddress(a)).slice(0, 300), tron: tron.filter((a) => isValidTronAddress(a)).slice(0, 300), utxo: [...utxo.map((u) => u.address), ...ltcCaps.slice(0, 200).map((a) => a.toLowerCase())] }
  const crossed = []
  let tried = 0
  for (const [kind, list] of Object.entries(one)) for (const address of list) for (const a of new Set([address, address.toUpperCase(), address.toLowerCase()])) for (const n of CONTACT_NETWORKS) {
    tried++
    if (n.kind !== kind && isAddressOn(n.kind, n.id, a)) crossed.push(`${kind}→${n.id}:${a}`)
  }
  check(`B5 no address of one kind is accepted on a network of another kind, as written, in capitals or in lowercase (${tried} tries: a TRON address is not a Solana one, a 0x address is nothing else, a segwit address in capitals is not a Solana one)`, crossed.length === 0 && tried > 30000, crossed.slice(0, 2).join())
  check('B6 what isn\'t a string, is empty or is absurdly long is no address', !isAddressOn('evm', 'base', undefined) && !isAddressOn('sol', 'sol', '') && !isAddressOn('sol', 'sol', '1'.repeat(500)) && !isAddressOn('utxo', 'nope', utxoAddr('btc', 0)))
  check('B7 equal keys mean the same address: 0x in any case, bech32 in either case, and nothing else',
    addressKey('evm', evmAddr(1)) === addressKey('evm', evmAddr(1).toLowerCase()) && addressKey('evm', ` ${evmAddr(1)} `) === addressKey('evm', evmAddr(1)) &&
      addressKey('evm', evmAddr(1)) !== addressKey('evm', evmAddr(2)) && addressKey('sol', solAddr(1)) !== addressKey('sol', solAddr(1).toLowerCase()) && addressKey('tron', tronAddr(1)) !== addressKey('tron', tronAddr(1).toLowerCase()))
}

console.log('--- C. names ---')
{
  const bad = (raw) => refuses(() => cleanContactName(raw)) instanceof ContactError
  check('C1 a name is trimmed, kept to one line with single spaces, and normalized (NFC)',
    cleanContactName('  Alice   B.  ') === 'Alice B.' && cleanContactName('Ali\tce\nSmith') === 'Ali ce Smith' && cleanContactName('Zoe\u0308') === 'Zoë' && cleanContactName('Zoe\u0308').length === 3)
  check('C1b a byte-order mark counts as white space, as JavaScript has it: it goes from the ends and shows as a space inside, so it hides nothing',
    cleanContactName('\uFEFFBob\uFEFF') === 'Bob' && cleanContactName('Bo\uFEFFb') === 'Bo b')
  check('C2 an empty name, or one of spaces, is refused', bad('') && bad('   ') && bad('\n\t') && bad(undefined))
  check(`C3 ${CONTACT_NAME_MAX} characters fit and ${CONTACT_NAME_MAX + 1} don't; an emoji counts as one`,
    cleanContactName('a'.repeat(CONTACT_NAME_MAX)).length === CONTACT_NAME_MAX && bad('a'.repeat(CONTACT_NAME_MAX + 1)) && cleanContactName('🦊'.repeat(CONTACT_NAME_MAX)) !== '' && bad('🦊'.repeat(CONTACT_NAME_MAX + 1)))
  const hidden = { 'right-to-left override': 'Alice\u202Eecila', 'left-to-right isolate': '\u2066Bob', 'zero-width space': 'Bo\u200Bb', 'zero-width joiner': 'A\u200DB', 'a control character': 'Bob\u0007', 'a tag character': 'Bob\u{E0041}', 'a private-use character': 'Bob\uE000', 'soft hyphen': 'Bo\u00ADb' }
  const passed = Object.entries(hidden).filter(([, v]) => !bad(v)).map(([k]) => k)
  check('C4 nothing invisible gets into a name: bidi overrides and isolates, zero-width characters, controls, tags, private use', passed.length === 0, passed.join(', '))
  const blank = { 'a Hangul filler': 'Alice\u3164', 'a Hangul filler alone': '\u3164', 'Hangul choseong and jungseong fillers': '\u115F\u1160', 'a halfwidth Hangul filler': 'Bob\uFFA0', 'the blank Braille pattern': 'Bob\u2800', 'the blank Braille pattern alone': '\u2800\u2800', 'a combining grapheme joiner': 'Bo\u034Fb', 'a variation selector after a letter': 'Alice\uFE0F', 'an old variation selector': 'A\uFE00', 'an unassigned code point': 'Bob\u0378', 'a noncharacter': 'Bob\uFFFF', 'a Mongolian vowel separator': 'Bo\u180Eb', 'a joiner between letters': 'a\u200Db', 'a joiner after an emoji with nothing to join': '\u{1F600}\u200D', 'a selector with no emoji before it': '\uFE0F\u{1F600}' }
  const blankPassed = Object.entries(blank).filter(([, v]) => !bad(v)).map(([k]) => k)
  check('C4b nor anything a renderer may leave out or draw as nothing: Hangul fillers, the blank Braille pattern, the grapheme joiner, variation selectors, unassigned code points (two contacts that read alike, or a name that reads as no name)',
    blankPassed.length === 0, blankPassed.join(', '))
  check('C4c a name must have something to read: combining marks alone are refused', bad('\u0301\u0302') && bad('\u0301'))
  const emoji = ['Mum \u2764\uFE0F', 'Home \u{1F3E0}', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} family', 'Dr \u{1F469}\u{1F3FD}\u200D\u2695\uFE0F', '\u2764\uFE0F\u200D\u{1F525}', '\u{1F44D}\u{1F3FD} ok']
  const emojiRefused = emoji.filter((n) => bad(n))
  check('C4d ...while the two invisible characters emoji are built with stay allowed in exactly that place: a red heart, a family, a skin tone',
    emojiRefused.length === 0, emojiRefused.map((n) => [...n].map((c) => c.codePointAt(0).toString(16)).join(' ')).join(' | '))
  check('C5 ordinary names pass: accents, other scripts, digits, punctuation, an emoji',
    ['Søren Ø.', '田中さん', 'Мама', 'Mum & Dad (joint)', 'Kraken — deposits', "O'Neil #2", 'Rent 🏠', 'عمر'].every((n) => cleanContactName(n) === n.normalize('NFC')))
}

sec.clearSecureStore()
await sec.unlockSecureStore(MN)
const A = { evm: evmAddr('alice'), evm2: evmAddr('bob'), sol: solAddr('alice'), tron: tronAddr('alice'), btc: utxoAddr('btc', 'alice'), ltc: utxoAddr('ltc', 'alice'), doge: utxoAddr('doge', 'alice', 'pkh'), tbtc: utxoAddr('btc-testnet', 'alice') }

console.log('--- D. the book ---')
{
  const alice = addContact({ name: '  Alice ', address: A.evm.toLowerCase(), chain: 'base' })
  check('D1 a saved contact comes back with a clean name, the checksummed address, its network and an id',
    alice.name === 'Alice' && alice.address === A.evm && alice.chain === 'base' && /^[0-9a-f]{12}$/.test(alice.id) && Math.abs(alice.added - Date.now()) < 5000)
  check('D2 a contact saved on Base is offered on Ethereum, Arbitrum and BNB Chain too, and remembers where it was saved',
    ['base', 'ethereum', 'arbitrum', 'bnb'].every((id) => contactsFor(id).length === 1 && contactsFor(id)[0].chain === 'base'))
  check('D3 ...and on no practice network, and on no network of another kind',
    ['base-sepolia', 'sol', 'sol-devnet', 'tron', 'tron-nile', 'btc', 'btc-testnet', 'ltc', 'doge'].every((id) => contactsFor(id).length === 0))
  check('D4 it is found by its address in any spelling (checksummed, lowercase, capitals, with spaces round it)',
    [A.evm, A.evm.toLowerCase(), `0x${A.evm.slice(2).toUpperCase()}`, `  ${A.evm} `].every((a) => findContact('arbitrum', a)?.id === alice.id))
  const near = A.evm.slice(0, 8) + evmAddr('near').slice(8, 36) + A.evm.slice(36)
  check('D5 ...and by nothing else: not an address that starts and ends like it, not on a practice network, not for no address',
    findContact('base', near) === undefined && findContact('base-sepolia', A.evm) === undefined && findContact('base', null) === undefined && findContact('base', '') === undefined && findContact('nope', A.evm) === undefined)

  const dupAddr = refuses(() => addContact({ name: 'Someone else', address: A.evm, chain: 'ethereum' }))
  check('D6 the same address again, on any network of the scope, is refused, naming the contact it already is', dupAddr instanceof ContactError && /already saved as “Alice”/.test(dupAddr.message), dupAddr?.message)
  const dupName = refuses(() => addContact({ name: 'ALICE', address: A.evm2, chain: 'bnb' }))
  check('D7 a second address under the same name (in any case) is refused: within a scope a name means one address', dupName instanceof ContactError && /already have a contact called “Alice”/.test(dupName.message), dupName?.message)
  const solAlice = addContact({ name: 'Alice', address: A.sol, chain: 'sol' })
  const practiceAlice = addContact({ name: 'Alice', address: A.evm, chain: 'base-sepolia' })
  check('D8 the same name on another kind of network, and the same address on the practice network, are contacts of their own',
    solAlice.id !== alice.id && practiceAlice.id !== alice.id && contactsFor('sol').length === 1 && contactsFor('base-sepolia').length === 1 && contactsFor('base').length === 1 && contactsFor('sol-devnet').length === 0)

  const heart = addContact({ name: 'Mum \u2764\uFE0F', address: solAddr('heart'), chain: 'sol' })
  const sameHeart = refuses(() => addContact({ name: 'mum \u2764', address: solAddr('heart 2'), chain: 'sol' }))
  check('D8b a name that differs only by an emoji\'s invisible selector is the same name: two contacts can\'t read alike', sameHeart instanceof ContactError && /already have a contact called/.test(sameHeart.message), sameHeart?.message)
  removeContact(heart.id)
  const wrongNet = refuses(() => addContact({ name: 'Carol', address: A.sol, chain: 'tron' }))
  const garbage = refuses(() => addContact({ name: 'Carol', address: 'hello', chain: 'btc' }))
  const noAddr = refuses(() => addContact({ name: 'Carol', address: '  ', chain: 'btc' }))
  const noNet = refuses(() => addContact({ name: 'Carol', address: A.btc, chain: 'bitcoin' }))
  const noName = refuses(() => addContact({ name: ' ', address: A.btc, chain: 'btc' }))
  check('D9 an address that isn\'t one on the chosen network is refused in plain words, as are no address, no network and no name',
    /isn’t a valid TRON address/.test(wrongNet?.message ?? '') && /isn’t a valid Bitcoin address/.test(garbage?.message ?? '') && /Enter this contact’s address/.test(noAddr?.message ?? '') &&
      /Pick a network/.test(noNet?.message ?? '') && /Give this contact a name/.test(noName?.message ?? '') && [wrongNet, garbage, noAddr, noNet, noName].every((e) => e instanceof ContactError),
    [wrongNet, garbage, noAddr, noNet, noName].map((e) => e?.message).join(' | '))
  const wrongChain = refuses(() => addContact({ name: 'Dave', address: A.btc, chain: 'ltc' }))
  check('D9b a Bitcoin address can\'t be saved as a Litecoin contact, nor a testnet one as Bitcoin', wrongChain instanceof ContactError && refuses(() => addContact({ name: 'Dave', address: A.tbtc, chain: 'btc' })) instanceof ContactError)

  const btc = addContact({ name: 'Cold storage', address: A.btc.toUpperCase(), chain: 'btc' })
  check('D10 a bech32 address typed in capitals is stored in lowercase and found either way', btc.address === A.btc && findContact('btc', A.btc.toUpperCase())?.id === btc.id && findContact('btc', A.btc)?.id === btc.id)
  addContact({ name: 'Tron pal', address: A.tron, chain: 'tron' })
  addContact({ name: 'Doge pal', address: A.doge, chain: 'doge' })
  addContact({ name: 'Lite pal', address: A.ltc, chain: 'ltc' })
  addContact({ name: 'Test pal', address: A.tbtc, chain: 'btc-testnet' })
  addContact({ name: 'bob', address: A.evm2, chain: 'ethereum' })
  check('D11 the whole book lists by name, without regard to case', allContacts().map((c) => c.name).join() === 'Alice,Alice,Alice,bob,Cold storage,Doge pal,Lite pal,Test pal,Tron pal', allContacts().map((c) => c.name).join())
  check('D12 each send form gets its own scope\'s contacts, by name', contactsFor('arbitrum').map((c) => c.name).join() === 'Alice,bob' && contactsFor('btc').map((c) => c.name).join() === 'Cold storage' && contactsFor('btc-testnet').map((c) => c.name).join() === 'Test pal')

  const renamed = renameContact(alice.id, ' Alice (work) ')
  const clash = refuses(() => renameContact(alice.id, 'BOB'))
  const recased = renameContact(alice.id, 'alice (WORK)')
  const hiddenName = refuses(() => renameContact(alice.id, 'Alice\u202Ebob'))
  check('D13 rename: a clean new name is taken, another contact\'s name in the scope is refused, changing only the case of its own is fine, a hidden character is refused; the address never changes',
    renamed.name === 'Alice (work)' && clash instanceof ContactError && recased.name === 'alice (WORK)' && hiddenName instanceof ContactError && findContact('base', A.evm)?.name === 'alice (WORK)' && findContact('base', A.evm)?.address === A.evm && findContact('base', A.evm)?.id === alice.id)
  check('D13b renaming a contact that is gone says so', refuses(() => renameContact('0'.repeat(12), 'X')) instanceof ContactError)
  const before = allContacts().length
  removeContact(solAlice.id)
  removeContact('f'.repeat(12))
  check('D14 remove takes exactly that contact; removing one that isn\'t there does nothing', allContacts().length === before - 1 && findContact('sol', A.sol) === undefined && findContact('base', A.evm) !== undefined)

  let fired = 0
  const off = onContactsChange(() => fired++)
  const r0 = contactsRevision()
  const same = contactsRevision()
  const tmp = addContact({ name: 'Temp', address: solAddr('temp'), chain: 'sol' })
  const r1 = contactsRevision()
  removeContact(tmp.id)
  const r2 = contactsRevision()
  off()
  addContact({ name: 'Temp', address: solAddr('temp'), chain: 'sol' })
  check('D15 the UI is told of every change this window makes, and the revision moves exactly when a read would differ', fired === 2 && r0 === same && r1 !== r0 && r2 !== r1)

  // the cap
  sec.secureSet('contacts', { v: 1, list: [] })
  for (let i = 0; i < CONTACT_LIMIT; i++) addContact({ name: `n${i}`, address: solAddr(`cap ${i}`), chain: i % 2 ? 'sol' : 'sol-devnet' })
  const over = refuses(() => addContact({ name: 'one more', address: evmAddr('cap'), chain: 'base' }))
  check(`D16 the book holds ${CONTACT_LIMIT} contacts over all networks; the next one is refused, saying so`, allContacts().length === CONTACT_LIMIT && over instanceof ContactError && /book is full/.test(over.message), over?.message)
  sec.secureSet('contacts', { v: 1, list: [] })
}

console.log('--- E. storage ---')
{
  sec.clearSecureStore(); store.clear()
  await sec.unlockSecureStore(MN)
  const c1 = addContact({ name: 'Grandma Zelda', address: A.sol, chain: 'sol' })
  addContact({ name: 'Exchange', address: A.evm, chain: 'ethereum' })
  await settle()
  const blob = store.get('kailah.sec.contacts') ?? ''
  check('E1 at rest it is ciphertext: no name, address or network in the clear', blob !== '' && !blob.includes('Zelda') && !blob.includes(A.sol) && !blob.includes(A.evm.slice(2, 12)) && !/ethereum|"name"/.test(blob), blob.slice(0, 24))
  sec.lockSecureStore()
  check('E2 locked: only the ciphertext remains, and the book reads as empty', (store.get('kailah.sec.contacts') ?? '') === blob && allContacts().length === 0 && findContact('sol', A.sol) === undefined && contactsFor('ethereum').length === 0)
  await sec.unlockSecureStore(OTHER_MN)
  check('E3 another wallet on the same device can\'t read it', allContacts().length === 0 && findContact('sol', A.sol) === undefined)
  sec.lockSecureStore()
  await sec.unlockSecureStore(MN)
  check('E4 unlocked again with its own phrase: the book is back', allContacts().length === 2 && findContact('sol', A.sol)?.id === c1.id && findContact('bnb', A.evm)?.name === 'Exchange')
  store.set('kailah.sec.contacts', blob.slice(0, -6) + 'AAAAAA')
  sec.lockSecureStore()
  await sec.unlockSecureStore(MN)
  check('E5 a tampered blob fails its authentication and reads as an empty book: nobody adds a contact without the key', allContacts().length === 0)

  // what is stored is checked on the way back in
  const ok = { id: 'a'.repeat(12), name: 'Fine', address: A.sol, chain: 'sol', added: 5 }
  const cases = {
    'a bad id': { ...ok, id: 'xyz', address: solAddr('e1') },
    'an unknown network': { ...ok, id: 'b'.repeat(12), chain: 'solana', address: solAddr('e2') },
    'an address that isn\'t one there': { ...ok, id: 'c'.repeat(12), address: A.tron },
    'a 0x address not in its checksum spelling': { id: 'd'.repeat(12), name: 'Lower', address: A.evm.toLowerCase(), chain: 'base', added: 5 },
    'a name with a right-to-left override': { ...ok, id: 'e'.repeat(12), name: 'Fine\u202Eenif', address: solAddr('e3') },
    'a name with spaces round it': { ...ok, id: 'f'.repeat(12), name: ' Fine2 ', address: solAddr('e4') },
    'a name that is too long': { ...ok, id: '1'.repeat(12), name: 'x'.repeat(CONTACT_NAME_MAX + 1), address: solAddr('e5') },
    'no time': { ...ok, id: '2'.repeat(12), name: 'Timeless', address: solAddr('e6'), added: 'yesterday' },
    'a second record with the same address': { ...ok, id: '3'.repeat(12), name: 'Twin' },
    'a second record with the same name': { ...ok, id: '4'.repeat(12), name: 'fine', address: solAddr('e7') },
    'a second record with the same id': { ...ok, name: 'Same id', address: solAddr('e8') },
  }
  sec.secureSet('contacts', { v: 1, list: [ok, ...Object.values(cases), null, 'x', 7, []] })
  const kept = allContacts()
  check(`E6 ${Object.keys(cases).length} kinds of bad record are dropped on reading, and the good one beside them is kept`,
    kept.length === 1 && kept[0].id === ok.id && kept[0].name === 'Fine', kept.map((c) => c.name).join())
  const shapes = [null, 'contacts', 7, [], { v: 2, list: [ok] }, { v: 1 }, { v: 1, list: 'x' }, { list: [ok] }]
  check('E7 a blob of the wrong shape, or of another version, reads as an empty book', shapes.every((v) => { sec.secureSet('contacts', v); return allContacts().length === 0 && contactsFor('sol').length === 0 }))
  sec.secureSet('contacts', { v: 1, list: Array.from({ length: CONTACT_LIMIT + 50 }, (_, i) => ({ id: i.toString(16).padStart(12, '0'), name: `n${i}`, address: solAddr(`e9 ${i}`), chain: 'sol', added: i })) })
  check(`E8 a stored list longer than the cap reads as ${CONTACT_LIMIT}`, allContacts().length === CONTACT_LIMIT)

  // the browser refuses the write (quota full, storage off): the screens are told, and told again when it works
  sec.secureSet('contacts', { v: 1, list: [] })
  await settle()
  let told = 0
  const offStored = onContactsChange(() => told++)
  const realSet = globalThis.localStorage.setItem
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
  const lost = addContact({ name: 'Unsaved', address: solAddr('unsaved'), chain: 'sol' })
  const before = contactsUnstored()
  await new Promise((r) => setTimeout(r, 60))
  const refused = contactsUnstored()
  const toldRefused = told
  globalThis.localStorage.setItem = realSet
  renameContact(lost.id, 'Saved now')
  await new Promise((r) => setTimeout(r, 60))
  offStored()
  check('E10 a change the browser refused to store is known as that (not before the attempt, and with a second notice to the screens), and the next one that goes through clears it',
    before === false && refused === true && toldRefused === 2 && contactsUnstored() === false && findContact('sol', solAddr('unsaved'))?.name === 'Saved now', JSON.stringify({ before, refused, toldRefused, after: contactsUnstored() }))
  sec.lockSecureStore()
  await sec.unlockSecureStore(MN)
  check('E10b ...and what did go through is what a lock keeps', allContacts().length === 1 && allContacts()[0].name === 'Saved now' && contactsUnstored() === false)

  // another window of the wallet adds a contact; this one must build on it, not over it
  const windowB = await import('../src/lib/securestore.ts?window=contacts-b')
  await windowB.unlockSecureStore(MN)
  const theirs = { id: 'b0'.repeat(6), name: 'From the other window', address: solAddr('window b'), chain: 'sol', added: 7 }
  windowB.secureSet('contacts', { v: 1, list: [...allContacts(), theirs] })
  await new Promise((r) => setTimeout(r, 60))
  const unseen = findContact('sol', theirs.address) === undefined
  await syncContacts()
  const seen = findContact('sol', theirs.address)?.name === 'From the other window'
  addContact({ name: 'Mine', address: solAddr('window a'), chain: 'sol' })
  await new Promise((r) => setTimeout(r, 60))
  sec.lockSecureStore()
  await sec.unlockSecureStore(MN)
  check('E11 another window\'s contact is picked up before a change (syncContacts), so both survive: a change built on the older copy would have dropped theirs',
    unseen && seen && allContacts().map((c) => c.name).sort().join() === 'From the other window,Mine,Saved now', allContacts().map((c) => c.name).join())
  windowB.lockSecureStore()
  const lib = readFileSync(new URL('../src/lib/contacts.ts', import.meta.url), 'utf8')
  const r1 = contactsRevision()
  sec.lockSecureStore()
  const r2 = contactsRevision()
  await sec.unlockSecureStore(MN)
  const r3 = contactsRevision()
  check('E12 the parsed book hangs off the store\'s own object and nowhere else, so a lock or an erase drops it; the revision differs across lock and unlock',
    /const parsedOf = new WeakMap<object, Parsed>\(\)/.test(lib) && !/^let cache\b/m.test(lib) && r2 === 0 && r1 !== 0 && r3 !== 0 && r3 !== r1 && allContacts().length === 3)

  sec.secureSet('contacts', { v: 1, list: [] })
  addContact({ name: 'Last', address: A.sol, chain: 'sol' })
  await settle()
  const had = store.has('kailah.sec.contacts')
  sec.clearSecureStore()
  check('E9 erase removes kailah.sec.contacts with the rest', had && !store.has('kailah.sec.contacts') && allContacts().length === 0 && [...store.keys()].filter((k) => k.startsWith('kailah.sec.')).length === 0)
  const src = readFileSync(new URL('../src/lib/securestore.ts', import.meta.url), 'utf8')
  check('E9b ...because the secure store knows the name (erase walks its list)', /const KNOWN_NAMES = \[[^\]]*'contacts'[^\]]*\]/.test(src))
  await sec.unlockSecureStore(MN)
}

console.log('--- F. the lookalike check ---')
{
  // a lookalike of each contact: the same first and last characters, another middle
  const twin = (a, label, head, tail) => a.slice(0, head) + label.slice(head, a.length - tail) + a.slice(a.length - tail)
  const me = solAddr('me')
  const friend = solAddr('friend')
  const fakeFriend = twin(friend, solAddr('fake friend'), 4, 4)
  const book = [{ address: friend, name: 'Friend' }]
  const known = knownAddresses([me], [fakeFriend, fakeFriend], [], book)
  const m = findLookalike(fakeFriend, known, SOL_FORMAT)
  check('F1 an address that starts and ends like a contact\'s warns, under the contact\'s name, and says it is in the history',
    m?.relation === 'contact' && m.name === 'Friend' && m.known === friend && m.seenIncoming === true && m.ends === 'both', JSON.stringify(m))
  check('F2 the contact\'s own address never warns, saved or typed', findLookalike(friend, known, SOL_FORMAT) === null && findLookalike(` ${friend} `, known, SOL_FORMAT) === null)
  check('F3 a contact is trusted without ever having been paid: no send log entry, no history row', findLookalike(friend, knownAddresses([me], [], [], book), SOL_FORMAT) === null)
  check('F4 ...and without the book the same address is merely new, while its lookalike has nothing to imitate', findLookalike(friend, knownAddresses([me], [], []), SOL_FORMAT) === null && findLookalike(fakeFriend, knownAddresses([me], [], []), SOL_FORMAT) === null)
  // one end alone, on each kind of address
  const oneEnd = [
    ['Solana, the first four', SOL_FORMAT, friend, twin(friend, solAddr('f5a'), 4, 0)],
    ['Solana, the last four', SOL_FORMAT, friend, twin(friend, solAddr('f5b'), 0, 4)],
    ['TRON, the last four', TRON_FORMAT, A.tron, twin(A.tron, tronAddr('f5c'), 1, 4)],
    ['0x, the first six', EVM_FORMAT, A.evm, twin(A.evm, evmAddr('f5d'), 8, 0).toLowerCase()],
    ['0x, the last six', EVM_FORMAT, A.evm, twin(A.evm, evmAddr('f5e'), 2, 6).toLowerCase()],
    ['bech32, the last five', UTXO_FORMAT, A.btc, twin(A.btc, utxoAddr('btc', 'f5f'), 4, 5)],
  ]
  const missed = oneEnd.filter(([, format, real, fake]) => findLookalike(fake, knownAddresses([], [], [], [{ address: real, name: 'C' }]), format)?.relation !== 'contact').map(([label]) => label)
  check('F5 one end alone is enough to warn about a contact, as it is for any trusted address, on every kind of network', missed.length === 0, missed.join(', '))
  // a contact outranks the other relations for the same lookalike
  const both = knownAddresses([friend], [friend], [friend], book)
  check('F6 an address that is a contact, paid before and in the history is one entry, and it is the contact', both.filter((k) => k.address === friend).length === 1 && both[0].relation === 'contact' && findLookalike(fakeFriend, both, SOL_FORMAT)?.relation === 'contact')
  const paid = solAddr('paid')
  const k2 = knownAddresses([me], [solAddr('stranger')], [paid], book)
  check('F7 "who is this": a contact by name, one of your own, one you have paid',
    findKnown(friend, k2, SOL_FORMAT)?.relation === 'contact' && findKnown(friend, k2, SOL_FORMAT)?.name === 'Friend' && findKnown(me, k2, SOL_FORMAT)?.relation === 'own' && findKnown(paid, k2, SOL_FORMAT)?.relation === 'sent')
  check('F8 ...and nothing for a new address, for a lookalike, or for an address that is only in the history: the history is someone else\'s word',
    findKnown(solAddr('brand new'), k2, SOL_FORMAT) === null && findKnown(fakeFriend, known, SOL_FORMAT) === null && findKnown(solAddr('stranger'), k2, SOL_FORMAT) === null && findKnown('', k2, SOL_FORMAT) === null)
  const evmBook = [{ address: A.evm, name: 'Exchange' }]
  check('F9 a 0x contact is known in any case, and a bech32 one in capitals',
    findKnown(A.evm.toLowerCase(), knownAddresses([], [], [], evmBook), EVM_FORMAT)?.name === 'Exchange' && findKnown(A.btc.toUpperCase(), knownAddresses([], [], [], [{ address: A.btc, name: 'Cold' }]), UTXO_FORMAT)?.name === 'Cold')
  check('F10b one of your own addresses that you have also paid (a transfer to yourself) is said to be your own',
    findKnown(me, knownAddresses([me], [me], [me]), SOL_FORMAT)?.relation === 'own' && knownAddresses([me], [me], [me]).length === 1 &&
      // the send log may spell a 0x address another way than the account does: two entries, one answer
      knownAddresses([A.evm], [], [A.evm.toLowerCase()]).length === 2 && findKnown(A.evm, knownAddresses([A.evm], [], [A.evm.toLowerCase()]), EVM_FORMAT)?.relation === 'own' &&
      findKnown(A.evm, knownAddresses([], [], [A.evm.toLowerCase()], [{ address: A.evm, name: 'X' }]), EVM_FORMAT)?.relation === 'contact')
  check('F10 when an address is both a contact and paid before, the contact\'s name is what the form shows', findKnown(friend, knownAddresses([me], [], [friend], book), SOL_FORMAT)?.relation === 'contact')
  // the book and the send log together, as a send form reads them
  sec.secureSet('contacts', { v: 1, list: [] })
  const saved = addContact({ name: 'Landlord', address: friend, chain: 'sol' })
  recordSentTo('sol', paid)
  const live = knownAddresses([me], [fakeFriend], sentToAddresses('sol'), contactsFor('sol'))
  check('F11 a send form\'s view, from the stored book and send log: the contact is known by name, the paid address as paid, the lookalike warns',
    findKnown(friend, live, SOL_FORMAT)?.name === 'Landlord' && findKnown(paid, live, SOL_FORMAT)?.relation === 'sent' && findLookalike(fakeFriend, live, SOL_FORMAT)?.name === 'Landlord')
  removeContact(saved.id)
  const after = knownAddresses([me], [fakeFriend], sentToAddresses('sol'), contactsFor('sol'))
  check('F12 once the contact is removed its trust goes with it: the address is new again, and its lookalike has nothing to imitate', findKnown(friend, after, SOL_FORMAT) === null && findLookalike(fakeFriend, after, SOL_FORMAT) === null)
}

console.log('--- G. who writes a contact, and what the screens show ---')
{
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
  const files = (dir) => readFileSync(new URL(`../${dir}`, import.meta.url)) && null
  void files
  const { readdirSync } = await import('node:fs')
  const srcFiles = ['src', 'src/components', 'src/lib', 'src/engines'].flatMap((d) => readdirSync(new URL(`../${d}`, import.meta.url)).filter((f) => /\.tsx?$/.test(f)).map((f) => `${d}/${f}`))
  const callers = srcFiles.filter((f) => f !== 'src/lib/contacts.ts' && /\baddContact\(/.test(read(f)))
  check('G1 exactly two screens can add a contact: the save offer and Settings', callers.sort().join() === 'src/components/ContactsPanel.tsx,src/components/SaveContact.tsx', callers.join())
  const users = srcFiles.filter((f) => /<SaveContact\b/.test(read(f))).sort()
  check('G2 the save offer appears in the four send forms and the picker, nowhere else', users.join() === ['ContactPicker', 'EvmSendModal', 'SendModal', 'SolSendModal', 'TronSendModal'].map((n) => `src/components/${n}.tsx`).join(), users.join())
  const sendForms = { SendModal: 'step.built.toAddress', EvmSendModal: 'step.prepared.to', SolSendModal: 'step.prepared.to', TronSendModal: 'step.prepared.to' }
  // the block a step renders: from its `{step.kind === '…' && (` to the next step's
  const stepBlock = (s, kind) => {
    const start = s.indexOf(`{step.kind === '${kind}' && (`)
    if (start < 0) return ''
    const next = s.indexOf('{step.kind === ', start + 10)
    return s.slice(start, next < 0 ? s.length : next)
  }
  const offers = Object.entries(sendForms).filter(([f, to]) => {
    const s = read(`src/components/${f}.tsx`)
    const all = [...s.matchAll(/<SaveContact\b[^>]*>/g)].map((m) => m[0])
    const success = stepBlock(s, 'success')
    const elsewhere = ['form', 'preparing', 'prepare-error', 'review', 'broadcasting', 'failed'].filter((k) => stepBlock(s, k).includes('<SaveContact'))
    return all.length === 1 && all[0].includes(`address={${to}}`) && success.includes(all[0]) && success.includes('success-body') && elsewhere.length === 0 && !stepBlock(s, 'failed').includes('success-body')
  })
  check('G3 in a send form it offers one address: the one that send just paid, inside the success step and in no other step (a failed or unclear broadcast offers nothing)', offers.length === 4, offers.map(([f]) => f).join())
  const picker = read('src/components/ContactPicker.tsx')
  check('G4 in the picker it names addresses from the wallet\'s own send log only, and each form hands the picker that log',
    /\[\.\.\.sentTo\]\.reverse\(\)/.test(picker) && /<SaveContact chainId=\{chainId\} address=\{a\}/.test(picker) && !/counterparty|\.txs\b/.test(picker) &&
      Object.keys(sendForms).every((f) => /sentTo=\{sentToAddresses\(chain\.id\)\}/.test(read(`src/components/${f}.tsx`))))
  const historyScreens = ['TxRow', 'TxDetailModal', 'HistoryList', 'ChainCard', 'EvmCard', 'SolCard', 'TronCard', 'Dashboard'].filter((f) => /SaveContact|addContact|renameContact/.test(read(`src/components/${f}.tsx`)))
  check('G5 nothing that shows the transaction history can save or rename a contact: a planted row can\'t become a name', historyScreens.length === 0, historyScreens.join())
  const panel = read('src/components/ContactsPanel.tsx')
  const app = read('src/App.tsx')
  const settings = read('src/components/SettingsModal.tsx')
  check('G6 Settings checks a pasted address against everything a send form would (the book, the send log, the wallet\'s own addresses, its history) before it is saved, and Save waits for the warning to be answered',
    /const \{ own, counterparties \} = knownFor\(net\.id\)\s*return knownAddresses\(own, counterparties, scope\.flatMap\(\(n\) => sentToAddresses\(n\.id\)\), inScope\)/.test(panel) &&
      /useLookalike\(valid \? typed : '', known, FORMATS\[net\.kind\]\)/.test(panel) && /const canSave = valid && duplicate === undefined && name\.trim\(\) !== '' && lookalike\.ok && !full/.test(panel))
  check('G6c the form says first what network of this mode an address belongs to, and suggests the other mode only when none fits; a search stops filtering when its field is gone',
    /const elsewhere =\s*typed !== '' && !valid && fitsHere\.length === 0 \? others\.find/.test(panel) && /const q = contacts\.length >= SEARCH_FROM \? query\.trim\(\)\.toLowerCase\(\) : ''/.test(panel) && /const q = searchable \? query\.trim\(\)\.toLowerCase\(\) : ''/.test(picker))
  check('G6d every change to the book first brings this window up to date with storage, and the screens that change it say when a change wasn\'t stored',
    /void syncContacts\(\)\s*\.then\(act\)/.test(panel) && /void syncContacts\(\)\s*\.then\(\(\) => \{\s*const saved = addContact/.test(read('src/components/SaveContact.tsx')) &&
      ['ContactsPanel', 'ContactPicker', 'SaveContact'].every((f) => /<ContactsUnstored \/>/.test(read(`src/components/${f}.tsx`))) && !/\b(?:addContact|renameContact|removeContact)\(/.test(read('src/components/ContactPicker.tsx')))
  check('G6b ...and App hands it those: own addresses and history counterparties of every network in the contact\'s scope, seed and Ledger accounts alike, each mode with its own keys',
    /<ContactsPanel mode=\{mode\} knownFor=\{contactKnown\} \/>/.test(settings) && /contactKnown=\{contactKnown\}/.test(app) && /if \(n\.scope !== net\.scope\) continue/.test(app) &&
      /hwAccounts\.filter\(\(a\) => a\.chain === n\.id\)\.map\(\(a\) => hardwareSlotKey\(a\.record\)\)/.test(app) && /n\.practice \? solKeys\?\.practice : solKeys\?\.real/.test(app) && /n\.practice \? tronKeys\?\.practice : tronKeys\?\.real/.test(app) &&
      // a new function whenever a key or a history arrives, so the page checks again
      /\[hwAccounts, chainStates, evmKey, evmStates, solKeys, solStates, tronKeys, tronStates\],\s*\)/.test(app))
  // Every module a file loads with it: static value imports and re-exports,
  // followed to the end. `import type` and lazy `import()` load nothing.
  const { existsSync } = await import('node:fs')
  const staticImports = (file) => {
    const src = read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const found = []
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\s)(?:[\w*${}\s,]+?\s+from\s+)?['"](\.[^'"]+)['"]/g)) found.push(m[1])
    const dir = file.slice(0, file.lastIndexOf('/'))
    return found.map((spec) => {
      const parts = `${dir}/${spec}`.split('/')
      const out = []
      for (const part of parts) { if (part === '..') out.pop(); else if (part !== '.') out.push(part) }
      const base = out.join('/')
      return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base].find((c) => existsSync(new URL(`../${c}`, import.meta.url)) && /\.(?:tsx?|css)$/.test(c))
    }).filter((f) => f !== undefined && !f.endsWith('.css'))
  }
  const closure = (roots) => {
    const seen = new Set()
    const todo = [...roots]
    while (todo.length > 0) {
      const f = todo.pop()
      if (seen.has(f)) continue
      seen.add(f)
      todo.push(...staticImports(f))
    }
    return seen
  }
  const heavy = ['evm', 'sol', 'tron', 'solswap', 'solstake', 'tronstake', 'txbuild'].map((n) => `src/lib/${n}.ts`)
  const early = closure(['src/main.tsx', 'src/Shell.tsx', 'src/App.tsx'])
  const pulled = heavy.filter((f) => early.has(f))
  check(`G7 nothing the shell or the unlocked wallet loads at once reaches an engine or the transaction builder: the whole static import graph from main, Shell and App (${early.size} modules, the book's among them) holds none`,
    pulled.length === 0 && early.size > 40 && ['src/lib/contacts.ts', 'src/lib/addrcheck.ts', 'src/lib/utxoaddr.ts', 'src/components/SettingsModal.tsx', 'src/components/ContactName.tsx'].every((f) => early.has(f)), pulled.join() || `${early.size} modules`)
  const bookScreens = closure(['src/components/ContactsPanel.tsx', 'src/components/ContactPicker.tsx', 'src/components/SaveContact.tsx', 'src/components/RecipientNote.tsx'])
  check('G7b ...and neither do the book\'s own screens, which load later (the walker is no dummy: from a send form it does find its engine)',
    heavy.every((f) => !bookScreens.has(f)) && closure(['src/components/SolSendModal.tsx']).has('src/lib/sol.ts') && closure(['src/components/SendModal.tsx']).has('src/lib/txbuild.ts'))
  const settingsSrc = read('src/components/SettingsModal.tsx')
  check('G7c the Contacts page is a chunk of its own inside a boundary of its own: failing to load it shows a message there, and never reaches the shell\'s boundary, which would zero the keys',
    /const ContactsPanel = lazy\(\(\) => import\('\.\/ContactsPanel'\)\)/.test(settingsSrc) && /<ChunkBoundary fallback=\{<ChunkFailed \/>\}>\s*<Suspense[\s\S]{0,260}<ContactsPanel mode=\{mode\} knownFor=\{contactKnown\} \/>\s*<\/Suspense>\s*<\/ChunkBoundary>/.test(settingsSrc))
  const forms = Object.entries(sendForms).filter(([f, to]) => {
    const s = read(`src/components/${f}.tsx`)
    return /const contacts = useContactsFor\(chain\.id\)/.test(s) && /sentToAddresses\(chain\.id\),?\s*contacts,?\s*\)/.test(s) && /\{destValid && lookalike\.match === null && \(\s*<RecipientNote/.test(s) &&
      s.includes(`<ContactName chainId={chain.id} address={${to}} className="review-contact" />`) && s.includes(`<span className="mono review-addr">{${to}}</span>`)
  })
  check('G8 every send form checks against the contacts, says who the address is only when there is no warning, and on review shows the name above the full address, never in its place', forms.length === 4, forms.map(([f]) => f).join())
  const note = read('src/components/RecipientNote.tsx')
  check('G9 the "who is this" line speaks from findKnown alone, and says "new" for everything else', /const match = useMemo\(\(\) => findKnown\(address, known, format\)/.test(note) && /New address: you haven&rsquo;t paid it from this device before\./.test(note))
  check('G9b an address paid on another network of the same kind (a 0x address on Base, now on Ethereum) is said to be exactly that, from the send logs alone, and gets no trusted mark',
    /n\.scope === net\.scope && n\.id !== chainId && sentToAddresses\(n\.id\)\.some\(\(a\) => addressKey\(net\.kind, a\) === key\)/.test(note) &&
      /if \(paidOn !== undefined\) \{\s*return \(\s*<div className="recipient-note" role="status">/.test(note))
  const warning = read('src/components/LookalikeWarning.tsx')
  check('G9c a contact\'s name inside the warning\'s sentences is isolated from the words round it', (warning.match(/<bdi>\{contactName\}<\/bdi>/g) ?? []).length === 2)
  const rows = ['TxRow', 'EvmCard', 'SolCard', 'TronCard', 'TxDetailModal'].filter((f) => /<ContactName\b/.test(read(`src/components/${f}.tsx`)))
  const name = read('src/components/ContactName.tsx')
  check('G10 activity rows and transaction details show a contact\'s name for exactly its address (findContact), on all four kinds of network', rows.length === 5 && /useContact\(chainId, address\)/.test(name) && /findContact\(chainId, address\)/.test(read('src/components/useContacts.ts')))
  // who a payment came FROM is another's word: a token's contract writes it
  const guards = {
    TxRow: /\{!unknown && tx\.direction === 'out' && \(\s*<ContactName /,
    TxDetailModal: /\{tx\.direction === 'out' && \(\s*<ContactName /,
    EvmCard: /\{t\.direction === 'out' && t\.tokenSymbol === undefined && \(\s*<ContactName /,
    SolCard: /\{!t\.swap && t\.direction === 'out' && \(\s*<ContactName /,
    TronCard: /\{t\.direction === 'out' && \(\s*<ContactName /,
  }
  const unguarded = Object.entries(guards).filter(([f, re]) => { const src = read(`src/components/${f}.tsx`); return !re.test(src) || (src.match(/<ContactName\b/g) ?? []).length !== 1 || /prefix=\{?["']?from /.test(src) }).map(([f]) => f)
  check('G10b ...and only on what this wallet sent: never on a payment that arrived (a scam token\'s contract can write a contact\'s address as its sender), and never on a token the wallet doesn\'t vouch for',
    unguarded.length === 0, unguarded.join())
  const css = read('src/styles.css')
  check('G11 a name can\'t reorder an address or an amount beside it: every element that shows one isolates its direction (names in a sentence of an error message are ordinary text, and hold no direction controls)', /\.recipient-name,\s*\.contact-name,\s*\.review-contact,\s*\.contact-row-name,\s*\.contact-item-name,\s*\.lookalike-name \{[^}]*unicode-bidi: isolate/.test(css))
  const scripts = readdirSync(new URL('../scripts', import.meta.url)).filter((f) => /\.mjs$/.test(f)).map((f) => `scripts/${f}`)
  const raw = [...srcFiles, ...scripts, 'src/styles.css'].filter((f) => /[\p{Cf}\p{Co}\p{Zl}\p{Zp}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(read(f)))
  check('G13 no source file or check holds an invisible or direction-changing character: they are written as escapes, so what a reviewer sees is what runs', raw.length === 0, raw.join())
  const pkg = JSON.parse(read('package.json'))
  check('G12 this check runs in the offline suite CI runs', /\bcontacts\b/.test(pkg.scripts['check:offline']))
}

console.log(failures === 0 ? '\nAll contact checks passed.' : `\n${failures} CHECK(S) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
