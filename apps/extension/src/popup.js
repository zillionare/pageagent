// PageAgent popup：桥地址设置（quantclaw）。Chrome 可跑在任意机器，桥地址存 chrome.storage.sync。
const DEFAULT_BRIDGE = 'http://192.168.0.102:8787'

document.getElementById('openOfficial')?.addEventListener('click', (e) => {
  e.preventDefault()
  chrome.tabs.create({ url: 'https://md.doocs.org' })
  window.close()
})

const input = document.getElementById('bridge')
const status = document.getElementById('bridgeStatus')

async function getBridge() {
  try {
    const st = await chrome.storage.sync.get({ pageagent_bridge: DEFAULT_BRIDGE })
    return st.pageagent_bridge || DEFAULT_BRIDGE
  } catch {
    return DEFAULT_BRIDGE
  }
}

async function refresh() {
  const base = (await getBridge()).replace(/\/$/, '')
  if (input) input.value = base
  try {
    const r = await fetch(base + '/health', { method: 'GET' })
    const j = await r.json().catch(() => ({}))
    if (status) {
      status.textContent = r.ok
        ? `桥连通（扩展${j.connected ? '已' : '未'}连接）`
        : `桥不通: HTTP ${r.status}`
      status.style.color = r.ok ? '#0a0' : '#c00'
    }
  } catch (e) {
    if (status) {
      status.textContent = `桥不通: ${e?.message ?? e}`
      status.style.color = '#c00'
    }
  }
}

document.getElementById('saveBridge')?.addEventListener('click', async () => {
  const v = (input?.value ?? '').trim().replace(/\/$/, '') || DEFAULT_BRIDGE
  await chrome.storage.sync.set({ pageagent_bridge: v })
  // 通知 SW 重连
  try { await chrome.runtime.sendMessage({ type: 'pageagent-bridge-changed', base: v }) } catch {}
  await refresh()
})

refresh()
