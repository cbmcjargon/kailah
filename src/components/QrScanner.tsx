// Camera QR scanner. Prefers the native BarcodeDetector API and falls back
// to jsQR frame-grabbing. The parent owns interpretation of decoded text:
// onDecoded returns null when a code is accepted (parent closes the scanner)
// or a user-readable error message, which is shown in an overlay strip while
// scanning continues.
import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

// BarcodeDetector is not in TS's dom lib yet — declare the minimal surface.
interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>
}
interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

interface QrScannerProps {
  /** returns null when the scan was accepted, else an error message to show */
  onDecoded: (text: string) => string | null
  onClose: () => void
}

/** longest canvas side for the jsQR fallback — decoding is O(pixels) */
const MAX_DECODE_SIDE = 640
/** ms between decode attempts */
const DECODE_INTERVAL_MS = 200
/** ms an identical decoded text is ignored after being handled */
const REPEAT_DEBOUNCE_MS = 2000
/** ms a parent rejection message stays visible */
const REJECT_VISIBLE_MS = 3000

function cameraErrorMessage(e: unknown): string {
  const name =
    typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : ''
  if (name === 'NotAllowedError') {
    return 'Camera access was denied. Allow the camera for this site, or paste the address instead.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device.'
  }
  return 'The camera could not be started. Close this and paste the address instead.'
}

export default function QrScanner({ onDecoded, onClose }: QrScannerProps) {
  const [camError, setCamError] = useState<string | null>(null)
  const [rejectMsg, setRejectMsg] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)

  // Latest callback without re-running the camera effect on parent re-renders.
  const onDecodedRef = useRef(onDecoded)
  onDecodedRef.current = onDecoded

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let intervalId: number | null = null
    let rejectTimer: number | null = null
    let canvas: HTMLCanvasElement | null = null
    let detectBusy = false
    let accepted = false
    let lastText = ''
    let lastTextAt = 0

    const stopAll = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId)
        intervalId = null
      }
      if (rejectTimer !== null) {
        window.clearTimeout(rejectTimer)
        rejectTimer = null
      }
      if (stream !== null) {
        for (const track of stream.getTracks()) track.stop()
        stream = null
      }
      const video = videoRef.current
      if (video) video.srcObject = null
    }

    const handleText = (text: string) => {
      if (cancelled || accepted || text === '') return
      const now = Date.now()
      if (text === lastText && now - lastTextAt < REPEAT_DEBOUNCE_MS) return
      lastText = text
      lastTextAt = now
      const err = onDecodedRef.current(text)
      if (err === null) {
        // Parent accepted and will unmount us; stop the camera immediately.
        accepted = true
        stopAll()
      } else {
        setRejectMsg(err)
        if (rejectTimer !== null) window.clearTimeout(rejectTimer)
        rejectTimer = window.setTimeout(() => {
          rejectTimer = null
          setRejectMsg(null)
        }, REJECT_VISIBLE_MS)
      }
    }

    const tick = (detector: BarcodeDetectorLike | null) => {
      const video = videoRef.current
      if (cancelled || accepted || !video) return
      if (video.readyState < video.HAVE_CURRENT_DATA) return

      if (detector !== null) {
        if (detectBusy) return
        detectBusy = true
        try {
          detector
            .detect(video)
            .then((codes) => {
              const raw = codes[0]?.rawValue
              if (raw !== undefined) handleText(raw)
            })
            .catch(() => {
              // Transient detector failures: keep scanning.
            })
            .finally(() => {
              detectBusy = false
            })
        } catch {
          detectBusy = false
        }
        return
      }

      // jsQR fallback: grab the current frame, capped for performance.
      const vw = video.videoWidth
      const vh = video.videoHeight
      if (vw === 0 || vh === 0) return
      const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(vw, vh))
      const w = Math.max(1, Math.round(vw * scale))
      const h = Math.max(1, Math.round(vh * scale))
      if (canvas === null) canvas = document.createElement('canvas')
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx === null) return
      let image: ImageData
      try {
        ctx.drawImage(video, 0, 0, w, h)
        image = ctx.getImageData(0, 0, w, h)
      } catch {
        return
      }
      const code = jsQR(image.data, w, h, { inversionAttempts: 'dontInvert' })
      if (code !== null) handleText(code.data)
    }

    const start = async () => {
      const media = navigator.mediaDevices as MediaDevices | undefined
      if (!window.isSecureContext || media === undefined || typeof media.getUserMedia !== 'function') {
        setCamError('Scanning needs a secure (https) connection.')
        return
      }

      let acquired: MediaStream
      try {
        acquired = await media.getUserMedia({ video: { facingMode: 'environment' } })
      } catch (e) {
        if (!cancelled) setCamError(cameraErrorMessage(e))
        return
      }
      if (cancelled) {
        // Unmounted while the permission prompt was open.
        for (const track of acquired.getTracks()) track.stop()
        return
      }
      stream = acquired
      const video = videoRef.current
      if (video) {
        video.srcObject = acquired
        // autoplay + playsInline usually suffice; play() covers the rest.
        video.play().catch(() => {})
      }

      // Prefer the native detector when it supports QR codes.
      let detector: BarcodeDetectorLike | null = null
      const Detector = (window as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
      if (Detector !== undefined) {
        try {
          const formats = await Detector.getSupportedFormats()
          if (formats.includes('qr_code')) detector = new Detector({ formats: ['qr_code'] })
        } catch {
          detector = null
        }
      }
      if (cancelled) {
        // Unmounted during the await above — tracks are stopped by cleanup,
        // but make sure no interval ever starts.
        return
      }
      intervalId = window.setInterval(() => tick(detector), DECODE_INTERVAL_MS)
    }

    void start()

    return () => {
      cancelled = true
      stopAll()
    }
  }, [])

  if (camError !== null) {
    return (
      <div className="qr-scanner">
        <div className="qr-cam-error" role="alert">
          <p>{camError}</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Close
        </button>
      </div>
    )
  }

  return (
    <div className="qr-scanner">
      <div className="qr-viewport">
        <video ref={videoRef} className="qr-video" playsInline muted autoPlay />
        <div className="qr-scan-frame" aria-hidden="true">
          <span className="qr-corner qr-corner-tl" />
          <span className="qr-corner qr-corner-tr" />
          <span className="qr-corner qr-corner-bl" />
          <span className="qr-corner qr-corner-br" />
        </div>
        {rejectMsg !== null && (
          <div className="qr-reject" role="alert">
            {rejectMsg}
          </div>
        )}
      </div>
      <p className="qr-status">Point the camera at a payment QR code</p>
      <button type="button" className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
    </div>
  )
}
