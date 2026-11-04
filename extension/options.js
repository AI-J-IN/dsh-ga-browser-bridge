/**
 * DSH Browser Bridge — options page script.
 *
 * Plain DOM + chrome.storage/chrome.runtime. No frameworks, no external
 * resources (MV3 CSP forbids remote script and inline <script>).
 */

'use strict'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 18789

const $host = document.getElementById('host')
const $port = document.getElementById('port')
const $save = /** @type {HTMLButtonElement} */ (document.getElementById('save'))
const $reconnect = /** @type {HTMLButtonElement} */ (document.getElementById('reconnect'))
const $saved = document.getElementById('saved')
const $dot = document.getElementById('dot')
const $state = document.getElementById('state')
const $url = document.getElementById('url')
const $error = document.getElementById('error')

/** Validate and normalize the two inputs. Returns {value} or {error}. */
function readForm() {
  const host = String($host.value || '').trim()
  const portRaw = String($port.value || '').trim()

  if (host.length === 0) return { error: 'Host must not be empty.' }
  if (!/^[A-Za-z0-9._:-]+$/.test(host)) return { error: 'Host may only contain letters, digits, dots, dashes, underscores and colons.' }

  const port = Number(portRaw)
  if (portRaw === '' || !Number.isFinite(port) || Math.trunc(port) !== port || port < 1 || port > 65535) {
    return { error: 'Port must be a whole number between 1 and 65535.' }
  }
  return { value: { host, port } }
}

function flash(message) {
  $saved.textContent = message
  if (flash._timer) clearTimeout(flash._timer)
  flash._timer = setTimeout(() => {
    $saved.textContent = ''
  }, 2500)
}

function renderStatus(status) {
  if (!status || typeof status !== 'object') {
    $state.textContent = 'Unknown'
    $dot.className = 'dot disconnected'
    return
  }
  const state = status.state || 'disconnected'
  const labels = {
    connected: 'Connected to the DSH plugin',
    connecting: 'Connecting…',
    disconnected: 'Disconnected',
  }
  $state.textContent = labels[state] || state
  $dot.className = 'dot ' + (labels[state] ? state : 'disconnected')
  if (status.url) {
    $url.textContent = 'Endpoint: ' + status.url
  } else {
    $url.textContent = ''
  }
  if (status.lastError) {
    $error.textContent = status.lastError
    $error.hidden = false
  } else {
    $error.textContent = ''
    $error.hidden = true
  }
}

/** Ask the service worker for its live status; wakes it if it was evicted. */
function refreshStatus() {
  let settled = false
  try {
    chrome.runtime.sendMessage({ type: 'dsh-bridge:status' }, (response) => {
      if (settled) return
      settled = true
      if (chrome.runtime.lastError) {
        // The worker may be mid-restart; show a soft state instead of an error.
        renderStatus({ state: 'disconnected', lastError: chrome.runtime.lastError.message || '' })
        return
      }
      renderStatus(response)
    })
  } catch (err) {
    renderStatus({ state: 'disconnected', lastError: String((err && err.message) || err) })
  }
}

async function loadSettings() {
  let stored = {}
  try {
    stored = await chrome.storage.local.get({ host: DEFAULT_HOST, port: DEFAULT_PORT })
  } catch {
    stored = {}
  }
  $host.value = typeof stored.host === 'string' && stored.host ? stored.host : DEFAULT_HOST
  const port = Number(stored.port)
  $port.value = String(Number.isFinite(port) && port > 0 ? Math.trunc(port) : DEFAULT_PORT)
}

$save.addEventListener('click', async () => {
  const parsed = readForm()
  if (parsed.error) {
    $saved.textContent = parsed.error
    return
  }
  $save.disabled = true
  try {
    await chrome.storage.local.set({ host: parsed.value.host, port: parsed.value.port })
    flash('Saved.')
  } catch (err) {
    $saved.textContent = 'Save failed: ' + String((err && err.message) || err)
  } finally {
    $save.disabled = false
  }
  // The worker reacts to storage changes and reconnects; poll for the new state.
  setTimeout(refreshStatus, 400)
})

$reconnect.addEventListener('click', () => {
  $reconnect.disabled = true
  let settled = false
  const done = (response) => {
    if (settled) return
    settled = true
    $reconnect.disabled = false
    if (chrome.runtime.lastError) {
      renderStatus({ state: 'disconnected', lastError: chrome.runtime.lastError.message || '' })
      return
    }
    renderStatus(response)
  }
  try {
    chrome.runtime.sendMessage({ type: 'dsh-bridge:reconnect' }, done)
  } catch (err) {
    done({ state: 'disconnected', lastError: String((err && err.message) || err) })
  }
  setTimeout(refreshStatus, 600)
})

// Keep the status line live while the page is open.
loadSettings().then(refreshStatus)
setInterval(refreshStatus, 1500)
