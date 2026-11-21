import { useContactsUnstored } from './useContacts'
import { IconWarning } from './Icons'

/**
 * Shown where contacts are changed, when the browser refused to store the
 * last change (its storage is full, or it is refusing writes): the change is
 * on screen but will not survive a lock. Saying "saved" and losing it would
 * be worse than saying so.
 */
export default function ContactsUnstored() {
  const unstored = useContactsUnstored()
  if (!unstored) return null
  return (
    <div className="warning-box" role="alert">
      <IconWarning size={20} />
      <div>
        <strong>This browser didn&rsquo;t store that change</strong>
        <p>
          It shows for now, but it will be gone when the wallet locks. The browser&rsquo;s storage for
          this wallet is full or switched off. Free some space, then save the contact again.
        </p>
      </div>
    </div>
  )
}
