// React's view of the contact book (lib/contacts.ts): components re-read it
// when this window changes it, and on the next render after a lock, an
// unlock or another window's write.
import { useMemo, useSyncExternalStore } from 'react'
import {
  allContacts,
  contactsFor,
  contactsRevision,
  contactsUnstored,
  findContact,
  onContactsChange,
  type Contact,
} from '../lib/contacts'

// The revision is the dependency: it changes exactly when a read would differ.
function useContactsRevision(): number {
  return useSyncExternalStore(onContactsChange, contactsRevision, contactsRevision)
}

/** Every contact, by name. */
export function useAllContacts(): Contact[] {
  const revision = useContactsRevision()
  return useMemo(() => allContacts(), [revision])
}

/** The contacts a send on this chain can use. */
export function useContactsFor(chainId: string): Contact[] {
  const revision = useContactsRevision()
  return useMemo(() => contactsFor(chainId), [revision, chainId])
}

/** The contact whose address is exactly this one, if any. */
export function useContact(chainId: string, address: string | null | undefined): Contact | undefined {
  const revision = useContactsRevision()
  return useMemo(() => findContact(chainId, address), [revision, chainId, address])
}

/** True while this window's last change to the book hasn't reached storage (the browser refused it). */
export function useContactsUnstored(): boolean {
  return useSyncExternalStore(onContactsChange, contactsUnstored, contactsUnstored)
}
