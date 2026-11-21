import { useMemo, useState } from 'react'
import { contactNetwork, findContact } from '../lib/contacts'
import { shortAddress } from '../lib/format'
import { useContactsFor } from './useContacts'
import SaveContact from './SaveContact'
import ContactsUnstored from './ContactsUnstored'
import { IconBack, IconUser } from './Icons'

interface ContactPickerProps {
  chainId: string
  /** the network's name, as the send form says it */
  networkName: string
  /** the wallet's own send log for this chain, oldest first (sentlog.sentToAddresses) */
  sentTo: string[]
  onPick: (address: string) => void
  onClose: () => void
}

/** Rows of the send log shown before the search field is needed to find more. */
const PAID_SHOWN = 12
/** The search field appears once the two lists are longer than this. */
const SEARCH_FROM = 7

/**
 * The send form's "who to": the user's saved contacts for this network, and
 * the addresses this wallet's own send log says it has paid (which can be
 * given a name here). Picking one fills in the address, so nothing is copied
 * out of the transaction history, where a poisoner's lookalike waits.
 * Neither list is taken from the history.
 */
export default function ContactPicker({ chainId, networkName, sentTo, onPick, onClose }: ContactPickerProps) {
  const contacts = useContactsFor(chainId)
  const [query, setQuery] = useState('')
  const [naming, setNaming] = useState<string | null>(null)

  // newest first, without the ones that already have a name
  const paid = useMemo(
    () => [...sentTo].reverse().filter((a) => findContact(chainId, a) === undefined),
    // `contacts` is here because naming a paid address takes it off this list
    [sentTo, chainId, contacts],
  )

  const searchable = contacts.length + paid.length >= SEARCH_FROM
  // a filter applies only while its field is there to clear it
  const q = searchable ? query.trim().toLowerCase() : ''
  const shownContacts = q === '' ? contacts : contacts.filter((c) => c.name.toLowerCase().includes(q) || c.address.toLowerCase().includes(q))
  const matchingPaid = q === '' ? paid : paid.filter((a) => a.toLowerCase().includes(q))
  const shownPaid = matchingPaid.slice(0, PAID_SHOWN)

  return (
    <div className="stack contact-picker">
      <button type="button" className="btn btn-ghost btn-small self-start" onClick={onClose} autoFocus>
        <IconBack size={16} />
        Back
      </button>

      {searchable && (
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

      <ContactsUnstored />

      <section className="settings-section">
        <h3 className="settings-heading">Contacts</h3>
        {contacts.length === 0 ? (
          <p className="text-tertiary">
            No contacts for {networkName} yet. After you send to an address the wallet offers to save it,
            and you can add one any time under Settings.
          </p>
        ) : shownContacts.length === 0 ? (
          <p className="text-tertiary">No contact matches &ldquo;{query.trim()}&rdquo;.</p>
        ) : (
          <ul className="contact-list">
            {shownContacts.map((c) => {
              const savedOn = c.chain !== chainId ? contactNetwork(c.chain) : undefined
              return (
                <li key={c.id}>
                  <button type="button" className="contact-row" onClick={() => onPick(c.address)}>
                    <span className="contact-row-icon" aria-hidden="true">
                      <IconUser size={16} />
                    </span>
                    <span className="contact-row-main">
                      <span className="contact-row-name">{c.name}</span>
                      <span className="contact-row-addr mono" title={c.address}>
                        {shortAddress(c.address)}
                        {savedOn !== undefined && <span className="contact-tag">{savedOn.name}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {paid.length > 0 && (
        <section className="settings-section">
          <h3 className="settings-heading">Paid before</h3>
          <p className="text-tertiary">
            Addresses this wallet has sent to from this device, from its own record of its sends, not from
            your history.
          </p>
          {shownPaid.length === 0 ? (
            <p className="text-tertiary">No address matches &ldquo;{query.trim()}&rdquo;.</p>
          ) : (
            <ul className="contact-list">
              {shownPaid.map((a) => (
                <li key={a} className="contact-paid">
                  <div className="contact-paid-row">
                    <button
                      type="button"
                      className="contact-row"
                      onClick={() => onPick(a)}
                      aria-label={`Send to ${a}`}
                    >
                      <span className="contact-row-main">
                        <span className="contact-row-full mono">{a}</span>
                      </span>
                    </button>
                    {naming !== a && (
                      <button type="button" className="btn btn-ghost btn-small" onClick={() => setNaming(a)}>
                        Name it
                      </button>
                    )}
                  </div>
                  {naming === a && (
                    <SaveContact chainId={chainId} address={a} prompt="Name this address" onSaved={() => setNaming(null)} />
                  )}
                </li>
              ))}
            </ul>
          )}
          {matchingPaid.length > shownPaid.length && (
            <p className="text-tertiary">
              {matchingPaid.length - shownPaid.length} more. Search for part of an address to find one.
            </p>
          )}
        </section>
      )}
    </div>
  )
}
