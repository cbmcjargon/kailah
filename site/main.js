// Kailah Wallet marketing site: the little behaviour the page has.
// No network, no storage, no third parties, and no HTML sinks (the page ships
// with Trusted Types enforced, like the wallet). Everything here degrades to
// a static page when JavaScript is off.
;(function () {
  'use strict'

  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)')

  /* ---- sticky nav: hairline once scrolled, a disclosure menu on phones ---- */

  var nav = document.querySelector('[data-nav]')
  var toggle = document.querySelector('[data-nav-toggle]')
  var menu = document.getElementById('nav-menu')

  function onScroll() {
    if (nav) nav.classList.toggle('is-scrolled', window.scrollY > 8)
  }
  window.addEventListener('scroll', onScroll, { passive: true })
  onScroll()

  function closeMenu() {
    if (!menu || !toggle) return
    menu.classList.remove('is-open')
    toggle.setAttribute('aria-expanded', 'false')
  }

  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var open = !menu.classList.contains('is-open')
      menu.classList.toggle('is-open', open)
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
    menu.addEventListener('click', function (ev) {
      if (ev.target && ev.target.closest('a')) closeMenu()
    })
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeMenu()
    })
    document.addEventListener('click', function (ev) {
      if (!nav || nav.contains(ev.target)) return
      closeMenu()
    })
  }

  /* ---- which section is on screen → the matching nav link ---- */

  var links = Array.prototype.slice.call(document.querySelectorAll('.nav-links a[href^="#"]'))
  var sections = links
    .map(function (a) {
      return document.getElementById(a.getAttribute('href').slice(1))
    })
    .filter(Boolean)

  if ('IntersectionObserver' in window && sections.length) {
    var current = null
    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) current = e.target.id
        })
        links.forEach(function (a) {
          a.classList.toggle('is-active', a.getAttribute('href') === '#' + current)
        })
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 }
    )
    sections.forEach(function (s) {
      spy.observe(s)
    })
  }

  /* ---- scroll reveal ---- */

  var reveals = document.querySelectorAll('.reveal')
  if (reduced.matches || !('IntersectionObserver' in window)) {
    Array.prototype.forEach.call(reveals, function (el) {
      el.classList.add('is-in')
    })
  } else {
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting) {
            e.target.classList.add('is-in')
            io.unobserve(e.target)
          }
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    )
    Array.prototype.forEach.call(reveals, function (el) {
      io.observe(el)
    })
  }

  /* ---- the "checked before signing" console ----
     Cycles through three illustrative reviews. Each check ticks in turn,
     then the verdict appears. The markup already holds the first scenario
     completed, which is what reduced-motion and no-JS visitors see. */

  var SCENARIOS = [
    {
      title: 'Send USDT',
      net: 'TRON · practice',
      rows: [
        ['To', 'TUA78y…CxxcxK'],
        ['Amount', '25 USDT'],
        ['Network cost', '~12.45 TRX'],
      ],
      checks: [
        ['Transaction built by the node, decoded field by field', true],
        ['Recipient and amount match what you typed', true],
        ['Token transfer is byte-identical to the one the wallet built', true],
        ["No field the wallet didn't ask for", true],
        ['No earlier send still waiting to land', true],
        ["Not a lookalike of an address you've paid", true],
      ],
      verdict: ['ok', 'Ready to sign'],
    },
    {
      title: 'Send SOL',
      net: 'Solana',
      rows: [
        ['To', '7xKpQ…9f3Qm'],
        ['Amount', '0.5 SOL'],
        ['Network fee', '0.000005 SOL'],
      ],
      checks: [
        ['Address is valid for Solana', true],
        ['Balance covers the amount and the fee', true],
        ['No earlier send still waiting to land', true],
        ["Starts and ends like an address you've paid, but isn't it", false],
      ],
      verdict: ['stop', "Stopped until you confirm you've checked it"],
    },
    {
      title: 'Swap SOL → USDC',
      net: 'Solana · Jupiter',
      rows: [
        ['You pay', '0.25 SOL'],
        ['You receive', '≥ 36.80 USDC'],
        ['Kailah fee', '0.5%, in USDC'],
      ],
      checks: [
        ['Every instruction is on the allow-list', true],
        ['Only your SOL and USDC accounts move', true],
        ['Amount, slippage and fee decoded and matched', true],
        ['Simulated on-chain: the result honours the minimum', true],
        ['Fee is exactly 0.5%, to the published account', true],
      ],
      verdict: ['ok', 'Ready to sign'],
    },
  ]

  var consoleEl = document.querySelector('[data-console]')
  if (consoleEl && !reduced.matches) {
    var titleEl = consoleEl.querySelector('[data-c-title]')
    var netEl = consoleEl.querySelector('[data-c-net]')
    var rowsEl = consoleEl.querySelector('[data-c-rows]')
    var checksEl = consoleEl.querySelector('[data-c-checks]')
    var verdictEl = consoleEl.querySelector('[data-c-verdict]')
    var verdictText = consoleEl.querySelector('[data-c-verdict-text]')
    var verdictIcon = verdictEl ? verdictEl.querySelector('use') : null

    var checkTemplate = checksEl ? checksEl.querySelector('.check') : null
    var rowTemplate = rowsEl ? rowsEl.querySelector('.row') : null
    var index = 0
    var timers = []
    var visible = false
    var running = false

    function later(fn, ms) {
      timers.push(window.setTimeout(fn, ms))
    }

    function clearTimers() {
      timers.forEach(function (t) {
        window.clearTimeout(t)
      })
      timers = []
    }

    function clearChildren(el) {
      while (el.firstChild) el.removeChild(el.firstChild)
    }

    function build(s) {
      titleEl.textContent = s.title
      netEl.textContent = s.net
      clearChildren(rowsEl)
      s.rows.forEach(function (r) {
        var row = rowTemplate.cloneNode(true)
        row.querySelector('dt').textContent = r[0]
        row.querySelector('dd').textContent = r[1]
        rowsEl.appendChild(row)
      })
      clearChildren(checksEl)
      s.checks.forEach(function (c) {
        var li = checkTemplate.cloneNode(true)
        li.className = 'check'
        li.querySelector('.check-text').textContent = c[0]
        li.querySelector('use').setAttribute('href', c[1] ? '#i-check' : '#i-x')
        checksEl.appendChild(li)
      })
      verdictEl.className = 'verdict'
      verdictText.textContent = s.verdict[1]
      if (verdictIcon) verdictIcon.setAttribute('href', s.verdict[0] === 'ok' ? '#i-check' : '#i-x')
    }

    function play(s) {
      var items = checksEl.querySelectorAll('.check')
      var step = 520
      var t = 500
      var stopped = false
      Array.prototype.forEach.call(items, function (li, i) {
        var ok = s.checks[i][1]
        later(function () {
          if (stopped) return
          li.classList.add(ok ? 'is-ok' : 'is-stop')
          if (!ok) stopped = true
        }, t)
        t += ok ? step : step * 1.4
      })
      later(function () {
        verdictEl.classList.add(s.verdict[0] === 'ok' ? 'is-ok' : 'is-stop')
      }, t + 200)
      later(next, t + 3600)
    }

    function next() {
      if (!visible) {
        running = false
        return
      }
      consoleEl.classList.add('is-switching')
      later(function () {
        index = (index + 1) % SCENARIOS.length
        build(SCENARIOS[index])
        consoleEl.classList.remove('is-switching')
        later(function () {
          play(SCENARIOS[index])
        }, 150)
      }, 340)
    }

    function start() {
      if (running) return
      running = true
      clearTimers()
      build(SCENARIOS[index])
      later(function () {
        play(SCENARIOS[index])
      }, 400)
    }

    function stop() {
      running = false
      clearTimers()
    }

    if (titleEl && netEl && rowsEl && checksEl && verdictEl && verdictText && checkTemplate && rowTemplate) {
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              visible = e.isIntersecting
              if (visible) start()
              else stop()
            })
          },
          { threshold: 0.35 }
        ).observe(consoleEl)
      } else {
        visible = true
        start()
      }
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) stop()
        else if (visible) start()
      })
    }
  }
})()
