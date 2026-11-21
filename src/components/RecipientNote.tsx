import { useMemo } from 'react'
import { findKnown, type AddressFormat, type KnownAddress } from '../lib/lookalike'
import { addressKey } from '../lib/addrcheck'
import { CONTACT_NETWORKS, contactNetwork } from '../lib/contacts'
import { sentToAddresses } from '../lib/sentlog'
import { useContact } from './useContacts'
import { IconCheck, IconUser } from './Icons'

interface RecipientNoteProps {
  chainId: string
  /** the network's name, for a contact saved on another network of the same kind */
  networkName: string
  /** a valid destination, trimmed */
  address: string
  /** the form's known addresses (lookalike.knownAddresses) */
  known: KnownAddress[]
  format: AddressFormat
}

/**
 * One line under a send form's address: who this is, as far as the wallet
 * itself knows. A saved contact by name, one of the account's own addresses,
 * an address the wallet's send log says it has paid, or a new one. It speaks
 * for trusted sources only (lookalike.findKnown): an address that merely
 * appears in the history is "new", because the history is someone else's word.
 * A 0x address the wallet has paid on another network of the same kind is
 * new on this one, and the line says where it was paid. Shown when the
 * lookalike check has nothing to say.
 */
export default function RecipientNote({ chainId, networkName, address, known, format }: RecipientNoteProps) {
  const match = useMemo(() => findKnown(address, known, format), [address, known, format])
  const contact = useContact(chainId, address)
  // not known here, but in the send log of another network that shares these addresses
  const paidOn = useMemo(() => {
    if (match !== null) return undefined
    const net = contactNetwork(chainId)
    if (net === undefined) return undefined
    const key = addressKey(net.kind, address)
    return CONTACT_NETWORKS.find(
      (n) => n.scope === net.scope && n.id !== chainId && sentToAddresses(n.id).some((a) => addressKey(net.kind, a) === key),
    )
  }, [match, chainId, address])

  if (match?.relation === 'contact') {
    const savedOn = contact !== undefined && contact.chain !== chainId ? contactNetwork(contact.chain) : undefined
    return (
      <div className="recipient-note recipient-note-known" role="status">
        <IconUser size={15} />
        <span>
          <strong className="recipient-name">{match.name ?? contact?.name}</strong> · saved contact
          {savedOn !== undefined && (
            <span className="recipient-note-more">
              Saved on {savedOn.name}. If this is an exchange&rsquo;s deposit address or a smart-contract
              wallet, check that it works on {networkName} too.
            </span>
          )}
        </span>
      </div>
    )
  }
  if (match?.relation === 'own') {
    return (
      <div className="recipient-note recipient-note-known" role="status">
        <IconCheck size={15} />
        <span>One of your own addresses</span>
      </div>
    )
  }
  if (match?.relation === 'sent') {
    return (
      <div className="recipient-note recipient-note-known" role="status">
        <IconCheck size={15} />
        <span>You&rsquo;ve paid this address before</span>
      </div>
    )
  }
  if (paidOn !== undefined) {
    return (
      <div className="recipient-note" role="status">
        <span>
          You&rsquo;ve paid this address on {paidOn.name}, but not on {networkName} yet. If it is an
          exchange&rsquo;s deposit address or a smart-contract wallet, check that it works on {networkName}{' '}
          too.
        </span>
      </div>
    )
  }
  return (
    <div className="recipient-note" role="status">
      <span>New address: you haven&rsquo;t paid it from this device before.</span>
    </div>
  )
}
