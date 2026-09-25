// PageAgent popup：桥地址设置 + 占用检测/接管（quantclaw）。Chrome 可跑在任意机器，桥地址存 chrome.storage.sync。
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
    lastHealth = j
    if (status) {
      status.textContent = r.ok
        ? `桥连通（${j.connected ? `已被 ${j.occupant ?? '?'} 连接` : '无扩展连接'}）`
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

let lastHealth = null
async function refreshOccupant() {
  const box = document.getElementById('occupantBox')
  const txt = document.getElementById('occupantText')
  try {
    const st = await chrome.storage.sync.get({ pageagent_occupant: '', pageagent_connected: false })
    let occ = String(st.pageagent_occupant || '')
    const myConn = !!st.pageagent_connected
    // 桥上有连接但不是本机 → 被占用（/health 直接给占用者 IP，不依赖本机曾收过 409）
    if (!occ && lastHealth && lastHealth.connected && !myConn && lastHealth.occupant) {
      occ = String(lastHealth.occupant)
    }
    if (occ && box && txt) {
      txt.textContent = `桥被占用：${occ} 正在连接。要在此机器接管（踢掉对方）吗？`
      box.style.display = 'block'
    } else if (box) {
      box.style.display = 'none'
    }
  } catch {}
}

document.getElementById('takeover')?.addEventListener('click', async () => {
  const txt = document.getElementById('occupantText')
  if (txt) txt.textContent = '正在接管（踢掉对方）…'
  try {
    await chrome.storage.sync.set({ pageagent_force_takeover: Date.now() })
  } catch {}
  setTimeout(async () => {
    await refresh()
    await refreshOccupant()
  }, 3000)
})

document.getElementById('saveBridge')?.addEventListener('click', async () => {
  const v = (input?.value ?? '').trim().replace(/\/$/, '') || DEFAULT_BRIDGE
  await chrome.storage.sync.set({ pageagent_bridge: v })
  // 通知 SW 重连
  try { await chrome.runtime.sendMessage({ type: 'pageagent-bridge-changed', base: v }) } catch {}
  await refresh()
})

refresh().then(refreshOccupant)
setInterval(() => { refresh().then(refreshOccupant) }, 3000)