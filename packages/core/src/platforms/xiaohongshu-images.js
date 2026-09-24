// 小红书多图同步处理器（quantclaw 移植自 xpress xhs-actions/xhs-publish）。
// 长文（target=article）走 background 内联逻辑；本文件只处理多图（target=image）：
// 开图文发布页 → 上传 1-18 张图 → 填标题/正文/tags → 点暂存存草稿（绝不自动点发布）。
// 前台 tab 跑，直接 el.click() 有效（xpress 的 CDP 是因为后台 tab，这里已激活）。

async function syncXiaohongshuImages(tab, content, helpers) {
  const { chrome, waitForTab } = helpers
  const IMAGE_URL = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image'

  await waitForTab(tab.id)
  try {
    await chrome.tabs.update(tab.id, { url: IMAGE_URL, active: true })
  } catch {}
  await waitForTab(tab.id)
  await new Promise(r => setTimeout(r, 3000))

  const images = Array.isArray(content.images) ? content.images : []
  if (!images.length || images.length > 18) {
    return { success: false, message: '图片需 1-18 张', tabId: tab.id }
  }
  const result = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillXiaohongshuImages,
    args: [content.title || '', content.body || content.markdown || '', images, content.tags || []],
    world: 'MAIN',
  })
  const r = result?.[0]?.result
  if (!r?.success) return { success: false, message: r?.error || '多图填稿失败', tabId: tab.id }
  return { success: true, message: `小红书多图已存草稿（${r.uploaded} 张）`, tabId: tab.id }
}

// 页面主世界执行：上传 + 填稿 + 暂存。只存草稿，绝不点发布。
async function fillXiaohongshuImages(title, body, images, tags) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const visible = el => {
    if (!el) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  async function waitUntil(fn, timeout = 15000, interval = 500) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      try { if (await fn()) return true } catch {}
      await sleep(interval)
    }
    return false
  }
  try {
    // 1. 确认图文态
    const isImageMode = () => {
      if (document.querySelector('.img-upload-area')) return true
      return Array.from(document.querySelectorAll('input[type="file"]'))
        .some(i => /png|jpe?g|webp|heic/i.test(i.accept ?? ''))
    }
    if (!await waitUntil(isImageMode, 30000, 500)) {
      return { success: false, error: '未能进入上传图文模式' }
    }
    await sleep(600)
    // 2. 上传图片（幂等补差）
    const countUp = () => document.querySelectorAll(
      '.img-preview-area .pr, .img-upload-item, .upload-preview img, [class*="preview"] img').length
    const have = countUp()
    const need = images.slice(have)
    if (have + need.length > 18) return { success: false, error: `已有 ${have} 张，再传超 18 张上限` }
    if (need.length) {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      const input = inputs.find(i => (i.accept ?? '').match(/image\/|\.png|\.jpe?g|\.webp|\.heic/)) ?? inputs[0]
      if (!input) return { success: false, error: '未找到图片上传输入框' }
      const dt = new DataTransfer()
      for (let i = 0; i < need.length; i++) {
        const blob = await (await fetch(need[i])).blob()
        const ext = (need[i].match(/data:([^;,]+)/)?.[1] ?? 'image/png').split('/')[1] ?? 'png'
        dt.items.add(new File([blob], `xhs_${have + i + 1}.${ext}`, { type: blob.type }))
      }
      input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (!await waitUntil(() => countUp() >= images.length, 90000, 400)) {
        return { success: false, error: '图片上传超时' }
      }
      await sleep(600)
    }
    // 3. 标题（≤20 字）
    const t = String(title).trim().slice(0, 20)
    if (t) {
      const titleEl = document.querySelector('input[placeholder="填写标题会有更多赞哦"]')
        || Array.from(document.querySelectorAll('div.d-input input')).find(visible)
      if (titleEl) {
        titleEl.focus()
        const proto = titleEl.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(titleEl, t)
        titleEl.dispatchEvent(new Event('input', { bubbles: true }))
        titleEl.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    await sleep(300)
    // 4. 正文
    const sels = ['div[role="textbox"][contenteditable="true"]', 'div.tiptap[contenteditable="true"]', 'div.ql-editor']
    let contentEl = null
    for (const sel of sels) {
      contentEl = Array.from(document.querySelectorAll(sel)).find(visible)
      if (contentEl) break
    }
    if (!contentEl) return { success: false, error: '未找到正文输入框' }
    contentEl.focus()
    contentEl.textContent = ''
    contentEl.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(300)
    for (const ch of String(body)) {
      let ok = false
      try { ok = ch === '\n' ? document.execCommand('insertParagraph', false, null) : document.execCommand('insertText', false, ch) } catch {}
      if (!ok) {
        if (ch === '\n') contentEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        else contentEl.textContent += ch
        contentEl.dispatchEvent(new Event('input', { bubbles: true }))
      }
      await sleep(9)
    }
    contentEl.dispatchEvent(new Event('input', { bubbles: true }))
    // 5. 标签（# + 联想第一项）
    const list = (tags ?? []).flatMap(x => String(x).split(/[,，＃#\r\n]+/)).map(s => s.trim()).filter(Boolean)
    if (list.length) {
      await sleep(1000)
      const range = document.createRange()
      range.selectNodeContents(contentEl)
      range.collapse(false)
      const sel = getSelection()
      sel.removeAllRanges()
      sel.addRange(range)
      contentEl.focus()
      try { document.execCommand('insertParagraph', false, null) } catch {}
      try { document.execCommand('insertParagraph', false, null) } catch {}
      await sleep(300)
      for (const raw of list) {
        const tag = raw.replace(/^#+/, '')
        for (const ch of '#' + tag) {
          try { document.execCommand('insertText', false, ch) } catch { contentEl.textContent += ch }
          await sleep(15)
        }
        await sleep(700)
        const first = document.querySelector('#creator-editor-topic-container .item')
        if (first && visible(first)) first.click()
        else {
          try { document.execCommand('insertText', false, ' ') } catch {}
        }
        await sleep(500)
      }
    }
    // 6. 点暂存离开（只存草稿，绝不点发布）
    const saveBtn = (() => {
      for (const w of Array.from(document.querySelectorAll('xhs-publish-btn'))) {
        if (!visible(w)) continue
        if (w.getAttribute('is-save-draft') !== 'true') continue
        if (w.getAttribute('save-disabled') === 'true') return null
        return w
      }
      return null
    })()
    if (!saveBtn) return { success: false, error: '暂存离开不可点' }
    saveBtn.scrollIntoView({ block: 'center' })
    await sleep(300)
    const r = saveBtn.getBoundingClientRect()
    // shadow 内的按钮 JS 点不到， dispatch 真实鼠标事件
    for (const t of ['mousedown', 'mouseup', 'click']) {
      saveBtn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window,
        clientX: r.left + r.width * 0.25, clientY: r.top + r.height / 2, button: 0 }))
    }
    await sleep(1000)
    const confirm = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
      if (!visible(el)) return false
      const tx = (el.textContent ?? '').trim()
      return tx === '暂存后离开' || tx === '暂存并离开' || (tx.includes('暂存') && tx.includes('离开'))
    })
    if (confirm) confirm.click()
    await sleep(1000)
    return { success: true, uploaded: countUp() }
  }
  catch (e) { return { success: false, error: e?.message ?? String(e) } }
}

const XiaohongshuImagesPlatform = {
  id: 'xiaohongshu-images',
  name: 'XiaohongshuImages',
  title: '小红书多图',
}

export { XiaohongshuImagesPlatform, syncXiaohongshuImages }
