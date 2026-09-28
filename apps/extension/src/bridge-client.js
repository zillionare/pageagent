// PageAgent 桥客户端（quantclaw 移植自 xpress bridge-client.mjs）。
// SW 启动后连 CF 桥（默认 http://192.168.0.102:8787），收 rpc → 跑抓取 → POST /response。
// version 上报：server 握手认 hasPageAgent（旧 xpress 认 hasArticle）。

const PAGEAGENT_BRIDGE_DEFAULT = 'http://192.168.0.102:8787'

async function getBridgeBase() {
  try {
    const st = await chrome.storage.sync.get({ pageagent_bridge: PAGEAGENT_BRIDGE_DEFAULT })
    return (st.pageagent_bridge || PAGEAGENT_BRIDGE_DEFAULT).replace(/\/$/, '')
  } catch {
    return PAGEAGENT_BRIDGE_DEFAULT
  }
}

async function ensurePageAgentBridge(handler, opts = {}) {
  const base = (opts.base ?? (await getBridgeBase())).replace(/\/$/, '')
  const client = new PageAgentBridgeClient(base, handler)
  client.start()
  return client
}

export { ensurePageAgentBridge, getBridgeBase }

class PageAgentBridgeClient {
  constructor(base, handler) {
    this.base = base
    this.handler = handler
    this.connected = false
    this.closed = false
    this.looping = false
    this.forceTakeover = false // popup 确认踢掉占用者后置 true，下次 /connect 带 force=1
    this.occupant = null
    this.authError = '' // 'bad-password' 等：登录失败后放慢重连
    this.role = ''
    try {
      chrome.storage.onChanged.addListener((chg, area) => {
        if (area !== 'sync') return
        if (chg.pageagent_force_takeover?.newValue) {
          this.forceTakeover = true
          chrome.storage.sync.remove('pageagent_force_takeover').catch(() => {})
          this.wake()
        }
        if (chg.pageagent_role || chg.pageagent_pwd || chg.pageagent_disconnected) {
          this.authError = ''
          this.wake()
        }
      })
    } catch {}
  }
  start() {
    this._startLoop()
  }
  _startLoop() {
    if (this.looping) return
    this.looping = true
    this._loop().finally(() => {
      this.looping = false
    })
  }
  wake() {
    if (!this.closed) this._startLoop()
  }
  async _loop() {
    while (!this.closed) {
      const auth = await this._getAuth()
      this.role = auth.role
      if (!auth.role) {
        // 未登录：待机不连（旧版扩展会以 legacy writer 接入，新版必须显式登录角色）
        this._markDisconnected()
        try {
          await chrome.storage.sync.set({ pageagent_connected_role: '' })
        } catch {}
        await new Promise(r => setTimeout(r, 8000))
        continue
      }
      try {
        await this._connectOnce(auth)
      } catch (e) {
        console.log(`[PageAgent v${chrome.runtime.getManifest().version}] 桥连接失败`, e.message)
        this._markDisconnected()
      }
      this.connected = false
      const wait = this.authError ? 30000 : this.occupant ? 15000 : 5000
      await new Promise(r => setTimeout(r, wait))
    }
  }
  async _getAuth() {
    try {
      const st = await chrome.storage.sync.get({
        pageagent_role: '',
        pageagent_pwd: '',
        pageagent_disconnected: false,
      })
      if (st.pageagent_disconnected) return { role: '', pwd: '' }
      return {
        role: String(st.pageagent_role || '').toLowerCase(),
        pwd: String(st.pageagent_pwd || ''),
      }
    } catch {
      return { role: '', pwd: '' }
    }
  }
  async _connectOnce(auth) {
    const p = new URLSearchParams()
    p.set('role', auth.role)
    p.set('pwd', auth.pwd)
    if (this.forceTakeover) p.set('force', '1')
    const url = this.base + '/connect?' + p.toString()
    this._markDisconnected()
    const resp = await fetch(url, { method: 'POST' })
    if (resp.status === 401) {
      this.authError = 'bad-password'
      try {
        await chrome.storage.sync.set({ pageagent_bridge_error: '密码错误，请重新登录' })
      } catch {}
      console.log('[PageAgent] 登录口令错误')
      throw new Error('bad-password')
    }
    if (resp.status === 409) {
      let occupant = '?'
      let role = auth.role
      try {
        const j = await resp.json()
        occupant = j.occupant ?? '?'
        role = j.role ?? role
      } catch {}
      this.occupant = occupant
      this.connected = false
      try {
        await chrome.storage.sync.set({
          pageagent_occupant: occupant,
          pageagent_occupant_role: role,
          pageagent_occupied_at: Date.now(),
        })
      } catch {}
      console.log(`[PageAgent] ${role} 席位被占用:`, occupant)
      throw new Error('occupied by ' + occupant)
    }
    if (!resp.ok || !resp.body) throw new Error('connect ' + resp.status)
    this.forceTakeover = false
    this.occupant = null
    this.authError = ''
    try {
      await chrome.storage.sync.remove([
        'pageagent_occupant',
        'pageagent_occupied_at',
        'pageagent_bridge_error',
      ])
    } catch {}
    try {
      await chrome.storage.sync.set({
        pageagent_connected: true,
        pageagent_connected_role: auth.role,
      })
    } catch {}
    this.connected = true
    console.log(`[PageAgent v${chrome.runtime.getManifest().version}] 桥已连接`, this.base)
    const reader = resp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        this._handle(line)
      }
    }
    throw new Error('stream ended')
  }
  async _markDisconnected() {
    try {
      await chrome.storage.sync.set({ pageagent_connected: false })
    } catch {}
  }
  _handle(line) {
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'kicked') {
      console.log(`[PageAgent] 本机 ${msg.role ?? ''} 席位已被同角色新连接接管`)
      try {
        chrome.storage.sync.set({
          pageagent_kicked_at: Date.now(),
          pageagent_kicked_role: msg.role ?? '',
        })
      } catch {}
      return
    }
    if (msg.type !== 'rpc') return
    const id = msg.id
    ;(async () => {
      let result, error
      try {
        result = await this.handler(msg.method, msg.params)
      } catch (e) {
        error = { code: e.code ?? -32002, message: e.message ?? String(e) }
      }
      try {
        await fetch(this.base + '/response', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, result, error }),
        })
      } catch {}
    })()
  }
  close() {
    this.closed = true
  }
  async reconnect(base) {
    this.base = (base || PAGEAGENT_BRIDGE_DEFAULT).replace(/\/$/, '')
    this.closed = false
    this._startLoop()
  }
}
