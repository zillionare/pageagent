// PageAgent 桥客户端（quantclaw 移植自 xpress bridge-client.mjs）。
// SW 启动后连 CF 桥（默认 http://192.168.0.102:8787），收 rpc → 跑抓取 → POST /response。
// version 上报：server 握手认 hasPageAgent（旧 xpress 认 hasArticle）。

const PAGEAGENT_BRIDGE_DEFAULT = 'http://192.168.0.102:8787'

export async function ensurePageAgentBridge(handler, opts = {}) {
  const base = opts.base
    ?? (await chrome.storage.sync.get({ pageagent_bridge: PAGEAGENT_BRIDGE_DEFAULT }).catch(() => ({}))).pageagent_bridge
    ?? PAGEAGENT_BRIDGE_DEFAULT
  const client = new PageAgentBridgeClient(base, handler)
  client.start()
  return client
}

class PageAgentBridgeClient {
  constructor(base, handler) {
    this.base = base
    this.handler = handler
    this.connected = false
    this.closed = false
    this.looping = false
  }
  start() { this._startLoop() }
  _startLoop() {
    if (this.looping) return
    this.looping = true
    this._loop().finally(() => { this.looping = false })
  }
  wake() { if (!this.closed) this._startLoop() }
  async _loop() {
    while (!this.closed) {
      try {
        await this._connectOnce()
      } catch (e) {
        console.log(`[PageAgent v${chrome.runtime.getManifest().version}] 桥连接失败`, e.message)
      }
      this.connected = false
      await new Promise(r => setTimeout(r, 5000))
    }
  }
  async _connectOnce() {
    const resp = await fetch(this.base + '/connect', { method: 'POST' })
    if (resp.status === 409) {
      let occupant = '?'
      try { occupant = (await resp.json()).occupant ?? '?' } catch {}
      this.connected = false
      console.log('[PageAgent] 桥被占用:', occupant)
      throw new Error('occupied by ' + occupant)
    }
    if (!resp.ok || !resp.body) throw new Error('connect ' + resp.status)
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
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        this._handle(line)
      }
    }
    throw new Error('stream ended')
  }
  _handle(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return }
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
  close() { this.closed = true }
}
