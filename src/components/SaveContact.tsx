import { useState, type FormEvent } from 'react'
import {
  addContact,
  CONTACT_NAME_MAX,
  ContactError,
  contactNetwork,
  findContact,
  syncContacts,
  type Contact,
} from '../lib/contacts'
import { useContact } from './useContacts'
import ContactsUnstored from './ContactsUnstored'
import { IconCheck, IconUser } from './Icons'

interface SaveContactProps {
  chainId: string
  /** an address the wallet itself has paid, or is paying: the send form validated it */
  address: string
  /** what the offer says above the name field */
  prompt?: string
  /** what it says, before the name, when the address was a contact already */
  existingLabel?: string
  onSaved?: (contact: Contact) => void
}

/**
 * "Save this address as a contact": a name field and a button, for an address
 * the wallet's own send path vouches for (the success step of a send, or a
 * row of the send log in the picker). Once it is a contact, it says so.
 */
export default function SaveContact({ chainId, address, prompt, existingLabel, onSaved }: SaveContactProps) {
  const existing = useContact(chainId, address)
  // a contact from before this offer appeared, as opposed to one just saved in it
  const [wasContact] = useState(() => findContact(chainId, address) !== undefined)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (existing !== undefined) {
    return (
      <>
        <p className="save-contact-done" role="status">
          {wasContact ? <IconUser size={15} /> : <IconCheck size={15} />}
          <span>
            {wasContact ? (existingLabel ?? 'Your contact') : 'Saved as'}{' '}
            <strong className="recipient-name">{existing.name}</strong>
          </span>
        </p>
        {!wasContact && <ContactsUnstored />}
      </>
    )
  }

  const net = contactNetwork(chainId)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    // another window of the wallet may have changed the book: build on its copy
    void syncContacts()
      .then(() => {
        const saved = addContact({ name, address, chain: chainId })
        setError(null)
        onSaved?.(saved)
      })
      .catch((err: unknown) => {
        setError(err instanceof ContactError ? err.message : 'Couldn’t save this contact.')
      })
      .finally(() => setBusy(false))
  }

  return (
    <form className="save-contact" onSubmit={submit} noValidate>
      <label className="field">
        <span className="save-contact-prompt">
          <IconUser size={15} />
          {prompt ?? 'Save this address as a contact'}
        </span>
        <div className="save-contact-row">
          <input
            type="text"
            className={`input ${error !== null ? 'input-invalid' : ''}`}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            maxLength={CONTACT_NAME_MAX * 2}
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            placeholder="Name, e.g. Alice"
            aria-label="Contact name"
          />
          <button type="submit" className="btn btn-secondary" disabled={name.trim() === '' || busy}>
            Save
          </button>
        </div>
      </label>
      {error !== null && (
        <span className="field-hint field-hint-error" role="alert">
          {error}
        </span>
      )}
      {error === null && net?.kind === 'utxo' && (
        <span className="field-hint">
          Worth saving only if they use this address again: many {net.name} wallets give out a new one for
          each payment.
        </span>
      )}
    </form>
  )
}
