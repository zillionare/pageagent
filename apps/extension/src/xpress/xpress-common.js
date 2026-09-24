// xhs-common.js — 小红书 DOM 工具（无依赖，暴露 window.xpressCommon）
;(() => {
  try { console.log('[xpress v0.2.1] common start on', location.href) } catch {}
  const C = {}

  C.sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  C.randDelay = (base) => base + Math.floor(Math.random() * base * 0.5) + 5

  // 执行进度上报（经 background 转发到服务器 /log —— 页面 CSP 会拦截 content script
// 直接 fetch 127.0.0.1，但 background 不受页面 CSP 约束且有 host 权限）
  C.progress = (step, detail = '') => {
    try {
      chrome.runtime.sendMessage({ type: 'xpress-log', step, detail }).catch(() => {})
    } catch {}
  }

  // 随机取一个人类化的真实点击坐标（轻微偏移）
  C.pt = (el) => {
    const r = el.getBoundingClientRect()
    return {
      x: r.left + r.width * (0.3 + Math.random() * 0.4),
      y: r.top + r.height * (0.3 + Math.random() * 0.4),
    }
  }

  // 可见性判断（移植 xiaohongshu-mcp isElementVisible 的关键规则）
  C.isVisible = (el) => {
    if (!el) return false
    const style = el.getAttribute('style') ?? ''
    if (style.includes('display: none')) return false
    if (style.includes('visibility: hidden')) return false
    if (style.includes('left: -9999px') || style.includes('top: -9999px')) return false
    if (style.includes('opacity: 1e-05')) return false
    if (/opacity:\s*0(\s|;|$)/.test(style)) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    const rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  // 元素中心点是否被其他元素遮挡（用于弹层遮挡检测）
  C.isBlocked = (el) => {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return true
    const { x, y } = C.pt(el)
    const target = document.elementFromPoint(x, y)
    return !(target === el || el.contains(target))
  }

  // 文案匹配找元素
  C.findByText = (sel, text) => {
    return Array.from(document.querySelectorAll(sel)).find((el) => {
      const t = (el.textContent ?? '').trim()
      return t.includes(text) && C.isVisible(el) && !C.isBlocked(el)
    })
  }

  // 等待元素出现 (optionally 可见), [timeout] ms
  C.waitFor = async (sel, timeout = 10000, interval = 200) => {
    const t0 = Date.now()
    for (;;) {
      const el = document.querySelector(sel)
      if (el && C.isVisible(el)) return el
      if (Date.now() - t0 > timeout) throw new Error('等待元素超时: ' + sel)
      await C.sleep(interval)
    }
  }

  // 等待某条件为真（config: {check, timeout, interval}）
  C.waitUntil = async (check, timeout = 10000, interval = 200, label = '条件') => {
    const t0 = Date.now()
    for (;;) {
      if (await check()) return
      if (Date.now() - t0 > timeout) throw new Error(`等待条件超时: ${label} (${timeout}ms)`)
      await C.sleep(interval)
    }
  }

  // 模拟真实点击（完整事件序列 + 随机坐标）
  C.click = async (el) => {
    if (!el) throw new Error('click: 元素不存在')
    el.scrollIntoView({ block: 'center' })
    await C.sleep(150)
    const { x, y } = C.pt(el)
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, button: 0 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, button: 0 }))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.click()
    await C.sleep(C.randDelay(250))
  }

  // CDP 真实点击：经 background 用 chrome.debugger 发送 Input.dispatchMouseEvent，
  // 产生 isTrusted=true 的浏览器级事件，React/Vue 必响应（合成事件会被页面过滤）。
  C.cdpClick = async (elOrPoint) => {
    const pt = typeof elOrPoint === 'object' && 'x' in elOrPoint
      ? elOrPoint
      : C.pt(elOrPoint)
    try {
      const r = await chrome.runtime.sendMessage({ type: 'xpress-cdp-click', x: pt.x, y: pt.y })
      if (r?.error) throw new Error(r.error)
    } catch (e) {
      throw new Error('CDP 点击失败: ' + (e.message ?? e))
    }
    await C.sleep(150)
  }

  // CDP 原生文本输入：经 background 用 chrome.debugger 发送 Input.insertText，
  // 等价人类逐字键入（Draft.js 的 selection/state/段落全走原生管线，不会丢段错位）。
  // 关键：先 CDP 点击编辑器左上文本区立光标（点中心可能落在空白处），再轮询
  // getSelection().anchorNode 进入编辑器（最多 5s），确认光标立住再发文本。
  // text 可含 \n（行尾 background 发真回车键，大段间距，与手工回车一致）。
  C.cdpType = async (el, text) => {
    if (!text) return
    el.scrollIntoView({ block: 'center' })
    await C.sleep(200)
    const r = el.getBoundingClientRect()
    // 点第一行文字处（左上内缩），不是中心
    await C.cdpClick({ x: r.left + 30, y: r.top + 20 })
    await C.sleep(400)
    const t0 = Date.now()
    let anchored = false
    while (Date.now() - t0 < 5000) {
      try {
        const sel = getSelection()
        if (sel && el.contains(sel.anchorNode)) { anchored = true; break }
      } catch {}
      await C.sleep(300)
    }
    if (!anchored) throw new Error('CDP 聚焦失败：光标未进入编辑器')
    let resp
    try {
      resp = await chrome.runtime.sendMessage({ type: 'xpress-cdp-text', text })
    } catch (e) {
      throw new Error('CDP 输入失败: ' + (e.message ?? e))
    }
    if (resp?.error) throw new Error('CDP 输入失败: ' + resp.error)
    await C.sleep(400)
    return resp
  }

  // 穿透 closed shadow 查询按钮真实坐标（background 走 CDP DOM.getDocument pierce）
  C.shadowButtons = async () => {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'xpress-cdp-shadow' })
      if (r?.error) throw new Error(r.error)
      return (r?.buttons ?? []).filter((b) => typeof b.x === 'number')
    } catch {
      return []
    }
  }

  // 内容可编辑元素输入（逐字符 + 原生插入文本命令，最接近真实键入）。
  // 换行符用 insertParagraph 建段（insertText '\n' 会扰乱 Draft.js 的 selection，
  // 导致丢行/重复；批量建段则 state 不同步。逐字+段落命令组合最稳）。
  // 每段结束后把 selection 显式 collapse 到末尾：连续 insertParagraph 超过十几段后，
  // Draft.js 的 selection 会跳回文首，后续行覆盖第 1 行（实测 16 行处必现）。
  C.typeRich = async (el, text) => {
    el.focus()
    for (const ch of text) {
      let ok = false
      try {
        ok = ch === '\n'
          ? document.execCommand('insertParagraph', false, null)
          : document.execCommand('insertText', false, ch)
      } catch {}
      if (!ok) {
        if (ch === '\n') {
          el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        } else {
          el.textContent += ch
        }
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (ch === '\n') {
        // 段落后锚定光标到末尾，防止 selection 跳回文首。
        // el 可能已被 Draft 重渲染替换（detached）：先检查，掉了就重查，实在没有就跳过。
        try {
          let target = el
          if (!target.isConnected) {
            target = document.querySelector('.Modal-inner .public-DraftEditor-content[contenteditable="true"]')
              || document.querySelector('.WritePinV2-Form .public-DraftEditor-content[contenteditable="true"]')
              || document.querySelector('.WriteArea .public-DraftEditor-content[contenteditable="true"]')
          }
          if (!target || !target.isConnected) continue
          target.focus()
          const sel = getSelection()
          if (sel && target.contains(sel.anchorNode)) {
            sel.collapseToEnd()
          } else if (sel) {
            const range = document.createRange()
            range.selectNodeContents(target)
            range.collapse(false)
            sel.removeAllRanges()
            sel.addRange(range)
          }
        } catch {}
      }
      await C.sleep(C.randDelay(9))
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // 普通 input 元素输入：始终从原文重建目标值（不依赖 el.value 累加），
  // 每次只分发无 data 的 input 事件，避免页面自身的输入处理器再追加一遍导致逐字翻倍。
  C.typePlain = async (el, text) => {
    el.focus()
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    for (let i = 0; i < text.length; i++) {
      setter.call(el, text.slice(0, i + 1))
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await C.sleep(C.randDelay(9))
    }
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // 自动判断输入方式
  C.type = async (el, text) => {
    if (!text) return
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') return C.typeRich(el, text)
    return C.typePlain(el, text)
  }

  // 上传图片：把 dataUrl 数组转换成 File 并赋给 input[type=file]
  // （扩展无法读本地文件，图片由服务器转成 data URL 传入）
  C.setImageFiles = async (input, dataUrls) => {
    const dt = new DataTransfer()
    for (let i = 0; i < dataUrls.length; i++) {
      const blob = await (await fetch(dataUrls[i])).blob()
      const ext = (dataUrls[i].match(/data:([^;,]+)/)?.[1] ?? 'image/png').split('/')[1] ?? 'png'
      dt.items.add(new File([blob], `xhs_${i + 1}.${ext}`, { type: blob.type }))
    }
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }

  // 页面 URL 工具
  C.url = () => location.href
  C.isCreatorPublish = () => /creator\.xiaohongshu\.com\/publish\/publish/.test(location.href)

  // 关闭浮层：Esc → 点空白 → 摘节点
  C.dismissPopCover = async () => {
    const pop = () => document.querySelector('div.d-popover')
    if (!pop()) return
    ;(document.activeElement ?? document.body).blur()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    await C.sleep(250)
    if (!pop()) return
    const body = document.body
    const { x, y } = { x: innerWidth * 0.1 + Math.random() * 60, y: 20 + Math.random() * 60 }
    body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }))
    body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
    await C.sleep(250)
    const el = pop()
    if (el) el.remove()
  }

  window.xpressCommon = C
  try { console.log('[xpress v0.2.1] common injected on', location.href) } catch {}

  // MV3 keepalive：与 background 建立长连接端口。有小红书页面打开时，
  // 只要端口存活，service worker 就不会因空闲而被终止（保证桥一直在线）。
  const keepalive = () => {
    const port = chrome.runtime.connect({ name: 'xpress-keepalive' })
    port.onDisconnect.addListener(() => setTimeout(keepalive, 1000))
  }
  keepalive()
})()
void 0