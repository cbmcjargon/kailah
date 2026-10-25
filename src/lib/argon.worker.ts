// Argon2id in a dedicated worker. One uninterrupted task off the main thread:
// the unlock/save UI stays responsive, and — unlike the main-thread async
// variant, which yields via setTimeout — it is immune to the timer throttling
// browsers apply to background pages (a user who hops to their password
// manager mid-unlock would otherwise watch a one-second hash take minutes).

import { argon2id } from '@noble/hashes/argon2'

export interface ArgonJob {
  password: string
  salt: Uint8Array
  m: number
  t: number
  p: number
}

export type ArgonReply = { type: 'progress'; value: number } | { type: 'done'; key: Uint8Array }

interface WorkerScope {
  onmessage: ((e: MessageEvent<ArgonJob>) => void) | null
  postMessage(msg: ArgonReply, transfer?: Transferable[]): void
}

const scope = globalThis as unknown as WorkerScope
scope.onmessage = (e) => {
  const { password, salt, m, t, p } = e.data
  const key = argon2id(password, salt, {
    m,
    t,
    p,
    dkLen: 32,
    onProgress: (value) => scope.postMessage({ type: 'progress', value }),
  })
  // Transfer (not copy) the buffer so no key bytes linger in the worker.
  scope.postMessage({ type: 'done', key }, [key.buffer])
}
