import { useContact } from './useContacts'

interface ContactNameProps {
  chainId: string
  address: string | null | undefined
  /** text before the name, e.g. "to " */
  prefix?: string
  className?: string
}

/**
 * The saved contact's name for exactly this address, or nothing. A lookalike
 * of a contact's address is another address, so it gets no name: in a list
 * of payments, the real ones carry the name and a poisoner's dust doesn't.
 *
 * Activity uses it on payments this wallet SENT only. Who a payment came
 * from is another's word: a token's contract writes the "from" of its own
 * transfers, and a zero-value transferFrom puts any address there, so a scam
 * airdrop could otherwise arrive "from Alice" under the user's own label
 * (review 2026-11-21). For the same reason it is never used on a token the
 * wallet doesn't vouch for.
 */
export default function ContactName({ chainId, address, prefix, className }: ContactNameProps) {
  const contact = useContact(chainId, address)
  if (contact === undefined) return null
  return (
    <span className={className ?? 'contact-name'} title={contact.name}>
      {prefix}
      {contact.name}
    </span>
  )
}
