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
      const isContact = match.relation === 'contact'
      const name = isContact ? (match.name ?? 'a contact') : null
      const whom = isContact
        ? 'your contact'
        : match.relation === 'sent'
          ? 'an address you’ve sent to before'
          : match.relation === 'own'
            ? 'one of your own addresses'
            : 'another address in your history'
      const label = isContact ? 'Your contact' : match.relation === 'sent' ? 'You sent to' : match.relation === 'own' ? 'Your own address' : 'In your history'
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
            h('div', null, h('strong', null, 'This looks like ' + whom, name ? [' ', h('bdi', null, name)] : null, ', but it’s a different address'), h('p', null, 'Scammers make addresses that ' + how + ' as one you use' + tail)),
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
    const known = L.findKnown(address, P.known, P.format)
    proceed.disabled = false
    if (known && known.relation === 'contact') fill(out, h('p', { class: 'rb-note is-known' }, icon('i-check'), h('span', null, h('strong', null, known.name), ' · saved contact')))
    else if (known && known.relation === 'own') fill(out, h('p', { class: 'rb-note is-known' }, icon('i-check'), h('span', null, 'One of your own addresses')))
    else if (known && known.relation === 'sent') fill(out, h('p', { class: 'rb-note is-known' }, icon('i-check'), h('span', null, 'You’ve paid this address before')))
    else fill(out, h('p', { class: 'rb-note' }, h('span', null, 'New address: you haven’t paid it from this device before.')))
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

  function whoIs(address) {
    if (address === TR.to) return 'Alex'
    if (address === TR.owner) return 'you'
    if (address === TR.thief) return 'the thief'
    if (address === T.USDT) return 'the USDT contract'
    return ''
  }
  function fieldText(s) {
    if (s.head) return null
    if (s.bytes && s.bytes.length === 21 && s.bytes[0] === 0x41) {
      const a = b58checkEncode(s.bytes)
      const who = whoIs(a)
      return short(a) + (who ? ' (' + who + ')' : '')
    }
    const trx = (v) => (Number(v) / 1e6).toLocaleString('en-US') + ' TRX'
    switch (s.name) {
      case 'amount':
      case 'fee_limit':
        return trx(s.value)
      case 'expiration': {
        const secs = Math.round((Number(s.value) - Date.now()) / 1000)
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
        return 'approve(the thief, unlimited)'
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

  function tronRender(attack) {
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
    fill($('rb-t-bytes'), byteRuns(raw, spans, changed, tronKind))
    showChanged($('rb-t-bytes'))
    const rows = []
    spans.forEach((s, i) => {
      const v = fieldText(s)
      if (v === null) return
      const c = changed.has(i) ? 'is-changed' : null
      rows.push(h('dt', { class: c }, s.name), h('dd', { class: c }, v))
    })
    const lie = attack === 'txid' ? 'is-changed' : null
    rows.push(h('dt', { class: lie }, 'txID (claimed)'), h('dd', { class: lie }, reply.txID.slice(0, 24) + '…'))
    fill($('rb-t-decoded'), rows)
    $('rb-t-effect').textContent = EFFECT[attack] ? 'If signed: ' + EFFECT[attack] : ''

    let err = null
    try {
      T.checkTrxSend(reply, TR.owner, TR.to, TR.amount, Date.now())
    } catch (e) {
      err = e
    }
    const order = ['fields', 'envelope', 'match', 'id']
    const at = err ? order.indexOf(err.check || 'fields') : order.length
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
    fill(
      $('rb-t-verdict'),
      err
        ? h('div', { class: 'rb-verdict is-refused' }, h('b', null, 'Refused. Nothing was signed.'), h('q', null, err.message), err.why ? h('span', { class: 'rb-why' }, 'What Kailah found: ' + lowerFirst(err.why) + '.') : null)
        : h('div', { class: 'rb-verdict is-signed' }, h('b', null, 'Signed.'), h('span', null, 'These bytes pay 250 TRX to Alex, from you, and nothing else.')),
    )
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

  function dogeRender(mode) {
    let served
    let flipAt = -1
    if (mode === 'truth') served = DG.honest
    else if (mode === 'lie') served = dogeTx(25n * KOINU)
    else {
      served = DG.honest.slice()
      flipAt = rnd(served.length)
      served[flipAt] ^= 1 << rnd(8)
    }
    const changed = new Set()
    LAYOUT.forEach((s, i) => {
      for (let b = s.from; b < s.to; b++) if (served[b] !== DG.honest[b]) changed.add(i)
    })
    fill($('rb-d-bytes'), byteRuns(served, LAYOUT, changed, (s) => s.kind))
    showChanged($('rb-d-bytes'))
    let claimed = 0n
    for (let i = AMOUNT.to - 1; i >= AMOUNT.from; i--) claimed = (claimed << 8n) | BigInt(served[i])
    const amount = h('b', null, (Number(claimed) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 8 }) + ' DOGE')
    const flipped = flipAt < 0 ? null : LAYOUT.find((s) => flipAt >= s.from && flipAt < s.to)
    fill(
      $('rb-d-claim'),
      flipped === null
        ? ['By these bytes, your coin holds ', amount, '.']
        : flipped === AMOUNT
          ? ['One bit flipped in byte ' + (flipAt + 1) + ' of ' + served.length + ', inside your coin’s amount. The bytes now say it holds ', amount, '.']
          : ['One bit flipped in byte ' + (flipAt + 1) + ' of ' + served.length + ' (' + flipped.name + '). The amount still reads ', amount, ', but these are no longer the same bytes.'],
    )
    $('rb-d-again').hidden = mode !== 'flip'

    const hash = D.txidOfRawTx(hex(served))
    $('rb-d-coin').textContent = DG.coinId
    fill(
      $('rb-d-hash'),
      hash.split('').map((c, i) => h('span', { class: c === DG.coinId[i] ? 'rb-m' : 'rb-x' }, c)),
    )
    const same = hash === DG.coinId
    const id8 = DG.coinId.slice(0, 8) + '…'
    fill(
      $('rb-d-verdict'),
      same
        ? h('div', { class: 'rb-verdict is-signed' }, h('b', null, 'Kept.'), h('span', null, 'These bytes are transaction ' + id8 + ', so the amount in them is the coin’s real amount.'))
        : h('div', { class: 'rb-verdict is-refused' }, h('b', null, 'Refused. Nothing gets signed.'), h('span', null, 'These bytes aren’t transaction ' + id8 + ' at all. Kailah won’t keep them, and the signer checks the same hash again before it signs.')),
    )
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
  $('rb-r-play').addEventListener('click', () => {
    clearInterval(timer)
    step = reduced.matches ? 3 : 0
    retryRender()
    if (reduced.matches) return
    timer = setInterval(() => {
      step++
      retryRender()
      if (step >= 3) clearInterval(timer)
    }, 1100)
  })
  $('rb-r-step').addEventListener('click', () => {
    clearInterval(timer)
    step = (step + 1) % STEPS.length
    retryRender()
  })
  retryRender()
})()
