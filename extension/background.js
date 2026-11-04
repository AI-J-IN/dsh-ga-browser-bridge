/**
 * DSH Browser Bridge — MV3 service worker.
 *
 * WHAT THIS IS
 * ------------
 * The client half of the extension transport. The DSH plugin listens on a
 * loopback WebSocket and the EXTENSION dials out to it (a service worker cannot
 * listen on a TCP port, but it can open WebSocket client connections).
 *
 * Contract: src/extension/protocol.ts — do not change anything here without
 * bumping EXTENSION_PROTOCOL_VERSION on both sides.
 *
 *   DSH plugin (Node)                        Browser
 *   ┌────────────────────┐                ┌──────────────────────────┐
 *   │ ExtensionBridge    │◀── WebSocket ──│ this service worker      │
 *   │ ws://127.0.0.1:PORT│   (extension   │  chrome.debugger.attach()│
 *   │  serves the socket │    dials out)  │  chrome.tabs.*           │
 *   └────────────────────┘                └──────────────────────────┘
 *
 * Plain JS, no build step. All state that must survive a service-worker
 * restart is re-derivable: the socket is re-opened on demand, and per-tab
 * debugger refcounts live in a module-level Map that is rebuilt by consulting
 * chrome.debugger.getTargets() when we are not sure we still own a session.
 */

'use strict'

// ---------------------------------------------------------------------------
// Constants — must match src/extension/protocol.ts
// ---------------------------------------------------------------------------

const EXTENSION_PROTOCOL_VERSION = 1
const EXTENSION_DEFAULT_PORT = 18765
const EXTENSION_DEFAULT_HOST = '127.0.0.1'
const EXTENSION_VERSION = '0.1.0'

/** Largest page.snapshot result when the host does not pass maxchars. */
const DEFAULT_MAXCHARS = 35000
/** How long tabs.reload waits for status === 'complete'. */
const RELOAD_TIMEOUT_MS = 15000
const RELOAD_POLL_MS = 200
/** Keepalive: send a ping over the socket so it is not closed as idle. */
const SELF_PING_MS = 20000
/** Keepalive: chrome.alarms tick, the only reliable MV3 wake-up source. */
const KEEPALIVE_ALARM_NAME = 'dsh-bridge-keepalive'
const KEEPALIVE_ALARM_MINUTES = 0.5 // 30s; Chrome floor for packed extensions is 1 min
/** Reconnect backoff: 1s, 2s, 4s, ... capped. */
const BACKOFF_BASE_MS = 1000
const BACKOFF_CAP_MS = 30000

// ---------------------------------------------------------------------------
// State
//
// The service worker may be torn down at any time and re-executed later. On
// re-execution this module scope is fresh, so nothing below may be assumed
// live: `ensureConnected()` is called before every send, and the refcount Map
// is only consulted via `getRef()` which is aware the Map may be empty.
// ---------------------------------------------------------------------------

/** @type {WebSocket | null} */
let socket = null
/** The single in-flight connect attempt, or null. Prevents duplicate dials. */
let connectingPromise = null
/** Exponential backoff attempt counter; reset on a successful open. */
let backoffAttempt = 0
/** Timer handle for the next scheduled reconnect. */
let reconnectTimer = null
/** Self-ping interval handle. */
let selfPingTimer = null
/** Whether the current socket ever reached OPEN. */
let socketOpened = false
/** Last error string, surfaced in options.html. */
let lastError = ''

/**
 * Per-tab chrome.debugger ownership.
 * tabId -> { count: number, attachedByUs: boolean }
 * `count` is the number of in-flight operations that need the session.
 * The session is detached when the count returns to 0.
 * @type {Map<number, {count: number, attachedByUs: boolean}>}
 */
const debuggerRefs = new Map()

/**
 * Tabs for which a detach was already reported via chrome.debugger.onDetach,
 * so the release path does not try to detach a session Chrome already tore down.
 * @type {Set<number>}
 */
const detachedExternally = new Set()

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  try {
    console.log('[dsh-bridge]', ...args)
  } catch {
    /* console always exists in an SW, but never let logging break work */
  }
}

function warn(...args) {
  try {
    console.warn('[dsh-bridge]', ...args)
  } catch {
    /* ignore */
  }
}

/** Error body per the contract: { code, message, detail? }. */
function errorBody(code, message, detail) {
  const body = { code: String(code || 'BAD_REQUEST'), message: String(message || code || 'error') }
  if (detail !== undefined && detail !== null && detail !== '') body.detail = String(detail)
  return body
}

/** ExtensionError thrown by handlers so the dispatcher can build a response. */
class BridgeError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

/** Serialize a thrown chrome.* failure into a readable message. */
function errorMessage(err) {
  if (!err) return 'unknown error'
  if (typeof err === 'string') return err
  if (err.message) return String(err.message)
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Run a chrome.* API that may be Promise-based (MV3) or callback+lastError
 * based. We use the Promise form exclusively; a rejected promise is the only
 * failure shape we handle, which is the current MV3 contract.
 */
async function callChrome(fn, ...args) {
  const value = fn(...args)
  // Promise-based APIs return a thenable. Anything else is already a value.
  if (value && typeof value.then === 'function') return await value
  return value
}

function isFiniteTabId(v) {
  return typeof v === 'number' && Number.isFinite(v) && Math.trunc(v) === v
}

/** Normalize a chrome.tabs.Tab into the contract's ExtensionTab shape. */
function toExtensionTab(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || tab.pendingUrl || '',
    active: Boolean(tab.active),
    windowId: tab.windowId,
    status: tab.status,
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Read {host, port} from chrome.storage.local with defaults.
 * @returns {Promise<{host: string, port: number}>}
 */
async function getSettings() {
  let stored = {}
  try {
    stored = (await chrome.storage.local.get({ host: EXTENSION_DEFAULT_HOST, port: EXTENSION_DEFAULT_PORT })) || {}
  } catch (err) {
    warn('storage read failed, using defaults', errorMessage(err))
  }
  const rawHost = typeof stored.host === 'string' ? stored.host.trim() : ''
  const host = rawHost || EXTENSION_DEFAULT_HOST
  const rawPort = Number(stored.port)
  const port = Number.isFinite(rawPort) && rawPort > 0 && rawPort <= 65535 ? Math.trunc(rawPort) : EXTENSION_DEFAULT_PORT
  return { host, port }
}

function serverUrl(settings) {
  // Assume plain ws:// on loopback/LAN (the plugin serves a bare WebSocket).
  return `ws://${settings.host}:${settings.port}`
}

// ---------------------------------------------------------------------------
// Socket lifecycle
// ---------------------------------------------------------------------------

function socketState() {
  return !socket ? 'disconnected' : socket.readyState === 1 ? 'connected' : 'connecting'
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    try {
      clearTimeout(reconnectTimer)
    } catch {
      /* ignore */
    }
    reconnectTimer = null
  }
}

function stopSelfPing() {
  if (selfPingTimer !== null) {
    try {
      clearInterval(selfPingTimer)
    } catch {
      /* ignore */
    }
    selfPingTimer = null
  }
}

function startSelfPing() {
  stopSelfPing()
  selfPingTimer = setInterval(() => {
    if (!socket || socket.readyState !== 1) return
    try {
      // A protocol-level ping event: no id, so the host ignores or acks it.
      socket.send(JSON.stringify({ method: 'ping', protocolVersion: EXTENSION_PROTOCOL_VERSION }))
    } catch (err) {
      warn('self-ping failed', errorMessage(err))
    }
  }, SELF_PING_MS)
}

/**
 * Schedule the next connect attempt with exponential backoff.
 * Delay = 1s, 2s, 4s ... capped at 30s.
 */
function scheduleReconnect() {
  if (reconnectTimer !== null) return
  const delay = Math.min(BACKOFF_BASE_MS * Math.pow(2, backoffAttempt), BACKOFF_CAP_MS)
  backoffAttempt += 1
  log(`reconnecting in ${delay}ms (attempt ${backoffAttempt})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    // Fire and forget: ensureConnected() collapses duplicates.
    ensureConnected().catch((err) => warn('scheduled reconnect failed', errorMessage(err)))
  }, delay)
}

/**
 * Open the single module-level socket. Concurrent callers share one in-flight
 * attempt (the "single in-flight promise" guard required for MV3 wake-ups).
 * Resolves with the OPEN socket or rejects.
 * @returns {Promise<WebSocket>}
 */
function ensureConnected() {
  if (socket && socket.readyState === 1) return Promise.resolve(socket)
  if (connectingPromise) return connectingPromise

  connectingPromise = (async () => {
    const settings = await getSettings()
    const url = serverUrl(settings)
    log('connecting to', url)

    const ws = new WebSocket(url)
    socket = ws
    socketOpened = false

    return await new Promise((resolve, reject) => {
      let settled = false
      const settleOk = () => {
        if (settled) return
        settled = true
        resolve(ws)
      }
      const settleErr = (err) => {
        if (settled) return
        settled = true
        reject(err)
      }

      ws.onopen = () => {
        log('socket open', url)
        socketOpened = true
        backoffAttempt = 0
        lastError = ''
        clearReconnectTimer()
        startSelfPing()
        setBadge('')
        // hello is an EVENT (no id), per protocol.ts.
        try {
          ws.send(
            JSON.stringify({
              method: 'hello',
              protocolVersion: EXTENSION_PROTOCOL_VERSION,
              extensionVersion: EXTENSION_VERSION,
              browser: navigator.userAgent,
            })
          )
        } catch (err) {
          warn('failed to send hello', errorMessage(err))
        }
        settleOk()
      }

      ws.onmessage = (event) => {
        handleFrame(event && event.data)
      }

      ws.onerror = () => {
        lastError = 'websocket error'
        // onclose follows onerror in Chrome; nothing else to do here.
        settleErr(new Error('websocket error connecting to ' + url))
      }

      ws.onclose = (event) => {
        const reason = (event && event.reason) || ''
        const code = event && event.code
        log('socket closed', code, reason)
        if (socket === ws) {
          socket = null
          stopSelfPing()
        }
        if (!socketOpened) {
          lastError = `cannot reach ${url}${code ? ' (code ' + code + ')' : ''}`
        } else {
          lastError = `connection lost${code ? ' (code ' + code + ')' : ''}${reason ? ': ' + reason : ''}`
        }
        setBadge('!')
        settleErr(new Error(lastError))
        scheduleReconnect()
      }
    }).finally(() => {
      connectingPromise = null
    })
  })()

  return connectingPromise
}

/** Best-effort connect from runtime events (never throws). */
function wakeAndConnect() {
  ensureConnected().catch(() => {
    /* reconnect is already scheduled by the close/error path */
  })
}

/** Send one frame on the current socket, connecting first if needed. */
async function sendFrame(frame) {
  const ws = await ensureConnected()
  if (!ws || ws.readyState !== 1) throw new Error('not connected')
  ws.send(JSON.stringify(frame))
}

/** Send an event (no id); failures are swallowed — events are advisory. */
function sendEvent(event) {
  try {
    if (!socket || socket.readyState !== 1) return
    socket.send(JSON.stringify(event))
  } catch (err) {
    warn('failed to send event ' + (event && event.method), errorMessage(err))
  }
}

function setBadge(text) {
  try {
    if (chrome.action && chrome.action.setBadgeText) {
      Promise.resolve(chrome.action.setBadgeText({ text })).catch(() => {})
    }
  } catch {
    /* badge is cosmetic */
  }
}

// ---------------------------------------------------------------------------
// Frame dispatch
// ---------------------------------------------------------------------------

/**
 * Parse and route one frame. Malformed frames are ignored (never answered).
 * @param {unknown} data raw WebSocket payload
 */
function handleFrame(data) {
  if (typeof data !== 'string' || data.length === 0) return
  let msg
  try {
    msg = JSON.parse(data)
  } catch {
    // Malformed JSON: ignore silently, per protocol robustness requirement.
    return
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return

  // Requests carry a numeric id AND a method. Events (host -> extension) do not.
  const hasId = typeof msg.id === 'number' && Number.isFinite(msg.id)
  const hasMethod = typeof msg.method === 'string' && msg.method.length > 0
  if (!hasId || !hasMethod) return

  const id = msg.id
  dispatch(id, msg.method, msg.params).then(
    (result) => {
      respond({ id, ok: true, result })
    },
    (err) => {
      if (err instanceof BridgeError) {
        respond({ id, ok: false, error: errorBody(err.code, err.message, err.detail) })
      } else {
        respond({ id, ok: false, error: errorBody('BAD_REQUEST', errorMessage(err)) })
      }
    }
  )
}

/**
 * Send exactly one response for an id. Two guards: `respond` is called from a
 * single settle point per request (Promise resolve XOR reject), and the frame
 * is only written to the socket we currently own.
 */
function respond(response) {
  try {
    if (!socket || socket.readyState !== 1) {
      warn('dropping response for id', response.id, '— socket gone')
      return
    }
    socket.send(JSON.stringify(response))
  } catch (err) {
    warn('failed to send response', response.id, errorMessage(err))
  }
}

/**
 * Route a request to its handler. Every handler is async and either returns a
 * result or throws BridgeError.
 * @param {number} id
 * @param {string} method
 * @param {any} params
 */
async function dispatch(id, method, params) {
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {}

  switch (method) {
    case 'ping':
      return { pong: true, protocolVersion: EXTENSION_PROTOCOL_VERSION }

    case 'tabs.list':
      return handleTabsList()

    case 'tabs.get':
      return handleTabsGet(p)

    case 'tabs.create':
      return handleTabsCreate(p)

    case 'tabs.activate':
      return handleTabsActivate(p)

    case 'tabs.close':
      return handleTabsClose(p)

    case 'tabs.reload':
      return handleTabsReload(p)

    case 'page.evaluate':
      return handlePageEvaluate(p)

    case 'page.snapshot':
      return handlePageSnapshot(p)

    case 'cdp.send':
      return handleCdpSend(p)

    case 'cookies.get':
      return handleCookiesGet(p)

    default:
      throw new BridgeError('UNKNOWN_METHOD', `unknown method: ${method}`)
  }
}

// ---------------------------------------------------------------------------
// Tab handlers
// ---------------------------------------------------------------------------

async function handleTabsList() {
  const tabs = await callChrome(chrome.tabs.query, {})
  return (tabs || []).map(toExtensionTab)
}

function requireTabId(p) {
  if (!isFiniteTabId(p.tabId)) {
    throw new BridgeError('BAD_REQUEST', 'params.tabId must be an integer', JSON.stringify(p))
  }
  return p.tabId
}

async function getTabOrThrow(tabId) {
  let tab
  try {
    tab = await callChrome(chrome.tabs.get, tabId)
  } catch (err) {
    throw new BridgeError('NO_TAB', `no such tab: ${tabId}`, errorMessage(err))
  }
  if (!tab) throw new BridgeError('NO_TAB', `no such tab: ${tabId}`)
  return tab
}

async function handleTabsGet(p) {
  const tabId = requireTabId(p)
  const tab = await getTabOrThrow(tabId)
  return toExtensionTab(tab)
}

async function handleTabsCreate(p) {
  const createProps = {}
  if (typeof p.url === 'string' && p.url.length > 0) createProps.url = p.url
  if (typeof p.active === 'boolean') createProps.active = p.active
  let tab
  try {
    tab = await callChrome(chrome.tabs.create, createProps)
  } catch (err) {
    throw new BridgeError('BAD_REQUEST', 'failed to create tab', errorMessage(err))
  }
  return toExtensionTab(tab)
}

async function handleTabsActivate(p) {
  const tabId = requireTabId(p)
  const before = await getTabOrThrow(tabId)
  let tab
  try {
    tab = await callChrome(chrome.tabs.update, tabId, { active: true })
  } catch (err) {
    throw new BridgeError('NO_TAB', `failed to activate tab ${tabId}`, errorMessage(err))
  }
  const targetWindowId = tab && typeof tab.windowId === 'number' ? tab.windowId : before.windowId
  // Focus the owning window too, so the tab is actually visible to the user.
  try {
    await callChrome(chrome.windows.update, targetWindowId, { focused: true })
  } catch (err) {
    warn('windows.update focus failed', errorMessage(err))
  }
  return toExtensionTab(tab || before)
}

async function handleTabsClose(p) {
  const tabId = requireTabId(p)
  await getTabOrThrow(tabId)
  try {
    await callChrome(chrome.tabs.remove, tabId)
  } catch (err) {
    throw new BridgeError('NO_TAB', `failed to close tab ${tabId}`, errorMessage(err))
  }
  return { closed: tabId }
}

/**
 * Reload and wait (up to RELOAD_TIMEOUT_MS) for status 'complete'.
 * Returns the tab either way: a slow page is not an error, and the contract's
 * response type is ExtensionTab.
 */
async function handleTabsReload(p) {
  const tabId = requireTabId(p)
  await getTabOrThrow(tabId)
  try {
    await callChrome(chrome.tabs.reload, tabId)
  } catch (err) {
    throw new BridgeError('NO_TAB', `failed to reload tab ${tabId}`, errorMessage(err))
  }

  const deadline = Date.now() + RELOAD_TIMEOUT_MS
  // Give the reload a moment to flip to 'loading' before polling for completion,
  // otherwise we read the stale 'complete' from before the reload.
  await sleep(RELOAD_POLL_MS)

  let lastStatus
  for (;;) {
    const tab = await getTabOrThrow(tabId)
    lastStatus = tab.status
    if (tab.status === 'complete') return toExtensionTab(tab)
    if (Date.now() >= deadline) {
      log(`reload of tab ${tabId} still ${lastStatus} after ${RELOAD_TIMEOUT_MS}ms`)
      return toExtensionTab(tab)
    }
    await sleep(RELOAD_POLL_MS)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// chrome.debugger attach with refcounting
//
// Ownership rules:
//  * `acquireDebugger(tabId)` increments the per-tab count and attaches only if
//    the count was 0 (or if we know Chrome does not have the session).
//  * `releaseDebugger(tabId)` decrements and detaches when the count reaches 0,
//    but ONLY if we attached it (`attachedByUs`). A session the user or DevTools
//    owned is never detached by us.
//  * Concurrent calls therefore share one attach and produce exactly one detach
//    (the last release).
//  * chrome.debugger.onDetach decrements/reset the entry, marks the tab as
//    externally detached, and notifies the host — so a later release does not
//    try to detach a session that no longer exists.
// ---------------------------------------------------------------------------

function getRef(tabId) {
  return debuggerRefs.get(tabId)
}

/** Message Chrome produces when another debugger holds the tab. */
const ATTACH_CONFLICT_HINT =
  'Another debugger is already attached to this tab. Close DevTools (or any other extension debugging this tab) and retry.'

/**
 * Chrome forbids extension debugging on its own pages and on the Web Store.
 * Attach then fails with "Cannot access a chrome:// URL" / "Cannot access
 * contents of <url>" / "The extensions gallery cannot be scripted".
 */
const NON_DEBUGGABLE_HINT =
  'This page cannot be driven by an extension. Chrome blocks chrome:// pages, ' +
  "the Chrome Web Store, other extensions' pages and devtools:// pages. " +
  'Switch to a normal http(s) tab (browser_tabs list shows the others).'

const NON_DEBUGGABLE_RE =
  /cannot access (a )?(chrome|edge|about|devtools):|cannot access contents|extensions gallery|cannot be scripted|chrome:\/\/ URL/i

/**
 * Chrome 155 policy rejections (managed browsers only): attach() is refused on
 * EVERY target when the admin configured runtime_blocked_hosts, screenshots or
 * DLP restrictions.
 * developer.chrome.com/blog/debugger-enterprise-policy-restrictions
 */
const POLICY_HOST_HINT =
  'Enterprise policy blocks this extension: the admin configured host restrictions ' +
  '(runtime_blocked_hosts), so chrome.debugger cannot attach to any page. Ask IT to ' +
  'allow this extension, or use the CDP debug-port transport instead.'

const POLICY_SCREENSHOT_HINT =
  'Enterprise policy blocks this extension: screenshots/DLP are disabled by policy ' +
  'and Chrome then refuses chrome.debugger entirely. Ask IT to allow this extension, ' +
  'or use the CDP debug-port transport instead.'

/**
 * Attach (refcounted) and return a release function. The caller MUST call the
 * returned release exactly once, in a finally block.
 * @param {number} tabId
 * @returns {Promise<() => void>}
 */
async function acquireDebugger(tabId) {
  const existing = getRef(tabId)
  if (existing) {
    existing.count += 1
    return () => releaseDebugger(tabId)
  }

  // Fresh entry: we are the first holder.
  const entry = { count: 1, attachedByUs: false }
  debuggerRefs.set(tabId, entry)

  // If Chrome already has a session for this tab (e.g. the worker restarted
  // while a session was live), attach() would throw "Another debugger is
  // already attached". Probe first so we adopt instead of nagging the user.
  if (await isAlreadyAttached(tabId)) {
    log('adopting existing debugger session for tab', tabId)
    entry.attachedByUs = false
    return () => releaseDebugger(tabId)
  }

  try {
    await callChrome(chrome.debugger.attach, { tabId }, '1.3')
    entry.attachedByUs = true
    detachedExternally.delete(tabId)
    log('attached debugger to tab', tabId)
  } catch (err) {
    // Roll back the entry so a later call retries cleanly.
    debuggerRefs.delete(tabId)
    const msg = errorMessage(err)
    // Classify by cause so the model (and the user) get an actionable message
    // instead of a generic "failed to attach".
    let hint = `failed to attach debugger to tab ${tabId}: ${msg}`
    let code = 'ATTACH_FAILED'
    if (/already attached|another debugger/i.test(msg)) {
      hint = ATTACH_CONFLICT_HINT
    } else if (/host access is restricted by policy/i.test(msg)) {
      hint = POLICY_HOST_HINT
      code = 'POLICY_BLOCKED'
    } else if (/screenshot capture is restricted by policy/i.test(msg)) {
      hint = POLICY_SCREENSHOT_HINT
      code = 'POLICY_BLOCKED'
    } else if (NON_DEBUGGABLE_RE.test(msg)) {
      hint = NON_DEBUGGABLE_HINT
      code = 'NON_DEBUGGABLE_PAGE'
    }
    throw new BridgeError(code, hint, msg)
  }

  return () => releaseDebugger(tabId)
}

/** True when chrome.debugger already has a session for the tab. */
async function isAlreadyAttached(tabId) {
  try {
    const targets = await callChrome(chrome.debugger.getTargets)
    if (!Array.isArray(targets)) return false
    return targets.some((t) => t && t.tabId === tabId && t.attached)
  } catch {
    // getTargets is optional-ish; if it fails, just attempt the attach.
    return false
  }
}

/** Decrement the refcount; detach when it reaches zero and we own the session. */
function releaseDebugger(tabId) {
  const entry = getRef(tabId)
  if (!entry) return
  entry.count -= 1
  if (entry.count > 0) return

  debuggerRefs.delete(tabId)
  if (!entry.attachedByUs) return
  if (detachedExternally.has(tabId)) {
    detachedExternally.delete(tabId)
    return
  }
  try {
    const result = chrome.debugger.detach({ tabId })
    if (result && typeof result.then === 'function') {
      result.then(undefined, (err) => warn('detach failed', errorMessage(err)))
    }
  } catch (err) {
    warn('detach failed', errorMessage(err))
  }
}

/** Send a CDP command over an already-acquired session. */
async function sendCdp(tabId, method, params) {
  try {
    return await callChrome(chrome.debugger.sendCommand, { tabId }, method, params || {})
  } catch (err) {
    throw new BridgeError('CDP_ERROR', `${method} failed: ${errorMessage(err)}`, errorMessage(err))
  }
}

// ---------------------------------------------------------------------------
// page.evaluate / page.snapshot
// ---------------------------------------------------------------------------

/** Build the EvaluateResult for a Runtime.evaluate reply. */
function toEvaluateResult(reply) {
  if (reply && reply.exceptionDetails) {
    const details = reply.exceptionDetails
    const text =
      (details.exception && (details.exception.description || details.exception.value)) || details.text || 'evaluation threw'
    return { value: undefined, exception: String(text) }
  }
  const remote = reply && reply.result
  if (!remote) return { value: undefined }
  if (Object.prototype.hasOwnProperty.call(remote, 'value')) return { value: remote.value }
  // returnByValue:false gives a remote object; expose the description so the
  // host has something to show instead of a bare undefined.
  if (remote.unserializableValue !== undefined) return { value: remote.unserializableValue }
  if (remote.value !== undefined) return { value: remote.value }
  return { value: remote.description !== undefined ? remote.description : remote.type }
}

/**
 * Evaluate an expression in the tab's main world via Runtime.evaluate.
 * `awaitPromise` / `returnByValue` default to true, matching the contract.
 */
async function evaluateInTab(tabId, expression, awaitPromise, returnByValue) {
  const release = await acquireDebugger(tabId)
  try {
    const reply = await sendCdp(tabId, 'Runtime.evaluate', {
      expression,
      awaitPromise: awaitPromise !== false,
      returnByValue: returnByValue !== false,
      userGesture: true,
    })
    return reply
  } finally {
    release()
  }
}

async function handlePageEvaluate(p) {
  const tabId = requireTabId(p)
  if (typeof p.expression !== 'string') {
    throw new BridgeError('BAD_REQUEST', 'params.expression must be a string')
  }
  await getTabOrThrow(tabId)
  const reply = await evaluateInTab(tabId, p.expression, p.awaitPromise, p.returnByValue)
  // A page exception is DATA, not a transport error: return it inline.
  return toEvaluateResult(reply)
}

/** Snapshot expressions — kept as literals so they run in the page, unmodified. */
const SNAPSHOT_TEXT_EXPRESSION = 'document.body ? document.body.innerText : \'\''

const SNAPSHOT_HTML_EXPRESSION =
  "(() => { const c = document.documentElement.cloneNode(true); " +
  "c.querySelectorAll('script,style,noscript,svg').forEach(e=>e.remove()); " +
  'return c.outerHTML; })()'

async function handlePageSnapshot(p) {
  const tabId = requireTabId(p)
  const tab = await getTabOrThrow(tabId)
  const textOnly = p.textOnly === true
  const rawMax = Number(p.maxchars)
  const maxchars = Number.isFinite(rawMax) && rawMax > 0 ? Math.trunc(rawMax) : DEFAULT_MAXCHARS

  const expression = textOnly ? SNAPSHOT_TEXT_EXPRESSION : SNAPSHOT_HTML_EXPRESSION
  const reply = await evaluateInTab(tabId, expression, true, true)
  const evaluated = toEvaluateResult(reply)

  if (evaluated.exception !== undefined) {
    throw new BridgeError('CDP_ERROR', `page.snapshot failed to evaluate in tab ${tabId}`, evaluated.exception)
  }

  let content = typeof evaluated.value === 'string' ? evaluated.value : String(evaluated.value == null ? '' : evaluated.value)
  const truncated = content.length > maxchars
  if (truncated) content = content.slice(0, maxchars)

  return {
    content,
    truncated,
    title: tab.title || '',
    url: tab.url || tab.pendingUrl || '',
  }
}

// ---------------------------------------------------------------------------
// cdp.send
// ---------------------------------------------------------------------------

async function handleCdpSend(p) {
  const tabId = requireTabId(p)
  if (typeof p.method !== 'string' || p.method.length === 0) {
    throw new BridgeError('BAD_REQUEST', 'params.method must be a non-empty string')
  }
  const params = p.params && typeof p.params === 'object' ? p.params : {}
  await getTabOrThrow(tabId)

  const release = await acquireDebugger(tabId)
  try {
    return await sendCdp(tabId, p.method, params)
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------------
// cookies.get
// ---------------------------------------------------------------------------

async function handleCookiesGet(p) {
  const all = p.all !== false // default true per the contract
  const filter = {}
  if (!all && typeof p.url === 'string' && p.url.length > 0) {
    filter.url = p.url
  }
  let cookies
  try {
    cookies = await callChrome(chrome.cookies.getAll, filter)
  } catch (err) {
    throw new BridgeError('CDP_ERROR', 'failed to read cookies', errorMessage(err))
  }
  return Array.isArray(cookies) ? cookies : []
}

// ---------------------------------------------------------------------------
// chrome.* event wiring
// ---------------------------------------------------------------------------

/** chrome.debugger.onDetach: fold the refcount and tell the host. */
function onDebuggerDetach(source, reason) {
  try {
    const tabId = source && typeof source.tabId === 'number' ? source.tabId : undefined
    if (tabId === undefined) return
    log('debugger detached externally from tab', tabId, reason)
    const entry = getRef(tabId)
    if (entry) {
      // The session is gone regardless of how many callers were waiting on it.
      debuggerRefs.delete(tabId)
      detachedExternally.add(tabId)
    }
    sendEvent({ method: 'debugger.detached', tabId, reason: String(reason || 'detached') })
  } catch (err) {
    warn('onDetach handling failed', errorMessage(err))
  }
}

/** Forward a lightweight tabs.changed event; never throws. */
function forwardTabChange(tabId, change) {
  try {
    if (typeof tabId !== 'number') return
    sendEvent({ method: 'tabs.changed', tabId, change })
  } catch (err) {
    warn('forwardTabChange failed', errorMessage(err))
  }
}

/** Register every listener. Called once per module execution. */
function wireEvents() {
  try {
    chrome.debugger.onDetach.addListener(onDebuggerDetach)
  } catch (err) {
    warn('cannot register onDetach', errorMessage(err))
  }

  try {
    chrome.tabs.onCreated.addListener((tab) => {
      forwardTabChange(tab && tab.id, 'created')
      wakeAndConnect()
    })
  } catch {
    /* ignore */
  }

  try {
    chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
      // Only report meaningful, low-frequency transitions to avoid a frame storm.
      if (!_info || _info.status === 'complete' || _info.url) forwardTabChange(tabId, 'updated')
      wakeAndConnect()
    })
  } catch {
    /* ignore */
  }

  try {
    chrome.tabs.onRemoved.addListener((tabId) => {
      forwardTabChange(tabId, 'removed')
      debuggerRefs.delete(tabId)
      wakeAndConnect()
    })
  } catch {
    /* ignore */
  }

  // Keepalive alarm: the only reliable way to wake an idle MV3 worker.
  try {
    chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_ALARM_MINUTES })
  } catch (err) {
    warn('cannot create keepalive alarm', errorMessage(err))
  }
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || alarm.name !== KEEPALIVE_ALARM_NAME) return
      if (!socket || socket.readyState !== 1) wakeAndConnect()
    })
  } catch (err) {
    warn('cannot register onAlarm', errorMessage(err))
  }

  // Settings may change from the options page: reconnect to the new endpoint.
  try {
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area && area !== 'local') return
        if (!changes || (!changes.host && !changes.port)) return
        log('settings changed, reconnecting')
        clearReconnectTimer()
        backoffAttempt = 0
        try {
          if (socket) socket.close()
        } catch {
          /* ignore */
        }
        socket = null
        wakeAndConnect()
      })
    }
  } catch {
    /* ignore */
  }

  // Options page status polling + manual reconnect.
  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message !== 'object') return false
      if (message.type === 'dsh-bridge:status') {
        getSettings()
          .then((settings) => {
            sendResponse({
              state: socketState(),
              url: serverUrl(settings),
              lastError,
              settings,
              protocolVersion: EXTENSION_PROTOCOL_VERSION,
            })
          })
          .catch((err) => sendResponse({ state: 'disconnected', lastError: errorMessage(err) }))
        return true // keep the channel open for the async response
      }
      if (message.type === 'dsh-bridge:reconnect') {
        clearReconnectTimer()
        backoffAttempt = 0
        ensureConnected().then(
          () => {
            getSettings()
              .then((settings) =>
                sendResponse({ state: 'connected', url: serverUrl(settings), lastError: '', settings })
              )
              .catch(() => sendResponse({ state: 'connected', lastError: '' }))
          },
          (err) => sendResponse({ state: 'disconnected', lastError: errorMessage(err) })
        )
        return true
      }
      return false
    })
  } catch (err) {
    warn('cannot register onMessage', errorMessage(err))
  }

  // Start immediately on install and on browser start.
  try {
    chrome.runtime.onInstalled.addListener(() => {
      log('installed')
      wakeAndConnect()
    })
  } catch {
    /* ignore */
  }
  try {
    chrome.runtime.onStartup.addListener(() => wakeAndConnect())
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Boot
//
// The module re-executes after every service-worker wake-up, so this runs
// again each time — make it idempotent and cheap. Guarantees:
//   1. listeners are registered (so the worker wakes at all), and
//   2. a connect attempt is started without waiting for an event.
// ---------------------------------------------------------------------------

wireEvents()
setBadge('')
wakeAndConnect()
