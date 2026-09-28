// PageAgent popup：桥地址设置 + 占用检测/接管（quantclaw）。Chrome 可跑在任意机器，桥地址存 chrome.storage.sync。
const DEFAULT_BRIDGE = 'http://192.168.0.102:8787'

document.getElementById('openOfficial')?.addEventListener('click', e => {
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
      const occ = j.occupants || {}
      const c = occ.crawler ? `${occ.crawler.peer}` : '无'
      const w = occ.writer ? `${occ.writer.peer}` : '无'
      status.textContent = r.ok
        ? `桥连通（crawler: ${c} / writer: ${w}）`
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
    // 仅检测「当前所选角色」的席位占用（另一角色不影响）
    const sel = document.getElementById('roleSel')?.value || ''
    const occRole = lastHealth?.occupants?.[sel] || null
    const mySeatConn = !!st.pageagent_connected && String(st.pageagent_connected_role || '') === sel
    if (occRole && box && txt && !mySeatConn) {
      txt.textContent = `${sel} 席位被 ${occRole.peer} 占用。要在此机器接管（踢掉对方）吗？`
      box.style.display = 'block'
    } else if (box) {
      box.style.display = 'none'
    }
  } catch {}
}

async function refreshRole() {
  const el = document.getElementById('roleStatus')
  const sel = document.getElementById('roleSel')
  if (!el) return
  try {
    const st = await chrome.storage.sync.get({
      pageagent_role: '',
      pageagent_connected: false,
      pageagent_connected_role: '',
      pageagent_bridge_error: '',
      pageagent_kicked_at: 0,
      pageagent_kicked_role: '',
      pageagent_disconnected: false,
    })
    if (sel && st.pageagent_role) sel.value = st.pageagent_role
    let txt
    if (!st.pageagent_role || st.pageagent_disconnected) {
      txt = '未登录（本机不接入桥）'
    } else {
      txt = `已登录：${st.pageagent_role}`
      txt +=
        st.pageagent_connected && st.pageagent_connected_role === st.pageagent_role
          ? ' · 桥已连接'
          : ' · 未连接'
    }
    if (st.pageagent_bridge_error) txt += ` · ${st.pageagent_bridge_error}`
    if (st.pageagent_kicked_at && Date.now() - st.pageagent_kicked_at < 60000) {
      txt += ` · 已被同角色新连接接管`
    }
    el.textContent = txt
    el.style.color = st.pageagent_bridge_error ? '#c00' : '#666'
  } catch {}
}

document.getElementById('roleLogin')?.addEventListener('click', async () => {
  const role = document.getElementById('roleSel')?.value || 'writer'
  await chrome.storage.sync.set({
    pageagent_role: role,
    pageagent_pwd: '',
    pageagent_disconnected: false,
    pageagent_bridge_error: '',
  })
  try {
    await chrome.storage.sync.remove([
      'pageagent_bridge_error',
      'pageagent_kicked_at',
      'pageagent_kicked_role',
    ])
  } catch {}
  const el = document.getElementById('roleStatus')
  if (el) el.textContent = `正在以 ${role} 登录…`
  setTimeout(refreshRole, 1500)
})

document.getElementById('roleLogout')?.addEventListener('click', async () => {
  await chrome.storage.sync.set({
    pageagent_disconnected: true,
    pageagent_role: '',
    pageagent_pwd: '',
  })
  try {
    await chrome.storage.sync.remove([
      'pageagent_connected_role',
      'pageagent_kicked_at',
      'pageagent_kicked_role',
    ])
  } catch {}
  const el = document.getElementById('roleStatus')
  if (el) el.textContent = '已退出（本机不再接入桥）'
})

document.getElementById('takeover')?.addEventListener('click', async () => {
  const txt = document.getElementById('occupantText')
  const sel = document.getElementById('roleSel')?.value || 'writer'
  if (txt) txt.textContent = `正在以 ${sel} 接管（踢掉同角色对方）…`
  try {
    await chrome.storage.sync.set({
      pageagent_role: sel,
      pageagent_pwd: '',
      pageagent_disconnected: false,
      pageagent_force_takeover: Date.now(),
    })
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
  try {
    await chrome.runtime.sendMessage({ type: 'pageagent-bridge-changed', base: v })
  } catch {}
  await refresh()
})

refresh().then(refreshOccupant).then(refreshRole)
setInterval(() => {
  refresh().then(refreshOccupant).then(refreshRole)
}, 3000)
