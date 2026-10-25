import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconCopy } from './Icons'

interface CopyButtonProps {
  text: string
  label: string
  /** render as a small text button instead of an icon button */
  withText?: boolean
  className?: string
}

// navigator.clipboard is undefined on non-secure contexts (e.g. the PWA served
// over plain http on a LAN address), so the modern API needs a guard and a
// legacy textarea/execCommand fallback.
function legacyCopy(value: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = value
  ta.setAttribute('readonly', '')
  ta.style.position = 'absolute'
  ta.style.left = '-9999px'
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(ta)
  return ok
}

/** Copies `text` to the clipboard with transient "copied" / "couldn't copy" states. */
export default function CopyButton({ text, label, withText, className }: CopyButtonProps) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = async () => {
    let ok = false
    try {
      if (navigator.clipboard !== undefined) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) ok = legacyCopy(text)
    setState(ok ? 'copied' : 'failed')
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setState('idle'), 1600)
  }

  const copied = state === 'copied'
  const feedback = copied ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : null

  if (withText) {
    return (
      <button
        type="button"
        className={`btn btn-ghost btn-small ${className ?? ''}`}
        onClick={() => void copy()}
        aria-label={feedback ?? label}
      >
        {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
        <span>{feedback ?? 'Copy'}</span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className={`icon-btn icon-btn-small ${copied ? 'is-copied' : ''} ${className ?? ''}`}
      onClick={() => void copy()}
      aria-label={feedback ?? label}
      title={feedback ?? label}
    >
      {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
    </button>
  )
}
