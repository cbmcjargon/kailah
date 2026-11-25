// Kailah Wallet marketing site: what the demo (rob/) does. Every widget is built from
// DOM nodes and text, never from an HTML string: the site enforces Trusted
// Types, so there are no HTML sinks here. No network, no storage. The checks
// themselves live in rob-checks.js, held to the wallet's own code by
// scripts/check-sitedemo.mjs.
;(function () {
  'use strict'

  const K = window.KAILAH
  if (!K) return
  const { lookalike: L, tron: T, doge: D, madeUp, hex, randomBytes, b58checkEncode } = K
  const $ = (id) => document.getElementById(id)
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  /* ---- building blocks: elements and text nodes only ---- */

  function put(el, kids) {
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false || kid === '') continue
      el.append(kid instanceof Node ? kid : String(kid))
    }
    return el
  }
  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    return put(el, kids)
  }
  const fill = (el, ...kids) => {
    el.replaceChildren()
    return put(el, kids)
  }
  // Scroll a byte box (never the page) so its first changed run shows.
  function showChanged(box) {
    const run = box.querySelector('.is-changed')
    if (!run) {
      box.scrollTop = 0
      return
    }
    box.scrollTop += run.getBoundingClientRect().top - box.getBoundingClientRect().top - box.clientHeight / 3
  }

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('class', 'ico')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const use = document.createElementNS(NS, 'use')
    use.setAttribute('href', '#' + name)
    svg.append(use)
    return svg
  }
  const short = (a) => (a.startsWith('0x') ? a.slice(0, 6) : a.slice(0, 4)) + '…' + a.slice(-4)
  const rnd = (n) => randomBytes(4).reduce((acc, x) => acc * 256 + x, 0) % n
  const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1)
  const mono = (t) => h('span', { class: 'rb-mono' }, t)

  /* ---- sticky nav: a hairline once scrolled ---- */

  const nav = document.querySelector('[data-nav]')
  const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8)
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  /* ================================================ address poisoning */

  const P = { ack: false }
  const input = $('rb-p-input')
  const proceed = $('rb-p-continue')

  function poisonSetup(net) {
    P.net = net
    P.format = net === 'evm' ? L.EVM_FORMAT : L.SOL_FORMAT
    P.alex = madeUp[net]()
    P.own = madeUp[net]()
    P.other = madeUp[net]()
    P.fake = L.fakeOf(net, P.alex, 4, 4)
    P.known = L.knownAddresses([P.own], [P.alex, P.fake, P.other], [P.alex], [{ address: P.alex, name: 'Alex' }])
    const coin = net === 'evm' ? 'ETH' : 'SOL'
    const row = (dir, who, amount, dust) =>
      h('li', { class: 'rb-hrow' + (dust ? ' is-dust' : '') }, h('span', { class: 'rb-dir' }, dir), h('span', { class: 'rb-who' }, who), h('span', { class: 'rb-amt' }, amount))
    fill(
      $('rb-p-history'),
      row('Sent', 'Alex · ' + short(P.alex), '40 USDC', false),
      row('Received', short(P.fake), '0.000001 ' + coin, true),
      row('Received', short(P.other), '1.25 ' + coin, false),
    )
    const b = (t) => h('b', null, t)
    $('rb-p-oneend').textContent = 'A fake that copies the first ' + (net === 'evm' ? 6 : 4) + ' only'
    fill(
      $('rb-p-math'),
      net === 'evm'
        ? [
            h('span', null, 'To copy ', b('6'), ' characters at one end, a scammer tries about ', b('17 million'), ' keys. To copy ', b('4 at each end'), ', about ', b('4.3 billion'), '.'),
            h('span', null, 'So Kailah warns at 6 matching at one end, or 3 at each.'),
          ]
        : [
            h('span', null, 'To copy ', b('4'), ' characters at one end, a scammer tries ', b('millions'), ' of keys. To copy ', b('4 at each end'), ', ', b('tens of trillions'), '.'),
            h('span', null, 'So Kailah warns at 4 matching at one end, or 3 at each.'),
          ],
    )
    setInput(P.fake)
  }

  function setInput(value) {
    input.value = value
    P.ack = false
    poisonCheck()
  }

  // The warning's address view: the matching start and end marked.
  function diff(address, start, end) {
    const a = address.trim()
    const cut = Math.max(start, a.length - end)
    return h('span', { class: 'rb-diff' }, h('span', { class: 'rb-same' }, a.slice(0, start)), h('span', { class: 'rb-rest' }, a.slice(start, cut)), h('span', { class: 'rb-same' }, a.slice(cut)))
  }

  // Whom a lookalike warning names, and its headline (LookalikeWarning.tsx).
  function whomOf(match) {
    const isContact = match.relation === 'contact'
    return {
      name: isContact ? (match.name ?? 'a contact') : null,
      whom: isContact
        ? 'your contact'
        : match.relation === 'sent'
          ? 'an address you’ve sent to before'
          : match.relation === 'own'
            ? 'one of your own addresses'
            : 'another address in your history',
    }
  }
  function warningTitle(match) {
    const { name, whom } = whomOf(match)
    return h('strong', null, 'This looks like ' + whom, name ? [' ', h('bdi', null, name)] : null, ', but it’s a different address')
  }

  // The wallet's "who is this" line under an address (RecipientNote.tsx).
  function recipientNote(known) {
    const yes = (...kids) => h('p', { class: 'rb-note is-known' }, icon('i-check'), h('span', null, ...kids))
    if (known && known.relation === 'contact') return yes(h('strong', null, known.name), ' · saved contact')
    if (known && known.relation === 'own') return yes('One of your own addresses')
    if (known && known.relation === 'sent') return yes('You’ve paid this address before')
    return h('p', { class: 'rb-note' }, h('span', null, 'New address: you haven’t paid it from this device before.'))
  }

  // The wallet's own wording (LookalikeWarning.tsx, RecipientNote.tsx).
  function poisonCheck() {
    const address = input.value
    const out = $('rb-p-result')
    $('rb-p-sent').textContent = ''
    if (address.trim() === '') {
      fill(out)
      proceed.disabled = true
      return
    }
    const match = L.findLookalike(address, P.known, P.format)
    if (match) {
      const { name } = whomOf(match)
      const label = match.relation === 'contact' ? 'Your contact' : match.relation === 'sent' ? 'You sent to' : match.relation === 'own' ? 'Your own address' : 'In your history'
      const how = match.ends === 'both' ? 'start and end the same way' : match.ends === 'start' ? 'start the same way' : 'end the same way'
      const tail = match.seenIncoming
        ? ', then send you a tiny amount so theirs shows up in your history. This address sent you something.'
        : match.ends === 'both'
          ? ', hoping you won’t check the middle.'
          : ', hoping you won’t check the rest.'
      const ack = h('input', { type: 'checkbox', id: 'rb-p-ack' })
      ack.checked = P.ack
      ack.addEventListener('change', () => {
        P.ack = ack.checked
        proceed.disabled = !P.ack
      })
      fill(
        out,
        h(
          'div',
          { class: 'rb-warn' },
          icon('i-warn'),
          h(
            'div',
            { class: 'rb-warn-body' },
            h('div', null, warningTitle(match), h('p', null, 'Scammers make addresses that ' + how + ' as one you use' + tail)),
            h(
              'dl',
              { class: 'rb-pair' },
              h('dt', null, 'You entered'),
              h('dd', null, diff(address, match.sameStart, match.sameEnd)),
              h('dt', null, label),
              h('dd', null, name ? h('span', { class: 'rb-contact-name' }, name) : null, diff(match.known, match.sameStart, match.sameEnd)),
            ),
            h(
              'p',
              null,
              name
                ? ['To pay ', h('bdi', null, name), ', pick them from your contacts instead. Otherwise check the whole address with the person you’re paying.']
                : 'Check the whole address with the person you’re paying. Don’t copy it from your transaction history.',
            ),
            h('label', { class: 'rb-ack' }, ack, h('span', null, 'I’ve checked the whole address and it’s the right one')),
          ),
        ),
      )
      proceed.disabled = !P.ack
      return
    }
    proceed.disabled = false
    fill(out, recipientNote(L.findKnown(address, P.known, P.format)))
  }

  document.querySelectorAll('input[name="rb-pnet"]').forEach((r) => r.addEventListener('change', () => poisonSetup(r.value)))
  input.addEventListener('input', () => {
    P.ack = false
    poisonCheck()
  })
  $('rb-p-try').addEventListener('click', (ev) => {
    const button = ev.target.closest('[data-try]')
    if (!button) return
    const kind = button.getAttribute('data-try')
    if (kind === 'history') setInput(P.fake)
    else if (kind === 'contact') setInput(P.alex)
    else if (kind === 'oneend') setInput(L.fakeOf(P.net, P.alex, P.net === 'evm' ? 6 : 4, 0))
    else if (kind === 'three') setInput(L.fakeOf(P.net, P.alex, 3, 3))
    else setInput(madeUp[P.net]())
  })
  proceed.addEventListener('click', () => {
    $('rb-p-sent').textContent = 'In the wallet this opens the review screen. This page sends nothing.'
  })
  poisonSetup(document.querySelector('input[name="rb-pnet"]:checked').value)

  /* ================================================ the lying TRON node */

  const TR = {
    owner: madeUp.tron(),
    to: madeUp.tron(),
    thief: madeUp.tron(),
    amount: 250_000_000n,
    refBytes: Array.from(randomBytes(2)),
    refHash: Array.from(randomBytes(8)),
  }
  const EFFECT = {
    honest: '',
    recipient: 'Your 250 TRX would go to the thief.',
    amount: 'You would pay 2,500 TRX.',
    duplicate: 'A reader that stops at the first copy sees Alex. TRON uses the last copy and pays the thief.',
    approve: 'You would let the thief spend all your USDT, whenever they like.',
    relabel: 'The contract calls itself a payment but carries a USDT approval.',
    second: 'You would pay Alex and the thief.',
    permission: 'The payment would run under another permission of your account, not the one you meant.',
    expiry: 'A captured copy could be broadcast any time in the next 24 hours, long after you think it failed.',
    feelimit: 'The transaction would carry a 100 TRX fee budget that a plain payment never needs.',
    memo: 'You would sign a message you never wrote.',
    txid: 'The ID you would track is not the payment you signed.',
  }
  const CHECK_NAMES = {
    fields: 'Every field is one Kailah knows, and none appears twice',
    envelope: 'No fee budget, and it expires within 10 minutes',
    match: 'One payment, from you, to Alex, for 250 TRX',
    id: 'The transaction ID is the hash of these bytes',
  }
  const KIND = {
    owner_address: 'rb-k-owner',
    to_address: 'rb-k-to',
    amount: 'rb-k-amount',
    ref_block_bytes: 'rb-k-env',
    ref_block_hash: 'rb-k-env',
    expiration: 'rb-k-env',
    timestamp: 'rb-k-env',
  }
  const tronKind = (s) => (s.head || s.level === 'contract' || s.level === 'any' ? 'rb-k-struct' : KIND[s.name] || 'rb-k-other')
  // Fields no staged attack touches, left out of the challenge's shorter list.
  const QUIET = new Set(['ref_block_bytes', 'ref_block_hash', 'timestamp'])

  function whoIs(address) {
    if (address === TR.to) return 'Alex'
    if (address === TR.owner) return 'you'
    if (address === TR.thief) return 'the thief'
    if (address === T.USDT) return 'the USDT contract'
    return ''
  }
  // One decoded field in words. The challenge names only the USDT contract:
  // telling Alex's address from the thief's is the visitor's job there.
  function fieldText(s, now, quiz) {
    if (s.head) return null
    if (s.bytes && s.bytes.length === 21 && s.bytes[0] === 0x41) {
      const a = b58checkEncode(s.bytes)
      const who = quiz && a !== T.USDT ? '' : whoIs(a)
      return short(a) + (who ? ' (' + who + ')' : '')
    }
    const trx = (v) => (Number(v) / 1e6).toLocaleString('en-US') + ' TRX'
    switch (s.name) {
      case 'amount':
      case 'fee_limit':
        return trx(s.value)
      case 'expiration': {
        const secs = Math.round((Number(s.value) - now) / 1000)
        return secs > 7200 ? 'in ' + Math.round(secs / 3600) + ' hours' : 'in ' + secs + ' seconds'
      }
      case 'timestamp':
        return 'when the node built it'
      case 'type':
        return s.value === 1n ? '1 (payment)' : s.value === 31n ? '31 (contract call)' : String(s.value)
      case 'type_url':
        return new TextDecoder().decode(s.bytes).replace('type.googleapis.com/', '')
      case 'data (memo)':
        return JSON.stringify(new TextDecoder().decode(s.bytes))
      case 'data':
        return quiz ? 'approve(' + short(TR.thief) + ', unlimited)' : 'approve(the thief, unlimited)'
    }
    if (s.bytes) return hex(s.bytes).slice(0, 24) + (s.bytes.length > 12 ? '…' : '')
    return s.value !== undefined ? String(s.value) : ''
  }

  // Bytes as runs, one per field, coloured by kind; the node's changes outlined.
  function byteRuns(raw, spans, changed, kindOf) {
    const owner = new Array(raw.length).fill(-1)
    spans.forEach((s, i) => {
      for (let b = s.from; b < s.to && b < raw.length; b++) owner[b] = i
    })
    const runs = []
    for (let b = 0; b < raw.length; ) {
      const i = owner[b]
      let e = b
      while (e < raw.length && owner[e] === i) e++
      const s = spans[i]
      const cells = []
      for (let x = b; x < e; x++) cells.push(raw[x].toString(16).padStart(2, '0'))
      runs.push(h('span', { class: 'rb-run ' + (s ? kindOf(s) : 'rb-k-other') + (s && changed.has(i) ? ' is-changed' : ''), title: s ? s.name : null }, cells.join(' ')))
      b = e
    }
    return runs
  }

  // What the node sends back for one attack, which fields are its changes, and
  // the wallet's check of it, run as the reply arrives.
  function tronScene(attack) {
    const now = Date.now()
    const scene = { owner: TR.owner, to: TR.to, thief: TR.thief, amount: TR.amount, refBytes: TR.refBytes, refHash: TR.refHash, now, fakeId: hex(randomBytes(32)) }
    const { raw, reply } = T.stage(attack, scene)
    const honest = T.stage('honest', scene).raw
    const spans = T.annotate(raw)
    // A field is the node's change when the honest bytes hold fewer copies of it.
    const key = (bytes, s) => s.name + ':' + hex(bytes.slice(s.from, s.to))
    const count = new Map()
    T.annotate(honest).forEach((s) => {
      if (!s.head) count.set(key(honest, s), (count.get(key(honest, s)) || 0) + 1)
    })
    const changed = new Set()
    spans.forEach((s, i) => {
      if (s.head) return
      const left = count.get(key(raw, s)) || 0
      if (left > 0) count.set(key(raw, s), left - 1)
      else changed.add(i)
    })
    let err = null
    try {
      T.checkTrxSend(reply, TR.owner, TR.to, TR.amount, now)
    } catch (e) {
      err = e
    }
    return { attack, now, raw, reply, spans, changed, err }
  }

  // The decoded fields; the node's changes marked once they may be shown.
  function tronFields(d, quiz, marked) {
    const rows = []
    d.spans.forEach((s, i) => {
      if (quiz && QUIET.has(s.name)) return
      const v = fieldText(s, d.now, quiz)
      if (v === null) return
      const c = marked && d.changed.has(i) ? 'is-changed' : null
      rows.push(h('dt', { class: c }, s.name), h('dd', { class: c }, v))
    })
    const lie = marked && d.attack === 'txid' ? 'is-changed' : null
    rows.push(h('dt', { class: lie }, 'txID (claimed)'), h('dd', { class: lie }, d.reply.txID.slice(0, 24) + '…'))
    return rows
  }

  function tronVerdict(err) {
    return err
      ? h('div', { class: 'rb-verdict is-refused' }, h('b', null, 'Refused. Nothing was signed.'), h('q', null, err.message), err.why ? h('span', { class: 'rb-why' }, 'What Kailah found: ' + lowerFirst(err.why) + '.') : null)
      : h('div', { class: 'rb-verdict is-signed' }, h('b', null, 'Signed.'), h('span', null, 'These bytes pay 250 TRX to Alex, from you, and nothing else.'))
  }

  function tronRender(attack, dealt) {
    const d = dealt || tronScene(attack)
    fill($('rb-t-bytes'), byteRuns(d.raw, d.spans, d.changed, tronKind))
    showChanged($('rb-t-bytes'))
    fill($('rb-t-decoded'), tronFields(d, false, true))
    $('rb-t-effect').textContent = EFFECT[attack] ? 'If signed: ' + EFFECT[attack] : ''

    const order = ['fields', 'envelope', 'match', 'id']
    const at = d.err ? order.indexOf(d.err.check || 'fields') : order.length
    fill(
      $('rb-t-checks'),
      order.map((k, i) => {
        const st = i < at ? 'pass' : i === at ? 'fail' : 'skip'
        return h(
          'li',
          { class: 'rb-check is-' + st },
          h('span', { class: 'rb-mark', 'aria-hidden': 'true' }, st === 'pass' ? '✓' : st === 'fail' ? '✕' : '·'),
          h('span', null, CHECK_NAMES[k], h('span', { class: 'rb-sr' }, st === 'pass' ? ' (passed)' : st === 'fail' ? ' (failed)' : ' (not reached)')),
        )
      }),
    )
    fill($('rb-t-verdict'), tronVerdict(d.err))
  }

  $('rb-t-alex').textContent = TR.to
  document.querySelectorAll('input[name="rb-tatk"]').forEach((r) => r.addEventListener('change', () => tronRender(r.value)))
  tronRender(document.querySelector('input[name="rb-tatk"]:checked').value)

  /* ================================================ the lying data service */

  const KOINU = 100_000_000n
  const SIG = Array.from(randomBytes(106))
  const DG = { you: Array.from(randomBytes(20)), other: Array.from(randomBytes(20)), prev: hex(randomBytes(32)) }
  const dogeTx = (coinValue) =>
    D.legacyTx({
      prevTxid: DG.prev,
      prevVout: 1,
      scriptSig: SIG,
      outputs: [
        { value: coinValue, script: D.p2pkh(DG.you) },
        { value: 7_318n * KOINU + 40_000_000n, script: D.p2pkh(DG.other) },
      ],
    })
  DG.honest = dogeTx(2_500n * KOINU)
  DG.coinId = D.txidOfRawTx(hex(DG.honest))
  // version 4 | input count 1 | spent coin's ID 32 | its output number 4 | signature length 1 | signature 106 |
  // sequence 4 | output count 1 | amount 8 | lock length 1 | lock 25 | amount 8 | lock length 1 | lock 25 | locktime 4
  const LAYOUT = (() => {
    const parts = [
      ['version', 4, 'rb-k-env'],
      ['input count', 1, 'rb-k-env'],
      ['ID of the coin it spent', 32, 'rb-k-env'],
      ['output number of the coin it spent', 4, 'rb-k-env'],
      ['signature length', 1, 'rb-k-env'],
      ['signature', SIG.length, 'rb-k-env'],
      ['sequence', 4, 'rb-k-env'],
      ['output count', 1, 'rb-k-env'],
      ['your coin’s amount', 8, 'rb-k-amount'],
      ['lock length', 1, 'rb-k-to'],
      ['your coin’s lock', 25, 'rb-k-to'],
      ['other output’s amount', 8, 'rb-k-other'],
      ['lock length', 1, 'rb-k-other'],
      ['other output’s lock', 25, 'rb-k-other'],
      ['locktime', 4, 'rb-k-env'],
    ]
    let at = 0
    return parts.map(([name, n, kind]) => {
      const s = { name, from: at, to: at + n, kind }
      at += n
      return s
    })
  })()
  const AMOUNT = LAYOUT[8]

  // What the service sends: the true bytes, the 25 DOGE lie, or the true bytes with one bit flipped.
  function dogeServe(mode) {
    if (mode === 'truth') return { mode, served: DG.honest, flipAt: -1 }
    if (mode === 'lie') return { mode, served: dogeTx(25n * KOINU), flipAt: -1 }
    const served = DG.honest.slice()
    const flipAt = rnd(served.length)
    served[flipAt] ^= 1 << rnd(8)
    return { mode, served, flipAt }
  }
  function dogeChanged(served) {
    const changed = new Set()
    LAYOUT.forEach((s, i) => {
      for (let b = s.from; b < s.to; b++) if (served[b] !== DG.honest[b]) changed.add(i)
    })
    return changed
  }
  // What the bytes say the coin holds; `told` adds where a flipped bit sits.
  function dogeClaim(d, told) {
    let claimed = 0n
    for (let i = AMOUNT.to - 1; i >= AMOUNT.from; i--) claimed = (claimed << 8n) | BigInt(d.served[i])
    const amount = h('b', null, (Number(claimed) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' DOGE')
    const flipped = d.flipAt < 0 || !told ? null : LAYOUT.find((s) => d.flipAt >= s.from && d.flipAt < s.to)
    return flipped === null
      ? ['By these bytes, your coin holds ', amount, '.']
      : flipped === AMOUNT
        ? ['One bit flipped in byte ' + (d.flipAt + 1) + ' of ' + d.served.length + ', inside your coin’s amount. The bytes now say it holds ', amount, '.']
        : ['One bit flipped in byte ' + (d.flipAt + 1) + ' of ' + d.served.length + ' (' + flipped.name + '). The amount still reads ', amount, ', but these are no longer the same bytes.']
  }
  function dogeVerdict(same) {
    const id8 = DG.coinId.slice(0, 8) + '…'
    return same
      ? h('div', { class: 'rb-verdict is-signed' }, h('b', null, 'Kept.'), h('span', null, 'These bytes are transaction ' + id8 + ', so the amount in them is the coin’s real amount.'))
      : h('div', { class: 'rb-verdict is-refused' }, h('b', null, 'Refused. Nothing gets signed.'), h('span', null, 'These bytes aren’t transaction ' + id8 + ' at all. Kailah won’t keep them, and the signer checks the same hash again before it signs.'))
  }

  function dogeRender(mode, dealt) {
    const d = dealt || dogeServe(mode)
    fill($('rb-d-bytes'), byteRuns(d.served, LAYOUT, dogeChanged(d.served), (s) => s.kind))
    showChanged($('rb-d-bytes'))
    fill($('rb-d-claim'), dogeClaim(d, true))
    $('rb-d-again').hidden = mode !== 'flip'

    const hash = D.txidOfRawTx(hex(d.served))
    $('rb-d-coin').textContent = DG.coinId
    fill(
      $('rb-d-hash'),
      hash.split('').map((c, i) => h('span', { class: c === DG.coinId[i] ? 'rb-m' : 'rb-x' }, c)),
    )
    const same = hash === DG.coinId
    fill($('rb-d-verdict'), dogeVerdict(same))
    const b = (t, cls) => h('b', { class: cls || null }, t)
    fill(
      $('rb-d-math'),
      !same && mode === 'lie'
        ? [
            h('span', { class: 'rb-muted' }, 'If the wallet had believed it:'),
            h('span', null, 'You send ', b('20 DOGE'), '. The wallet thinks the coin holds 25, so it returns ', b('4 DOGE'), ' change and pays a ', b('1 DOGE'), ' fee.'),
            h('span', null, 'The coin really holds 2,500. The network keeps everything not paid out: a fee of ', b('2,476 DOGE', 'rb-loss'), '.'),
          ]
        : !same
          ? h('span', { class: 'rb-muted' }, 'One bit was enough to change the whole hash.')
          : h('span', { class: 'rb-muted' }, 'Bitcoin and Litecoin accounts here use segwit, where the signature covers the amount itself, so a lie there only produces a signature the network rejects.'),
    )
  }

  document.querySelectorAll('input[name="rb-dmode"]').forEach((r) => r.addEventListener('change', () => dogeRender(r.value)))
  $('rb-d-again').addEventListener('click', () => dogeRender('flip'))
  dogeRender(document.querySelector('input[name="rb-dmode"]:checked').value)

  /* ================================================ the retry (an illustration) */

  const STEPS = ['You send 100 USDC', 'No answer', 'You press Send again', 'The next block']
  const LANES = {
    naive: [
      [{ n: 41, t: '100 USDC', st: 'waiting' }],
      [{ n: 41, t: '100 USDC', st: 'waiting', q: true }],
      [{ n: 41, t: '100 USDC', st: 'waiting' }, { n: 42, t: '100 USDC, a new payment', st: 'waiting' }],
      [{ n: 41, t: '100 USDC', st: 'mined' }, { n: 42, t: '100 USDC, a new payment', st: 'mined' }],
    ],
    kailah: [
      [{ n: 41, t: '100 USDC', st: 'waiting' }],
      [{ n: 41, t: '100 USDC', st: 'waiting', q: true }],
      [{ n: 41, t: '100 USDC', st: 'waiting' }, { n: 41, t: '100 USDC, same payment, fee +10%', st: 'waiting' }],
      [{ n: 41, t: '100 USDC', st: 'void' }, { n: 41, t: '100 USDC, same payment, fee +10%', st: 'mined' }],
    ],
  }
  const STATE = { waiting: 'waiting', mined: 'in a block', void: 'replaced, can never land' }
  let step = 3
  let timer = null

  function retryRender() {
    fill(
      $('rb-r-steps'),
      STEPS.map((s, i) => h('li', { class: i === step ? 'is-on' : null, 'aria-current': i === step ? 'step' : null }, s)),
    )
    for (const lane of ['naive', 'kailah']) {
      fill(
        $('rb-r-' + lane),
        LANES[lane][step].map((a) =>
          h('li', { class: 'rb-attempt is-' + a.st }, h('span', null, h('span', { class: 'rb-n' }, 'nonce ' + a.n), ' · ' + a.t), h('span', { class: 'rb-st' }, a.q ? 'no answer' : STATE[a.st])),
        ),
      )
    }
    $('rb-r-naive-out').textContent = step === 3 ? 'You paid 200 USDC.' : ''
    $('rb-r-kailah-out').textContent = step === 3 ? 'You paid 100 USDC. The first attempt can never land now.' : ''
  }
  function playRetry() {
    clearInterval(timer)
    step = reduced.matches ? 3 : 0
    retryRender()
    if (reduced.matches) return
    timer = setInterval(() => {
      step++
      retryRender()
      if (step >= 3) clearInterval(timer)
    }, 1100)
  }
  $('rb-r-play').addEventListener('click', playRetry)
  $('rb-r-step').addEventListener('click', () => {
    clearInterval(timer)
    step = (step + 1) % STEPS.length
    retryRender()
  })
  retryRender()

  /* ================================================ the four challenges */

  // The visitor answers first; then the wallet's own checks, run on the same
  // case, say what it was. Only the first answer to each challenge is scored.
  const CHALLENGES = [
    ['poison', 'Spot a fake wallet address'],
    ['node', 'Detect a manipulated transaction'],
    ['doge', 'Identify a suspicious network response'],
    ['retry', 'Prevent a double payment'],
  ]
  const SCORE = {}

  function scoreRender() {
    const pip = (v) =>
      v === undefined
        ? h('span', { class: 'rb-pip is-none' }, h('span', { 'aria-hidden': 'true' }, '–'), h('span', { class: 'rb-sr' }, 'not answered yet'))
        : h('span', { class: 'rb-pip ' + (v ? 'is-yes' : 'is-no') }, h('span', { 'aria-hidden': 'true' }, v ? '✓' : '✕'), h('span', { class: 'rb-sr' }, v ? 'right' : 'wrong'))
    fill(
      $('rb-score'),
      h('li', { class: 'rb-score-head', 'aria-hidden': 'true' }, h('span', null, 'Challenge'), h('span', null, 'You'), h('span', null, 'Kailah')),
      CHALLENGES.map(([key, name]) => {
        const s = SCORE[key]
        return h(
          'li',
          null,
          h('span', null, name),
          h('span', null, h('span', { class: 'rb-sr' }, 'you: '), pip(s && s.you)),
          h('span', null, h('span', { class: 'rb-sr' }, 'Kailah: '), pip(s && s.kailah)),
        )
      }),
    )
    const done = CHALLENGES.filter(([key]) => key in SCORE)
    const you = done.filter(([key]) => SCORE[key].you).length
    const kailah = done.filter(([key]) => SCORE[key].kailah).length
    const all = done.length === CHALLENGES.length
    fill(
      $('rb-score-total'),
      done.length === 0
        ? 'Answer the four challenges above, and your score shows here.'
        : all
          ? ['You: ', h('b', null, you + ' of 4'), '. Kailah’s checks: ', h('b', null, kailah + ' of 4'), '.']
          : 'So far: you ' + you + ' of ' + done.length + ', Kailah’s checks ' + kailah + ' of ' + done.length + '.',
    )
    $('rb-score-note').textContent = !all
      ? ''
      : you === CHALLENGES.length
        ? 'Four for four: sharp eyes. Kailah runs the same checks on every send, so on a busy day you don’t have to.'
        : 'These attacks are built to fool people, and some can’t be seen at all: a lying transaction ID or one changed bit looks exactly like the real thing. Kailah runs these checks on every send, so you don’t have to.'
  }

  // One challenge: deal() sets up a case, judge(answer) reveals it and says
  // whether you and Kailah were right.
  function challenge(key, parts, deal, judge) {
    const buttons = [...parts.choices.querySelectorAll('[data-answer]')]
    let answered = false
    function start() {
      deal()
      answered = false
      for (const b of buttons) {
        b.removeAttribute('aria-disabled')
        b.classList.remove('is-right', 'is-wrong', 'is-off')
      }
      fill(parts.reveal)
      parts.again.hidden = true
    }
    parts.choices.addEventListener('click', (ev) => {
      const button = ev.target.closest('[data-answer]')
      if (!button || answered) return
      answered = true
      const r = judge(button.getAttribute('data-answer'))
      for (const b of buttons) {
        b.setAttribute('aria-disabled', 'true')
        b.classList.add(b === button ? (r.right ? 'is-right' : 'is-wrong') : 'is-off')
      }
      fill(
        parts.reveal,
        h('div', { class: 'rb-result ' + (r.right ? 'is-right' : 'is-wrong') }, h('p', null, h('b', null, r.right ? 'You got it.' : 'Not this time.'), ' ', r.truth), r.more ? h('p', null, r.more) : null),
        h('div', { class: 'rb-kailah' }, h('p', null, h('span', { class: 'rb-tag' }, 'Kailah'), ' ', r.kailahSays), r.kailahShows),
      )
      if (!(key in SCORE)) SCORE[key] = { you: r.right, kailah: r.kailah }
      scoreRender()
      parts.again.hidden = false
    })
    parts.again.addEventListener('click', () => {
      start()
      buttons[0].focus()
    })
    parts.box.hidden = false
    start()
  }

  // 1. A fake address: the copy in your history against your contact.
  const Q1 = {}
  function q1Pair(match) {
    const row = (label, address) => [h('dt', null, label), h('dd', null, match ? diff(address, match.sameStart, match.sameEnd) : address)]
    fill($('rb-q1-show'), row('Alex, in your contacts', Q1.alex), row('Copied from your history', Q1.shown))
  }
  challenge(
    'poison',
    { box: $('rb-q1'), choices: $('rb-q1-choices'), reveal: $('rb-q1-reveal'), again: $('rb-q1-again') },
    () => {
      Q1.alex = madeUp.sol()
      Q1.known = L.knownAddresses([], [], [Q1.alex], [{ address: Q1.alex, name: 'Alex' }])
      Q1.fake = rnd(2) === 0
      Q1.shown = Q1.fake ? L.fakeOf('sol', Q1.alex, 4, 4) : Q1.alex
      q1Pair(null)
    },
    (answer) => {
      const match = L.findLookalike(Q1.shown, Q1.known, L.SOL_FORMAT)
      q1Pair(match)
      const b = (t) => h('b', null, String(t))
      return {
        right: { same: false, fake: true }[answer] === Q1.fake,
        kailah: (match !== null) === Q1.fake,
        truth: Q1.fake ? 'It’s a fake.' : 'It’s Alex’s address, character for character.',
        more:
          Q1.fake && match
            ? ['It copies the first ', b(match.sameStart), ' and last ', b(match.sameEnd), ' characters of Alex’s, and everything between is different. Shortened the way most wallets show addresses, both read ', mono(short(Q1.alex)), '.']
            : null,
        kailahSays: match ? 'warned you before you could pay it, in the wallet’s own words:' : 'recognised your saved contact:',
        kailahShows: match ? h('div', { class: 'rb-warn rb-warn-mini' }, icon('i-warn'), warningTitle(match)) : recipientNote(L.findKnown(Q1.shown, Q1.known, L.SOL_FORMAT)),
      }
    },
  )

  // 2. A TRON reply: honest one time in three, otherwise one of the eleven attacks.
  const Q2 = {}
  challenge(
    'node',
    { box: $('rb-q2'), choices: $('rb-q2-choices'), reveal: $('rb-q2-reveal'), again: $('rb-q2-again') },
    () => {
      Q2.dealt = tronScene(rnd(3) === 0 ? 'honest' : T.ATTACKS[1 + rnd(T.ATTACKS.length - 1)])
      fill($('rb-q2-who'), 'Alex is ', mono(short(TR.to)), '. You are ', mono(short(TR.owner)), '.')
      fill($('rb-q2-fields'), tronFields(Q2.dealt, true, false))
    },
    (answer) => {
      const d = Q2.dealt
      const lied = d.attack !== 'honest'
      fill($('rb-q2-fields'), tronFields(d, true, true))
      // The demo below shows the same reply, byte by byte.
      document.getElementById('rb-tatk-' + d.attack).checked = true
      tronRender(d.attack, d)
      const trick = document.querySelector('label[for="rb-tatk-' + d.attack + '"]').textContent
      return {
        right: { sign: false, refuse: true }[answer] === lied,
        kailah: (d.err !== null) === lied,
        truth: lied ? 'The node lied.' : 'The node was honest.',
        more: lied
          ? [h('b', null, trick + '.'), ' If signed: ', EFFECT[d.attack], ' What it changed is marked above.']
          : answer === 'refuse'
            ? 'Refusing every reply is safe, but then you can’t pay anyone.'
            : null,
        kailahSays: 'decoded every byte before signing:',
        kailahShows: [tronVerdict(d.err), h('p', { class: 'rb-muted' }, 'Below, the same reply byte by byte, with each check Kailah ran.')],
      }
    },
  )

  // 3. A Dogecoin reply: the truth, the 25 DOGE lie or one flipped bit, a third each.
  const Q3 = {}
  challenge(
    'doge',
    { box: $('rb-q3'), choices: $('rb-q3-choices'), reveal: $('rb-q3-reveal'), again: $('rb-q3-again') },
    () => {
      Q3.dealt = dogeServe(['truth', 'lie', 'flip'][rnd(3)])
      fill($('rb-q3-bytes'), byteRuns(Q3.dealt.served, LAYOUT, new Set(), () => 'rb-k-plain'))
      $('rb-q3-bytes').scrollTop = 0
      fill($('rb-q3-claim'), dogeClaim(Q3.dealt, false))
    },
    (answer) => {
      const d = Q3.dealt
      const genuine = d.mode === 'truth'
      const hash = D.txidOfRawTx(hex(d.served))
      const kept = hash === DG.coinId
      fill($('rb-q3-bytes'), byteRuns(d.served, LAYOUT, dogeChanged(d.served), (s) => s.kind))
      showChanged($('rb-q3-bytes'))
      fill($('rb-q3-claim'), dogeClaim(d, true))
      // The demo below shows the same bytes.
      document.getElementById('rb-dmode-' + d.mode).checked = true
      dogeRender(d.mode, d)
      const inAmount = d.flipAt >= AMOUNT.from && d.flipAt < AMOUNT.to
      return {
        right: { trust: true, doubt: false }[answer] === genuine,
        kailah: kept === genuine,
        truth: genuine ? 'These are your coin’s real bytes.' : 'The reply was doctored.',
        more:
          d.mode === 'lie'
            ? 'It says your coin holds 25 DOGE. Believed, a 20 DOGE payment from it would hand the miners a 2,476 DOGE fee.'
            : d.mode === 'flip'
              ? inAmount
                ? 'One bit of your coin’s amount was changed.'
                : 'One bit was changed, outside the amount. Nothing you can read looks wrong.'
              : null,
        kailahSays: 'hashed the bytes and compared the result with your coin’s ID:',
        kailahShows: [
          h('dl', { class: 'rb-quiz-ids' }, h('dt', null, 'Your coin’s ID'), h('dd', null, DG.coinId.slice(0, 24) + '…'), h('dt', null, 'Hash of these bytes'), h('dd', { class: kept ? 'rb-m' : 'rb-x' }, hash.slice(0, 24) + '…')),
          dogeVerdict(kept),
        ],
      }
    },
  )

  // 4. The retry. Kailah's side is the wallet's rule, shown by the lanes below.
  const RETRY = {
    again: { safe: false, truth: 'That can pay twice.', more: 'A new payment gets the next sequence number, the nonce, so the network can take both. If the first one went through, you’ve paid 200 USDC.' },
    wait: { safe: true, truth: 'Safe.', more: 'Nothing new is signed, so nothing can pay twice. It can take a while: the first attempt may still land minutes from now.' },
    replace: { safe: true, truth: 'Safe.', more: 'The replacement reuses the first attempt’s nonce. The network accepts one payment per nonce, so only one of the two can ever land.' },
  }
  challenge(
    'retry',
    { box: $('rb-q4'), choices: $('rb-q4-choices'), reveal: $('rb-q4-reveal'), again: $('rb-q4-again') },
    () => {},
    (answer) => {
      const r = RETRY[answer]
      playRetry()
      return {
        right: r.safe,
        kailah: true,
        truth: r.truth,
        more: r.more,
        kailahSays: 'won’t sign a new payment while the first might still land. It offers the two safe ways out: wait for it, or replace it.',
        kailahShows: h('p', { class: 'rb-muted' }, 'Below, both kinds of wallet play it out.'),
      }
    },
  )

  $('score').hidden = false
  scoreRender()
})()
