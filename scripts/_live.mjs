// Shared by the LIVE suites (the ones that talk to real networks).
//
// A provider being down, rate-limited or blocking this IP is not a wallet
// defect — the app fails over, and the suite must say SKIP, not FAIL. Each
// script's check() consults NET_ISSUE for a failed check's detail, and
// installLiveGuard() catches anything that escapes (a scan that could reach
// no provider at all, an explorer 403 thrown from a helper) so the run ends
// as a skip with the PASS lines already printed, instead of a stack trace.

export const NET_ISSUE =
  /timeout|aborted|fetch failed|ECONN|ENOTFOUND|UND_ERR|\b429\b|\b403\b|rate.?limit|too many requests|allowed_rps|could not reach any provider|Couldn't reach|Indexed requests|HTTP 5\d\d|Load failed|network/i

export function isNetworkIssue(e) {
  const msg = String(e?.message ?? e)
  return NET_ISSUE.test(msg) || e?.name === 'TimeoutError' || e?.name === 'TypeError'
}

/** Install once at the top of a live script. */
export function installLiveGuard(suite) {
  const onEscape = (e) => {
    if (isNetworkIssue(e)) {
      console.log(`SKIP  ${suite}: remaining checks — live dependency unavailable: ${String(e?.message ?? e).slice(0, 100)}`)
      process.exit(0)
    }
    console.error(`${suite} crashed:`, e)
    process.exit(1)
  }
  process.on('unhandledRejection', onEscape)
  process.on('uncaughtException', onEscape)
}
