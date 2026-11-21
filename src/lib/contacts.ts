// The contact book: names the user gives to addresses they pay.
//
// Contract:
//   CONTACT_NETWORKS                      — every network a contact can be on
//   contactNetwork(chainId)               — its row, or undefined
//   allContacts(): Contact[]              — every contact, by name
//   contactsFor(chainId): Contact[]       — the ones a send on that chain can use
//   findContact(chainId, address)         — the contact with exactly that address
//   addContact({ name, address, chain })  — throws ContactError in plain words
//   renameContact(id, name) / removeContact(id)
//   syncContacts(): Promise<void>         — before a change: another window may have written
//   contactsUnstored(): boolean           — the last change didn't reach storage
//   onContactsChange(listener) / contactsRevision()   — for the UI to re-read
//
// Why it exists: address poisoning works on people who copy an address out of
// their history (lookalike.ts). A contact is the address the user checked
// once, under a name they chose, so the next payment needs no copying at all.
//
// Trust. A contact is TRUSTED by the lookalike check, like an address the
// wallet's own send log says it paid, because only the user can make one: it
// is written by three places, each with the user's hand on it (Settings, the
// "save" offer after a send, and "name it" on an address from the send log),
// never from a history row. A data service that lies about history can
// therefore plant no contact. The list is authenticated at rest (AES-GCM,
// securestore.ts), so nothing but an unlocked wallet can add to it either.
//
// Scope. A contact belongs to the network it was saved on, and a send form
// offers the contacts of its own scope only:
//   - Bitcoin, Bitcoin testnet, Dogecoin and Litecoin are each their own:
//     their addresses differ.
//   - Base, Ethereum, Arbitrum and BNB Chain share one: a 0x address is the
//     same account on all four. The contact remembers which one it was saved
//     on, and the form says so when it is used on another (an exchange's
//     deposit address may take one network and not the next).
//   - Practice networks never share with real ones, though the address format
//     is the same on Solana, TRON and Base Sepolia. This wallet's own practice
//     accounts use other keys than its real ones (CLAUDE.md, "Practice-mode
//     keys are separate"), so a practice address saved under a friendly name
//     and then paid in real mode could send real coins where no key of this
//     wallet reaches them in real mode.
//
// Names are for people to read, so they hold nothing that hides: no control
// or formatting characters (a right-to-left override can make one name read
// as another), nothing a renderer may leave out (a Hangul filler looks like
// no name at all), one line, 32 characters. The two invisible characters
// emoji are built with are allowed in exactly that place. Within a scope a
// name means one address and an address has one name.
//
// Storage: the encrypted secure store ('contacts' → kailah.sec.contacts):
// ciphertext while locked, keyed to this seed, removed by erase with every
// other kailah.sec.* blob. Like the send log it does not follow the recovery
// phrase to another device. Every record is checked again on the way back in.
// The parsed list hangs off the store's own object (a WeakMap), so a lock or
// an erase drops it with that object. Unlike a cache, the book is the user's
// own data: a screen brings this window up to date before it changes it
// (syncContacts: another window may have written), and says so when the
// browser refused to store a change (contactsUnstored).
//
// Engines: this module names chain ids itself (as netprefs.ts does) and
// judges addresses through addrcheck.ts, so it pulls no engine into the App
// chunk; check-contacts A holds the table to the engines' own configs.

import { addressKey, canonicalAddress, isAddressOn, type AddressKind } from './addrcheck'
import { refreshSecure, secureGet, securePersisted, secureSet } from './securestore'

export interface ContactNetwork {
  /** the chain id, as in the engine configs */
  id: string
  /** the chain's name, as its card shows it */
  name: string
  kind: AddressKind
  /** contacts are shared within a scope and never across two */
  scope: string
  practice: boolean
}

/** Every network a contact can be saved on: real ones in dashboard order, then practice. */
export const CONTACT_NETWORKS: readonly ContactNetwork[] = [
  { id: 'btc', name: 'Bitcoin', kind: 'utxo', scope: 'btc', practice: false },
  { id: 'doge', name: 'Dogecoin', kind: 'utxo', scope: 'doge', practice: false },
  { id: 'ltc', name: 'Litecoin', kind: 'utxo', scope: 'ltc', practice: false },
  { id: 'base', name: 'Base', kind: 'evm', scope: 'evm', practice: false },
  { id: 'ethereum', name: 'Ethereum', kind: 'evm', scope: 'evm', practice: false },
  { id: 'arbitrum', name: 'Arbitrum', kind: 'evm', scope: 'evm', practice: false },
  { id: 'bnb', name: 'BNB Chain', kind: 'evm', scope: 'evm', practice: false },
  { id: 'sol', name: 'Solana', kind: 'sol', scope: 'sol', practice: false },
  { id: 'tron', name: 'TRON', kind: 'tron', scope: 'tron', practice: false },
  { id: 'btc-testnet', name: 'Bitcoin testnet', kind: 'utxo', scope: 'btc-testnet', practice: true },
  { id: 'base-sepolia', name: 'Base (practice)', kind: 'evm', scope: 'evm-practice', practice: true },
  { id: 'sol-devnet', name: 'Solana (practice)', kind: 'sol', scope: 'sol-practice', practice: true },
  { id: 'tron-nile', name: 'TRON (practice)', kind: 'tron', scope: 'tron-practice', practice: true },
]

const BY_ID = new Map(CONTACT_NETWORKS.map((n) => [n.id, n]))

export function contactNetwork(chainId: string): ContactNetwork | undefined {
  return BY_ID.get(chainId)
}

export interface Contact {
  id: string
  name: string
  /** canonical spelling (addrcheck.canonicalAddress) */
  address: string
  /** the chain id it was saved on */
  chain: string
  /** ms since the epoch */
  added: number
}

/** A problem the user can fix, in words for them. */
export class ContactError extends Error {}

export const CONTACT_LIMIT = 200
export const CONTACT_NAME_MAX = 32

const NAME = 'contacts'
const ID = /^[0-9a-f]{12}$/
// What a name may not hold: control, format (bidi overrides, zero-width,
// tags), private-use, surrogate and unassigned code points, the line and
// paragraph separators, everything Unicode lets a renderer ignore (Hangul
// fillers, the combining grapheme joiner, variation selectors), and the blank
// Braille pattern. Nothing a name needs, everything a spoofed one uses:
// "Alice" and "Alice" plus a filler would be two contacts that read alike
// (review 2026-11-21).
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u
/** Something to read: a letter, a digit, punctuation or a symbol. */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u
const VARIATION_16 = '\uFE0F'
const JOINER = '\u200D'

/**
 * The name without the two invisible characters emoji are built with, where
 * they are doing that job: the emoji-presentation selector right after a
 * pictograph, and the joiner between two. Anywhere else they stay, and are
 * refused with the rest.
 */
function withoutEmojiGlue(name: string): string {
  const points = [...name]
  let out = ''
  let afterPictograph = false
  for (let i = 0; i < points.length; i++) {
    const c = points[i]!
    if (c === VARIATION_16 && afterPictograph) continue
    if (c === JOINER && afterPictograph && i + 1 < points.length && PICTOGRAPH.test(points[i + 1]!)) continue
    out += c
    // a skin-tone modifier (U+1F3FB to U+1F3FF) belongs to the pictograph before it
    const point = c.codePointAt(0)!
    if (point < 0x1f3fb || point > 0x1f3ff) afterPictograph = PICTOGRAPH.test(c)
  }
  return out
}

/** The name as it is stored: one line, single spaces, NFC. Throws ContactError. */
export function cleanContactName(raw: string): string {
  if (typeof raw !== 'string') throw new ContactError('Give this contact a name.')
  const name = raw.normalize('NFC').replace(/\s+/gu, ' ').trim()
  if (name === '') throw new ContactError('Give this contact a name.')
  if ([...name].length > CONTACT_NAME_MAX) {
    throw new ContactError(`Keep the name to ${CONTACT_NAME_MAX} characters or fewer.`)
  }
  if (HIDDEN.test(withoutEmojiGlue(name)) || !VISIBLE.test(name)) {
    throw new ContactError('That name has characters that can’t be seen. Use letters, numbers and ordinary symbols.')
  }
  return name
}

/**
 * Names are compared without case, and without the emoji-presentation
 * selector: "alice" and "Alice" are one name, and so are a heart with and
 * without it.
 */
const nameKey = (name: string): string => name.split(VARIATION_16).join('').toLocaleLowerCase('en-US')

const keyOf = (net: ContactNetwork, address: string): string => `${net.scope}|${addressKey(net.kind, address)}`

const byName = (a: Contact, b: Contact): number => {
  const x = nameKey(a.name)
  const y = nameKey(b.name)
  return x < y ? -1 : x > y ? 1 : a.added - b.added
}

/** One stored record back as a Contact, or null for anything not exactly right. */
function fromStored(v: unknown): Contact | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Partial<Record<keyof Contact, unknown>>
  if (typeof r.id !== 'string' || !ID.test(r.id)) return null
  if (typeof r.chain !== 'string') return null
  const net = BY_ID.get(r.chain)
  if (net === undefined) return null
  if (typeof r.name !== 'string' || typeof r.address !== 'string') return null
  try {
    if (cleanContactName(r.name) !== r.name) return null
  } catch {
    return null
  }
  if (!isAddressOn(net.kind, net.id, r.address) || canonicalAddress(net.kind, r.address) !== r.address) return null
  if (typeof r.added !== 'number' || !Number.isSafeInteger(r.added) || r.added < 0) return null
  return { id: r.id, name: r.name, address: r.address, chain: r.chain, added: r.added }
}

interface Parsed {
  list: Contact[]
  byAddress: Map<string, Contact>
  /** differs for every object the store has handed back */
  revision: number
}

// The parsed list and its by-address index, kept for as long as the store
// keeps the object they were read from, and no longer: a lock or an erase
// clears the store's mirror, and these go with it.
const parsedOf = new WeakMap<object, Parsed>()
const EMPTY: Parsed = { list: [], byAddress: new Map(), revision: 0 }
let revisions = 0
const listeners = new Set<() => void>()
// written objects whose ciphertext the browser refused to keep
const unstored = new WeakSet<object>()

function load(): Parsed {
  const raw = secureGet(NAME)
  if (raw === null || typeof raw !== 'object') return EMPTY
  const known = parsedOf.get(raw)
  if (known !== undefined) return known
  const list: Contact[] = []
  const byAddress = new Map<string, Contact>()
  const stored = (raw as { v?: unknown; list?: unknown }).list
  if ((raw as { v?: unknown }).v === 1 && Array.isArray(stored)) {
    const ids = new Set<string>()
    const addresses = new Set<string>()
    const names = new Set<string>()
    for (const v of stored) {
      const c = fromStored(v)
      if (c === null) continue
      const net = BY_ID.get(c.chain)!
      const addr = keyOf(net, c.address)
      const name = `${net.scope}|${nameKey(c.name)}`
      // within a scope, one name per address and one address per name
      if (ids.has(c.id) || addresses.has(addr) || names.has(name)) continue
      ids.add(c.id)
      addresses.add(addr)
      names.add(name)
      list.push(c)
      byAddress.set(addr, c)
      if (list.length >= CONTACT_LIMIT) break
    }
  }
  list.sort(byName)
  const parsed: Parsed = { list, byAddress, revision: ++revisions }
  parsedOf.set(raw, parsed)
  return parsed
}

const read = (): Contact[] => load().list

const notify = (): void => {
  for (const listener of [...listeners]) listener()
}

function write(list: Contact[]): void {
  const value = { v: 1, list }
  secureSet(NAME, value)
  notify()
  // the store persists in the background and never fails out loud
  void securePersisted(NAME).then((stored) => {
    if (stored) return
    unstored.add(value)
    notify()
  })
}

/**
 * Bring this window's copy up to date with storage before changing the book:
 * another window of the wallet may have written since, and a change built on
 * the older copy would drop what it added.
 */
export async function syncContacts(): Promise<void> {
  await refreshSecure(NAME)
}

/**
 * True when this window's last change to the book did not reach storage (the
 * browser's quota is full, or it is refusing writes): the change shows for
 * now and will be gone when the wallet locks. The screens say so.
 */
export function contactsUnstored(): boolean {
  const raw = secureGet(NAME)
  return raw !== null && typeof raw === 'object' && unstored.has(raw)
}

/** Tell the UI when this window changes the book. Returns the unsubscribe. */
export function onContactsChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Changes whenever the list a read would return has changed (a lock, another window's write included). */
export function contactsRevision(): number {
  return load().revision
}

/** Every contact, by name. */
export function allContacts(): Contact[] {
  return [...read()]
}

/** The contacts a send on this chain can use: the ones of its scope, by name. */
export function contactsFor(chainId: string): Contact[] {
  const net = BY_ID.get(chainId)
  if (net === undefined) return []
  return read().filter((c) => BY_ID.get(c.chain)!.scope === net.scope)
}

/** The contact whose address is exactly this one, on this chain's scope. */
export function findContact(chainId: string, address: string | null | undefined): Contact | undefined {
  if (typeof address !== 'string' || address === '') return undefined
  const net = BY_ID.get(chainId)
  if (net === undefined) return undefined
  return load().byAddress.get(keyOf(net, address))
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const sharedWith = (net: ContactNetwork): string =>
  net.scope === 'evm' ? ' on Base, Ethereum, Arbitrum or BNB Chain' : ` on ${net.name}`

/**
 * Save a contact. The address must be a valid destination on `chain`; the
 * name and the address must both be new within that chain's scope.
 */
export function addContact(input: { name: string; address: string; chain: string }): Contact {
  const net = BY_ID.get(input.chain)
  if (net === undefined) throw new ContactError('Pick a network for this contact.')
  const name = cleanContactName(input.name)
  const typed = typeof input.address === 'string' ? input.address.trim() : ''
  if (typed === '') throw new ContactError('Enter this contact’s address.')
  if (!isAddressOn(net.kind, net.id, typed)) {
    throw new ContactError(`That isn’t a valid ${net.name} address.`)
  }
  const address = canonicalAddress(net.kind, typed)
  const list = read()
  const sameAddress = findContact(net.id, address)
  if (sameAddress !== undefined) {
    throw new ContactError(`This address is already saved as “${sameAddress.name}”.`)
  }
  const sameName = contactsFor(net.id).find((c) => nameKey(c.name) === nameKey(name))
  if (sameName !== undefined) {
    throw new ContactError(`You already have a contact called “${sameName.name}”${sharedWith(net)}. Pick another name.`)
  }
  if (list.length >= CONTACT_LIMIT) {
    throw new ContactError(`The contact book is full (${CONTACT_LIMIT}). Remove one to add another.`)
  }
  const contact: Contact = { id: newId(), name, address, chain: net.id, added: Date.now() }
  write([...list, contact])
  return contact
}

/** Give a contact another name. The address never changes: a new address is a new contact. */
export function renameContact(id: string, rawName: string): Contact {
  const list = read()
  const current = list.find((c) => c.id === id)
  if (current === undefined) throw new ContactError('That contact isn’t in the book any more.')
  const name = cleanContactName(rawName)
  const net = BY_ID.get(current.chain)!
  const sameName = contactsFor(net.id).find((c) => c.id !== id && nameKey(c.name) === nameKey(name))
  if (sameName !== undefined) {
    throw new ContactError(`You already have a contact called “${sameName.name}”${sharedWith(net)}. Pick another name.`)
  }
  const renamed = { ...current, name }
  write(list.map((c) => (c.id === id ? renamed : c)))
  return renamed
}

export function removeContact(id: string): void {
  const list = read()
  if (!list.some((c) => c.id === id)) return
  write(list.filter((c) => c.id !== id))
}
