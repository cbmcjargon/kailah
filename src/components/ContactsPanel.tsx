import { useMemo, useState, type FormEvent } from 'react'
import type { NetMode } from '../lib/types'
import { isAddressOn, type AddressKind } from '../lib/addrcheck'
import {
  addContact,
  CONTACT_LIMIT,
  CONTACT_NAME_MAX,
  CONTACT_NETWORKS,
  ContactError,
  contactNetwork,
  findContact,
  removeContact,
  renameContact,
  syncContacts,
  type Contact,
} from '../lib/contacts'
import {
  EVM_FORMAT,
  findKnown,
  knownAddresses,
  SOL_FORMAT,
  TRON_FORMAT,
  UTXO_FORMAT,
  type AddressFormat,
} from '../lib/lookalike'
import { sentToAddresses } from '../lib/sentlog'
import LookalikeWarning, { useLookalike } from './LookalikeWarning'
import CopyButton from './CopyButton'
import { useAllContacts } from './useContacts'
import ContactsUnstored from './ContactsUnstored'
import { IconPlus } from './Icons'

interface ContactsPanelProps {
  mode: NetMode
  /**
   * This wallet's own addresses and its history counterparties on every
   * network of a chain's contact scope: what a send form would check a typed
   * address against, beside the book and the send log.
   */
  knownFor: (chainId: string) => { own: string[]; counterparties: (string | null)[] }
}

const FORMATS: Record<AddressKind, AddressFormat> = {
  utxo: UTXO_FORMAT,
  evm: EVM_FORMAT,
  sol: SOL_FORMAT,
  tron: TRON_FORMAT,
}

/** The search field appears once the list is longer than this. */
const SEARCH_FROM = 8

const listNames = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('')

/**
 * Settings → Contacts: the book for the current mode. Add a contact by
 * pasting its address, rename one, remove one. The network is worked out
 * from the address where it can be. Before a pasted address is saved, the
 * lookalike check runs against everything a send form would use: the
 * contacts, the send log, this wallet's own addresses and its history. A
 * contact is trusted from then on, so this is the one place a lookalike has
 * to be caught. Practice contacts show in practice mode only (contacts.ts,
 * "Scope").
 */
export default function ContactsPanel({ mode, knownFor }: ContactsPanelProps) {
  const practice = mode === 'practice'
  const nets = useMemo(() => CONTACT_NETWORKS.filter((n) => n.practice === practice), [practice])
  const others = useMemo(() => CONTACT_NETWORKS.filter((n) => n.practice !== practice), [practice])
  const all = useAllContacts()
  const contacts = useMemo(
    () => all.filter((c) => contactNetwork(c.chain)?.practice === practice),
    [all, practice],
  )

  const [chain, setChain] = useState<string>(nets[0]!.id)
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [autoNote, setAutoNote] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string; error: string | null } | null>(null)
  // removing takes a second tap on the same row
  const [armedRemove, setArmedRemove] = useState<string | null>(null)
  // one change at a time: each first brings the book up to date with storage
  const [busy, setBusy] = useState(false)
  const change = (act: () => void, failed: (message: string) => void, fallback: string) => {
    if (busy) return
    setBusy(true)
    // another window of the wallet may have changed the book: build on its copy
    void syncContacts()
      .then(act)
      .catch((err: unknown) => failed(err instanceof ContactError ? err.message : fallback))
      .finally(() => setBusy(false))
  }

  // always a network of this mode, whatever the mode was when it was picked
  const net = nets.find((n) => n.id === chain) ?? nets[0]!
  const typed = address.trim()
  const valid = typed !== '' && isAddressOn(net.kind, net.id, typed)
  const duplicate = valid ? findContact(net.id, typed) : undefined

  // what the address must not be mistaken for: the contacts it would sit
  // beside, this wallet's own addresses, what it has paid on those networks,
  // and everyone in its history there
  const known = useMemo(() => {
    const scope = CONTACT_NETWORKS.filter((n) => n.scope === net.scope)
    const inScope = contacts.filter((c) => contactNetwork(c.chain)?.scope === net.scope)
    const { own, counterparties } = knownFor(net.id)
    return knownAddresses(own, counterparties, scope.flatMap((n) => sentToAddresses(n.id)), inScope)
  }, [contacts, net.id, net.scope, knownFor])
  const lookalike = useLookalike(valid ? typed : '', known, FORMATS[net.kind])
  // how the wallet already knows it, when it does: its own, or one it has paid
  const already = valid && duplicate === undefined ? findKnown(typed, known, FORMATS[net.kind]) : null

  // why an address that isn't valid on the chosen network isn't: it is one of
  // another network of this mode, or, failing that, of the other mode only
  const fitsHere = typed !== '' && !valid ? nets.filter((n) => isAddressOn(n.kind, n.id, typed)) : []
  const elsewhere =
    typed !== '' && !valid && fitsHere.length === 0 ? others.find((n) => isAddressOn(n.kind, n.id, typed)) : undefined

  const onAddress = (value: string) => {
    setAddress(value)
    setError(null)
    setSavedName(null)
    setAutoNote(null)
    const next = value.trim()
    if (next === '') return
    // the address says which network it is for: set it, and say so
    const fits = nets.filter((n) => isAddressOn(n.kind, n.id, next))
    if (fits.length === 0 || fits.some((n) => n.id === chain)) return
    setChain(fits[0]!.id)
    setAutoNote(
      fits.length === 1
        ? `That’s a ${fits[0]!.name} address, so the network was set to ${fits[0]!.name}.`
        : `That address works on ${listNames(fits.map((n) => n.name))}. Pick the one you’ll pay it on.`,
    )
  }

  const full = all.length >= CONTACT_LIMIT
  const canSave = valid && duplicate === undefined && name.trim() !== '' && lookalike.ok && !full

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!canSave) return
    change(
      () => {
        const saved = addContact({ name, address: typed, chain: net.id })
        setAddress('')
        setName('')
        setError(null)
        setAutoNote(null)
        setSavedName(saved.name)
      },
      setError,
      'Couldn’t save this contact.',
    )
  }

  const submitRename = (e: FormEvent) => {
    e.preventDefault()
    if (renaming === null) return
    const { id, name: newName } = renaming
    change(
      () => {
        renameContact(id, newName)
        setRenaming(null)
      },
      (message) => setRenaming({ id, name: newName, error: message }),
      'Couldn’t rename this contact.',
    )
  }

  const remove = (id: string) => {
    setArmedRemove(null)
    change(() => removeContact(id), setError, 'Couldn’t remove this contact.')
  }

  // a filter applies only while its field is there to clear it
  const q = contacts.length >= SEARCH_FROM ? query.trim().toLowerCase() : ''
  const shown = q === '' ? contacts : contacts.filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
  const evmNames = listNames(nets.filter((n) => n.kind === 'evm').map((n) => n.name))

  return (
    <div className="stack">
      <form className="stack contact-add" onSubmit={submit} noValidate>
        <h3 className="settings-heading">Add a contact</h3>
        <label className="field">
          <span className="field-label">Address</span>
          <input
            type="text"
            className={`input mono ${typed !== '' && !valid ? 'input-invalid' : ''}`}
            value={address}
            onChange={(e) => onAddress(e.target.value)}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Paste the address"
          />
          {typed !== '' && !valid && (
            <span className="field-hint field-hint-error">
              {fitsHere.length > 0
                ? `That’s a ${fitsHere.length > 1 ? `${listNames(fitsHere.slice(0, -1).map((n) => n.name))} or ${fitsHere[fitsHere.length - 1]!.name}` : fitsHere[0]!.name} address, not a ${net.name} one. Change the network below.`
                : elsewhere !== undefined
                  ? `That’s a ${elsewhere.name} address. Switch to ${practice ? 'real' : 'practice'} mode to save it.`
                  : `Not a valid ${net.name} address.`}
            </span>
          )}
          {autoNote !== null && valid && <span className="field-hint">{autoNote}</span>}
          {duplicate !== undefined && (
            <span className="field-hint field-hint-error">Already saved as “{duplicate.name}”.</span>
          )}
          {already?.relation === 'own' && <span className="field-hint">This is one of your own addresses.</span>}
          {already?.relation === 'sent' && (
            <span className="field-hint">You&rsquo;ve paid this address before from this device.</span>
          )}
        </label>

        <label className="field">
          <span className="field-label">Network</span>
          <select
            className="input select"
            value={net.id}
            onChange={(e) => {
              setChain(e.target.value)
              setAutoNote(null)
              setError(null)
            }}
          >
            {nets.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>

        {lookalike.match !== null && (
          <LookalikeWarning
            address={typed}
            match={lookalike.match}
            checked={lookalike.checked}
            onCheckedChange={lookalike.setChecked}
          />
        )}

        <label className="field">
          <span className="field-label">Name</span>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
              setSavedName(null)
            }}
            maxLength={CONTACT_NAME_MAX * 2}
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            placeholder="e.g. Alice, or My exchange account"
          />
        </label>

        {error !== null && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {full && (
          <p className="form-error" role="status">
            The contact book is full ({CONTACT_LIMIT}). Remove one to add another.
          </p>
        )}
        {savedName !== null && (
          <p className="text-secondary" role="status">
            Saved {savedName}.
          </p>
        )}

        <button type="submit" className="btn btn-primary" disabled={!canSave || busy}>
          <IconPlus size={17} />
          Save contact
        </button>
        <p className="text-tertiary">
          Get the address from the person you&rsquo;re paying, not from your transaction history: scammers
          plant lookalike addresses there.
          {net.kind === 'utxo' &&
            ` A ${net.name} contact is worth saving only if they use this address again: many wallets give out a new one for each payment.`}
        </p>
      </form>

      <ContactsUnstored />

      <section className="settings-section">
        <h3 className="settings-heading">
          {practice ? 'Practice contacts' : 'Your contacts'}
          {contacts.length > 0 ? ` · ${contacts.length}` : ''}
        </h3>
        {contacts.length >= SEARCH_FROM && (
          <input
            type="search"
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Search names and addresses"
            aria-label="Search contacts"
          />
        )}
        {contacts.length === 0 ? (
          <p className="text-tertiary">
            None yet. Add one above, or send to an address and save it when the wallet offers.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-tertiary">No contact matches &ldquo;{query.trim()}&rdquo;.</p>
        ) : (
          <ul className="contact-list">
            {shown.map((c: Contact) => (
              <li key={c.id} className="contact-item">
                {renaming?.id === c.id ? (
                  <form className="save-contact" onSubmit={submitRename} noValidate>
                    <div className="save-contact-row">
                      <input
                        type="text"
                        className={`input ${renaming.error !== null ? 'input-invalid' : ''}`}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: c.id, name: e.target.value, error: null })}
                        maxLength={CONTACT_NAME_MAX * 2}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`New name for ${c.name}`}
                        autoFocus
                      />
                      <button type="submit" className="btn btn-secondary" disabled={renaming.name.trim() === ''}>
                        Save
                      </button>
                      <button type="button" className="btn btn-ghost" onClick={() => setRenaming(null)}>
                        Cancel
                      </button>
                    </div>
                    {renaming.error !== null && (
                      <span className="field-hint field-hint-error" role="alert">
                        {renaming.error}
                      </span>
                    )}
                  </form>
                ) : (
                  <div className="contact-item-head">
                    <span className="contact-item-name" title={c.name}>
                      {c.name}
                    </span>
                    <span className="contact-tag">{contactNetwork(c.chain)?.name}</span>
                  </div>
                )}
                <div className="contact-item-addr">
                  <span className="mono contact-row-full">{c.address}</span>
                  <CopyButton text={c.address} label={`Copy the address of ${c.name}`} />
                </div>
                {renaming?.id !== c.id && (
                  <div className="contact-item-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-small"
                      onClick={() => {
                        setArmedRemove(null)
                        setRenaming({ id: c.id, name: c.name, error: null })
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      className={`btn btn-ghost btn-small ${armedRemove === c.id ? 'contact-remove-armed' : ''}`}
                      onClick={() => {
                        if (armedRemove === c.id) remove(c.id)
                        else setArmedRemove(c.id)
                      }}
                    >
                      {armedRemove === c.id ? 'Tap again to remove' : 'Remove'}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-tertiary">
        A contact is an address you checked once, under a name you chose. Send forms offer your contacts,
        show the name beside the address, and warn when an address only looks like one of them. Only you
        can add a contact: here, after a send, or by naming an address this wallet has already paid.
        Nothing is ever added from your transaction history.
      </p>
      {evmNames !== '' && nets.filter((n) => n.kind === 'evm').length > 1 && (
        <p className="text-tertiary">
          An ordinary 0x address is the same account on {evmNames}, so one contact covers all of them. An
          exchange&rsquo;s deposit address or a smart-contract wallet may work on one network only, so the
          wallet remembers which one you saved it on and says so when you use it on another.
        </p>
      )}
      <p className="text-tertiary">
        Contacts are kept encrypted on this device and are erased with the wallet. They don&rsquo;t come
        back when you restore your recovery phrase on another device.{' '}
        {practice
          ? 'Practice contacts show in practice mode only.'
          : 'Contacts saved in practice mode are kept apart and show there only.'}
      </p>
    </div>
  )
}
