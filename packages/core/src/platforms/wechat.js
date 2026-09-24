import { injectUtils } from './common.js'

// 微信公众号平台配置
const WechatPlatform = {
  id: 'wechat',
  name: 'WeChat',
  icon: 'https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico',
  url: 'https://mp.weixin.qq.com',
  // 先打开草稿箱，再自动点击新建
  publishUrl:
    'https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10',
  title: '微信公众号',
  type: 'wechat',
}

function getEditorArea(editor) {
  return (editor?.clientHeight || 0) * (editor?.clientWidth || 0)
}

function isWechatTitleEditor(editor, titleEditor) {
  return (
    Boolean(editor) && (editor === titleEditor || Boolean(editor.closest?.('.title-editor__input')))
  )
}

function pickWechatBodyProseMirrorCandidate(nodes, { titleInput, titleEditor } = {}) {
  const bodyCandidates = nodes.filter(editor => !isWechatTitleEditor(editor, titleEditor))
  if (bodyCandidates.length === 0) return null
  if (bodyCandidates.length === 1) return bodyCandidates[0]

  const byPlaceholder = bodyCandidates.find(editor =>
    (editor.textContent || '').includes('从这里开始写正文')
  )
  if (byPlaceholder) return byPlaceholder

  if (titleInput) {
    const band = titleInput.getBoundingClientRect()
    const belowTitle = bodyCandidates.filter(editor => {
      const rect = editor.getBoundingClientRect()
      return rect.top >= band.bottom - 8
    })
    if (belowTitle.length > 0) {
      return belowTitle.sort((a, b) => getEditorArea(b) - getEditorArea(a))[0]
    }
  }

  return bodyCandidates.sort((a, b) => getEditorArea(b) - getEditorArea(a))[0]
}

// 微信公众号内容填充函数（在页面主世界中执行）
// 注意：需要先调用 injectUtils 注入 window.waitFor
async function fillWechatContent(title, htmlBody, desc, thumb) {
  /**
   * 后台改版后可能存在多个 `.ProseMirror`（标题区也可能是 ProseMirror），
   * `querySelector('.ProseMirror')` 常会命中标题编辑器，导致正文 HTML 被贴进标题。
   * 另外，正文编辑器有时会比标题编辑器晚挂载，这时也要继续等待，不能把唯一节点误判成正文。
   */
  function pickWechatBodyProseMirror() {
    // 内联辅助函数，确保 chrome.scripting.executeScript 注入时可用
    function getEditorArea(editor) {
      return (editor?.clientHeight || 0) * (editor?.clientWidth || 0)
    }
    function isWechatTitleEditor(editor, titleEditor) {
      return (
        Boolean(editor) &&
        (editor === titleEditor || Boolean(editor.closest?.('.title-editor__input')))
      )
    }
    function pickCandidate(nodes, { titleInput, titleEditor } = {}) {
      const bodyCandidates = nodes.filter(editor => !isWechatTitleEditor(editor, titleEditor))
      if (bodyCandidates.length === 0) return null
      if (bodyCandidates.length === 1) return bodyCandidates[0]

      const byPlaceholder = bodyCandidates.find(editor =>
        (editor.textContent || '').includes('从这里开始写正文')
      )
      if (byPlaceholder) return byPlaceholder

      if (titleInput) {
        const band = titleInput.getBoundingClientRect()
        const belowTitle = bodyCandidates.filter(editor => {
          const rect = editor.getBoundingClientRect()
          return rect.top >= band.bottom - 8
        })
        if (belowTitle.length > 0) {
          return belowTitle.sort((a, b) => getEditorArea(b) - getEditorArea(a))[0]
        }
      }

      return bodyCandidates.sort((a, b) => getEditorArea(b) - getEditorArea(a))[0]
    }

    const nodes = [...document.querySelectorAll('.ProseMirror')]
    if (nodes.length === 0) return null

    const titleInput = document.querySelector('#title')
    const titleEditor = document.querySelector('.title-editor__input .ProseMirror')
    return pickCandidate(nodes, { titleInput, titleEditor })
  }

  async function waitForBodyEditor(timeout = 15000) {
    const start = Date.now()
    while (Date.now() - start < timeout) {
      const el = pickWechatBodyProseMirror()
      if (el) return el
      await new Promise(r => setTimeout(r, 100))
    }
    return pickWechatBodyProseMirror()
  }

  try {
    const titleInput = await window.waitFor('#title', 15000)
    const titleEditor = await window.waitFor('.title-editor__input .ProseMirror', 15000)

    // 填充标题（优先于正文，避免焦点停留在标题区的 ProseMirror）
    if ((titleInput || titleEditor) && title) {
      if (titleEditor) {
        titleEditor.focus()
        titleEditor.innerHTML = ''
        titleEditor.textContent = title
        titleEditor.dispatchEvent(new Event('input', { bubbles: true }))
        titleEditor.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (titleInput) {
        titleInput.focus()
      }
      const nativeSetter =
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set ||
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
      if (titleInput && nativeSetter) {
        nativeSetter.call(titleInput, title)
      } else if (titleInput) {
        titleInput.value = title
      }
      if (titleInput) {
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        titleInput.dispatchEvent(new Event('change', { bubbles: true }))
      }
      console.log('[COSE] 微信标题已填充:', title)
    }

    await new Promise(r => setTimeout(r, 300))

    const editor = await waitForBodyEditor(15000)
    if (!editor) {
      return { success: false, error: '未找到正文编辑器' }
    }

    // 填充正文内容
    if (editor && htmlBody) {
      editor.focus()

      // 清空现有占位符内容
      if (editor.textContent.includes('从这里开始写正文')) {
        editor.innerHTML = ''
      }

      const plainText = htmlBody.replace(/<[^>]*>/g, '')
      const hasImageInSource = /<img\b/i.test(htmlBody)
      let injected = false
      let injectError = ''

      // 优先使用微信编辑器 JSAPI。合成 Ctrl+V 事件不会触发真实粘贴；
      // 直接写 innerHTML 也不会可靠同步到 ProseMirror 的文档模型。
      if (window.__MP_Editor_JSAPI__ && typeof window.__MP_Editor_JSAPI__.invoke === 'function') {
        injected = await new Promise(resolve => {
          let done = false
          const finish = (ok, err) => {
            if (done) return
            done = true
            if (err) injectError = err.message || String(err)
            resolve(ok)
          }

          try {
            window.__MP_Editor_JSAPI__.invoke({
              apiName: 'mp_editor_set_content',
              apiParam: { content: htmlBody },
              sucCb: () => finish(true),
              errCb: err => finish(false, err),
            })
          } catch (err) {
            finish(false, err)
          }

          setTimeout(() => finish(false, new Error('mp_editor_set_content 调用超时')), 5000)
        })

        if (injected) {
          console.log('[COSE] 微信内容已通过 mp_editor_set_content 注入')
          await new Promise(r => setTimeout(r, 800))
        } else {
          console.warn('[COSE] mp_editor_set_content 注入失败:', injectError)
        }
      }

      if (!injected) {
        if (hasImageInSource) {
          console.warn('[COSE] 正文包含图片，但微信 JSAPI 不可用；paste 兜底可能无法保留图片')
        }

        const dt = new DataTransfer()
        dt.setData('text/html', htmlBody)
        dt.setData('text/plain', plainText)

        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt,
        })

        editor.dispatchEvent(pasteEvent)
        console.log('[COSE] 微信内容已通过 paste 事件注入（兜底方案）')

        // 等待内容渲染
        await new Promise(r => setTimeout(r, 800))
      }

      // 验证内容是否注入成功
      const wordCount = editor.textContent?.trim().length || 0
      const imageCount = editor.querySelectorAll?.('img').length || 0
      const hasEditorContent = wordCount > 0 || imageCount > 0 || injected

      // quantclaw: 摘要 + 封面入口诊断
      let descFilled = false
      if (desc) {
        const descBox = document.querySelector('textarea.js_desc, textarea[placeholder*="摘要"], textarea[placeholder*="选填"]')
        if (descBox) {
          descBox.focus()
          const proto = window.HTMLTextAreaElement.prototype
          Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(descBox, desc)
          descBox.dispatchEvent(new Event('input', { bubbles: true }))
          descBox.dispatchEvent(new Event('change', { bubbles: true }))
          descFilled = true
        }
      }
      // 封面：找入口（只诊断+回传，不自动上传；上传需素材库两步，下一版）
      const coverDiag = {
        labels: Array.from(document.querySelectorAll('label')).filter(el => (el.textContent ?? '').includes('封面')).length,
        fileInputs: Array.from(document.querySelectorAll('input[type="file"]')).length,
        hasThumb: !!thumb,
      }

      return {
        success: hasEditorContent,
        error: hasEditorContent ? undefined : injectError || '正文注入后未检测到有效内容',
        wordCount,
        imageCount,
        titleFilled: titleInput?.value === title || titleEditor?.textContent?.trim() === title,
        descFilled,
        coverDiag,
      }
    }

    return { success: false, error: '内容为空' }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// 微信公众号封面：点击封面区让输入框现身 → 只认 bmp 变体 input 直塞 → 等裁剪框 → 点确认 → 等生效
function wechatSetCoverByDrop(coverUrl) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const realDialog = () => {
      const hit = Array.from(document.querySelectorAll('.weui-desktop-dialog, [role="dialog"]')).filter(vis)
      return hit.length ? hit[hit.length - 1] : null
    }
    const coverInputs = () => Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(i => /bmp/i.test(i.accept || ''))
    const dbg = {}
    try {
      const resp = await fetch(coverUrl)
      if (!resp.ok) return { ok: false, err: 'fetch ' + resp.status }
      const blob = await resp.blob()
      const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0]
      const file = new File([blob], `cover.${ext}`, { type: blob.type || 'image/jpeg' })
      // 点击封面区，触发其懒加载的封面 input
      const area = document.querySelector('#js_cover_area') || document.querySelector('.js_cover_btn_area')
      if (!area) return { ok: false, err: 'no-cover-area' }
      try { area.scrollIntoView({ block: 'center' }) } catch {}
      await sleep(300)
      const clickTarget = document.querySelector('.js_cover_btn_area') || area
      try { clickTarget.click() } catch {}
      await sleep(1200)
      dbg.inputsAfterClick = Array.from(document.querySelectorAll('input[type="file"]'))
        .map(i => String(i.accept || '').slice(0, 50))
      let inputs = coverInputs()
      if (!inputs.length) {
        // 再点一次 / 等一会
        try { clickTarget.click() } catch {}
        await sleep(1500)
        inputs = coverInputs()
        dbg.inputsAfterClick2 = Array.from(document.querySelectorAll('input[type="file"]'))
          .map(i => String(i.accept || '').slice(0, 50))
      }
      let dlg = null
      const tried = []
      for (const inp of inputs) {
        const dt = new DataTransfer()
        dt.items.add(file)
        try { inp.files = dt.files } catch {}
        inp.dispatchEvent(new Event('change', { bubbles: true }))
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        await sleep(1800)
        dlg = realDialog()
        tried.push({ accept: String(inp.accept || '').slice(0, 40), dlg: !!dlg })
        if (dlg) break
      }
      dbg.tried = tried
      let crop = null
      if (dlg) {
        const findOk = () => {
          const prim = dlg.querySelector('.weui-desktop-dialog__ft .weui-desktop-btn_primary')
            || dlg.querySelector('.weui-desktop-btn_primary')
          if (prim && vis(prim) && !prim.disabled) return prim
          return Array.from(dlg.querySelectorAll('button')).filter(vis)
            .find(b => /确定|确认|完成|保存|应用/.test((b.textContent || '').trim()) && !b.disabled)
        }
        let okBtn = null
        const t2 = Date.now()
        while (Date.now() - t2 < 10000) {
          okBtn = findOk()
          if (okBtn) break
          await sleep(400)
        }
        if (okBtn) {
          crop = { clicked: (okBtn.textContent || '').trim().slice(0, 8) }
          okBtn.click()
          await sleep(2000)
        } else {
          crop = { err: 'no-confirm-btn', btns: Array.from(dlg.querySelectorAll('button')).filter(vis).map(b => (b.textContent || '').trim().slice(0, 8)).slice(0, 10) }
        }
      } else {
        crop = { err: inputs.length ? 'no-dialog-after-file' : 'no-cover-input' }
      }
      // 等封面预览出现
      const t0 = Date.now()
      while (Date.now() - t0 < 30000) {
        const prev = document.querySelector('.js_cover_preview_new') || document.querySelector('.js_cover_preview_square')
        if (prev && vis(prev)) {
          const bg = (prev.style && prev.style.backgroundImage) || ''
          if (/url\(/.test(bg) && !/url\(["']{2}\)/.test(bg) && !/url\(\)/.test(bg)) return { ok: true, via: 'preview-bg', crop, dbg }
          const img = prev.querySelector('img')
          if (img && img.src) return { ok: true, via: 'preview-img', crop, dbg }
        }
        await sleep(800)
      }
      return { ok: false, err: 'cover-preview-timeout', crop, dbg }
    } catch (e) {
      return { ok: false, err: String(e && e.message || e), dbg }
    }
  })()
}

// 裁剪框确认（页面主世界）：等 .weui-desktop-dialog 出现 → 点主按钮「确认」
function clickWechatCropConfirm() {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const realDialog = () => {
      const hit = Array.from(document.querySelectorAll('.weui-desktop-dialog, [role="dialog"]')).filter(vis)
      return hit.length ? hit[hit.length - 1] : null
    }
    const t0 = Date.now()
    let dlg = null
    while (Date.now() - t0 < 10000) {
      dlg = realDialog()
      if (dlg) break
      await sleep(400)
    }
    if (!dlg) return { ok: false, err: 'no-crop-dialog' }
    const findOk = () => {
      const prim = dlg.querySelector('.weui-desktop-dialog__ft .weui-desktop-btn_primary')
        || dlg.querySelector('.weui-desktop-btn_primary')
      if (prim && vis(prim) && !prim.disabled) return prim
      return Array.from(dlg.querySelectorAll('button')).filter(vis)
        .find(b => /确定|确认|完成|保存|应用/.test((b.textContent || '').trim()) && !b.disabled)
    }
    let okBtn = null
    const t1 = Date.now()
    while (Date.now() - t1 < 8000) {
      okBtn = findOk()
      if (okBtn) break
      await sleep(400)
    }
    if (!okBtn) return { ok: false, err: 'no-confirm-btn', btns: Array.from(dlg.querySelectorAll('button')).filter(vis).map(b => (b.textContent || '').trim().slice(0, 8)).slice(0, 10) }
    okBtn.click()
    return { ok: true, clicked: (okBtn.textContent || '').trim().slice(0, 8) }
  })()
}

// 设文件后如果没弹窗，补发 change（有的实现不自动派发）
function nudgeWechatCoverInput() {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const realDialog = () => Array.from(document.querySelectorAll('.weui-desktop-dialog, [role="dialog"]')).filter(vis).length > 0
    await sleep(900)
    if (realDialog()) return { dialog: true }
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    const inp = inputs.filter(i => /bmp/i.test(i.accept || '')).pop() || inputs[inputs.length - 1]
    if (!inp) return { dialog: false, err: 'no-input' }
    inp.dispatchEvent(new Event('change', { bubbles: true }))
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(1600)
    return { dialog: realDialog(), nudged: true }
  })()
}

// 等封面预览生效（页面主世界）
function waitWechatCoverPreview() {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const t0 = Date.now()
    while (Date.now() - t0 < 30000) {
      const prev = document.querySelector('.js_cover_preview_new') || document.querySelector('.js_cover_preview_square')
      if (prev && vis(prev)) {
        const bg = (prev.style && prev.style.backgroundImage) || ''
        if (/url\(/.test(bg) && !/url\(["']{2}\)/.test(bg) && !/url\(\)/.test(bg)) return { ok: true, via: 'preview-bg' }
        const img = prev.querySelector('img')
        if (img && img.src) return { ok: true, via: 'preview-img' }
      }
      await sleep(800)
    }
    return { ok: false, err: 'cover-preview-timeout' }
  })()
}

// 封面（SW 侧）：下载封面→CDP 真实点击封面区→拦文件选择器→设文件→裁剪确认→等生效
async function setWechatCoverViaCDP(tabId, coverUrl, chrome) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const dbg = {}
  // 1. 下载封面到磁盘
  const extM = String(coverUrl).match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i)
  const filename = `cf-cover-${Date.now()}.${(extM && extM[1] || 'jpg').toLowerCase()}`
  const dlId = await chrome.downloads.download({ url: coverUrl, filename, saveAs: false })
  let absPath = null
  const t0 = Date.now()
  for (;;) {
    const [it] = await chrome.downloads.search({ id: dlId })
    if (it && it.state === 'complete' && it.filename) { absPath = it.filename; break }
    if (it && (it.state === 'interrupted' || it.error)) throw new Error('下载失败: ' + (it.error || it.state))
    if (Date.now() - t0 > 25000) throw new Error('下载超时')
    await sleep(400)
  }
  dbg.path = String(absPath).slice(-40)
  // 2. attach debugger + 拦 chooser
  await chrome.debugger.attach({ tabId }, '1.3')
  const onEvent = (source, method, params) => {
    if (source.tabId === tabId && method === 'Page.fileChooserOpened') dbg.chooser = params
  }
  try {
    await chrome.debugger.sendCommand({ tabId }, 'DOM.enable')
    await chrome.debugger.sendCommand({ tabId }, 'Page.enable')
    await chrome.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true })
    // 3. 封面区坐标 + CDP 真实点击（带用户激活）
    const [{ result: pt }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const el = document.querySelector('.js_cover_btn_area') || document.querySelector('#js_cover_area') || document.querySelector('.select-cover__btn')
        if (!el) return null
        try { el.scrollIntoView({ block: 'center' }) } catch {}
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) }
      },
      world: 'MAIN',
    })
    if (!pt) throw new Error('未找到封面区')
    dbg.pt = pt
    chrome.debugger.onEvent.addListener(onEvent)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 })
      await sleep(90)
    }
    const t1 = Date.now()
    while (Date.now() - t1 < 8000 && !dbg.chooser) await sleep(200)
    if (!dbg.chooser) {
      dbg.afterClickInputs = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => Array.from(document.querySelectorAll('input[type="file"]')).map(i => String(i.accept || '').slice(0, 50)),
        world: 'MAIN',
      }).then(r => r[0].result)
      return { ok: false, err: 'no-file-chooser', dbg }
    }
    await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', { files: [absPath], backendNodeId: dbg.chooser.backendNodeId })
    await sleep(1200)
    try {
      const [{ result: nudge }] = await chrome.scripting.executeScript({ target: { tabId }, func: nudgeWechatCoverInput, world: 'MAIN' })
      dbg.nudge = nudge
    } catch {}
    await sleep(1200)
    // 4. 裁剪确认
    const [{ result: crop }] = await chrome.scripting.executeScript({ target: { tabId }, func: clickWechatCropConfirm, world: 'MAIN' })
    dbg.crop = crop
    await sleep(2500)
    // 5. 等封面预览
    const [{ result: prev }] = await chrome.scripting.executeScript({ target: { tabId }, func: waitWechatCoverPreview, world: 'MAIN' })
    return { ok: !!(prev && prev.ok), crop, preview: prev, dbg }
  } finally {
    try { chrome.debugger.onEvent.removeListener(onEvent) } catch {}
    try { await chrome.debugger.detach({ tabId }) } catch {}
  }
}

// 微信公众号「原文链接」字段（正文禁外链，唯一出路）
function wechatSetSourceUrl(blogUrl) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const dbg = {}
    const findInput = () => {
      const all = Array.from(document.querySelectorAll('input'))
        .filter(i => !['checkbox', 'radio', 'file', 'hidden', 'submit', 'button'].includes((i.type || 'text')))
      return all.find(i => /url|source|链接|原文/i.test((i.name || '') + String(i.className || '') + (i.placeholder || '')))
    }
    try {
      let inp = findInput()
      if (!inp) {
        // 勾选/点击「原文链接」开关后 input 才会出现
        const toggle = document.querySelector('input[name="source_url_checked"]')
          || Array.from(document.querySelectorAll('label, span, a, button')).find(el => (el.textContent || '').trim() === '原文链接' && vis(el))
        if (toggle) {
          try { toggle.click() } catch {}
          await sleep(800)
          inp = findInput()
        }
      }
      dbg.found = !!inp
      if (!inp) {
        dbg.urlLikeInputs = Array.from(document.querySelectorAll('input')).map(i => ({
          type: i.type, name: i.name, cls: String(i.className).slice(0, 40), ph: (i.placeholder || '').slice(0, 20), vis: vis(i),
        })).slice(0, 30)
        return { ok: false, err: 'no-url-input', dbg }
      }
      inp.focus()
      const proto = inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set
      if (setter) setter.call(inp, blogUrl); else inp.value = blogUrl
      inp.dispatchEvent(new Event('input', { bubbles: true }))
      inp.dispatchEvent(new Event('change', { bubbles: true }))
      inp.dispatchEvent(new Event('blur', { bubbles: true }))
      await sleep(500)
      return { ok: true, value: String(inp.value || '').slice(0, 80) }
    } catch (e) {
      return { ok: false, err: String(e && e.message || e), dbg }
    }
  })()
}

// 微信公众号保存草稿函数（页面主世界中执行）：点击 + 等保存成功提示
function saveWechatDraft() {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const findBtn = () => Array.from(document.querySelectorAll('button')).find(b =>
      (b.textContent || '').includes('保存为草稿'))
    const btn = findBtn()
    if (!btn) return { success: false, error: '未找到保存按钮' }
    btn.click()
    console.log('[COSE] 已点击保存为草稿')
    // 等成功提示（toast/文案），最多 15s
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      const nodes = Array.from(document.querySelectorAll('[class*="toast" i], [class*="tips" i], .weui-desktop-toast, [class*="message" i]'))
      const hit = nodes.find(n => vis(n) && /保存成功|已保存|保存为草稿成功|草稿保存成功/.test(n.textContent || ''))
      if (hit) return { success: true, via: 'toast' }
      await sleep(700)
    }
    return { success: false, error: '保存提示未出现（可能仍在保存）' }
  })()
}

/**
 * 微信公众号同步处理器
 * @param {object} tab - Chrome tab 对象（初始为首页）
 * @param {object} content - 内容对象 { title, body, markdown, wechatHtml }
 * @param {object} helpers - 帮助函数 { chrome, waitForTab, addTabToSyncGroup, PLATFORMS }
 * @returns {Promise<{success: boolean, message?: string, tabId?: number}>}
 */
async function syncWechatContent(tab, content, helpers) {
  const { chrome, waitForTab } = helpers

  // 步骤1：等待首页加载完成
  console.log('[COSE] 微信公众号等待页面加载')
  await waitForTab(tab.id)

  // 注入公共工具函数（waitFor, setInputValue）
  await injectUtils(chrome, tab.id)

  // 步骤2：使用 MutationObserver 监听获取 token
  console.log('[COSE] 开始检测 token...')
  const [tokenResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return new Promise(resolve => {
        // 先检查当前页面是否已有 token
        const checkToken = () => {
          const urlMatch = window.location.href.match(/token=(\d+)/)
          if (urlMatch) return urlMatch[1]

          const links = document.querySelectorAll('a[href*="token"]')
          for (const link of links) {
            const match = link.href?.match(/token=(\d+)/)
            if (match) return match[1]
          }

          const scripts = document.querySelectorAll('script:not([src])')
          for (const script of scripts) {
            const content = script.textContent
            const match = content.match(/token["']?\s*[:=]\s*["']?(\d+)["']?/i)
            if (match && match[1]) return match[1]
          }
          return null
        }

        const existing = checkToken()
        if (existing) return resolve(existing)

        // 使用 MutationObserver 监听 DOM 变化
        const observer = new MutationObserver(() => {
          const token = checkToken()
          if (token) {
            observer.disconnect()
            resolve(token)
          }
        })
        observer.observe(document.documentElement, { childList: true, subtree: true })

        // 超时保护
        setTimeout(() => {
          observer.disconnect()
          resolve(checkToken())
        }, 10000)
      })
    },
    world: 'MAIN',
  })

  const token = tokenResult?.result

  if (!token) {
    console.error('[COSE] 无法从页面获取 token')
    return { success: false, message: '无法获取微信公众号 token，请确保已登录', tabId: tab.id }
  }

  // 步骤3：跳转到编辑器页面
  const editorUrl = `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=10&token=${token}&lang=zh_CN`
  console.log('[COSE] 获取到 token:', token, '跳转到编辑器')

  await chrome.tabs.update(tab.id, { url: editorUrl })
  await waitForTab(tab.id)

  // 使用剪贴板 HTML（带完整样式）或降级到 body
  const htmlContent = content.wechatHtml || content.body
  console.log('[COSE] 微信 HTML 内容长度:', htmlContent?.length || 0)

  // 步骤4：使用 MutationObserver 监听编辑器出现
  console.log('[COSE] 正在等待编辑器...')
  const [editorResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      return new Promise(resolve => {
        const existing = document.querySelector('.ProseMirror')
        if (existing) return resolve(true)

        const observer = new MutationObserver(() => {
          if (document.querySelector('.ProseMirror')) {
            observer.disconnect()
            resolve(true)
          }
        })
        observer.observe(document.documentElement, { childList: true, subtree: true })

        setTimeout(() => {
          observer.disconnect()
          resolve(!!document.querySelector('.ProseMirror'))
        }, 15000)
      })
    },
    world: 'MAIN',
  })

  if (!editorResult?.result) {
    console.error('[COSE] 编辑器等待超时')
    return { success: false, message: '编辑器加载超时', tabId: tab.id }
  }

  console.log('[COSE] 编辑器已就绪，开始注入内容...')

  // 页面跳转后需要重新注入工具函数（waitFor, setInputValue）
  await injectUtils(chrome, tab.id)

  // 步骤5：填充内容
  let result
  try {
    result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillWechatContent,
      args: [content.title, htmlContent, content.desc || null, content.thumb || null],
      world: 'MAIN',
    })
  } catch (e) {
    console.error('[COSE] executeScript 执行失败:', e)
    return { success: false, message: '脚本执行失败: ' + e.message, tabId: tab.id }
  }

  const fillResult = result?.[0]?.result
  console.log('[COSE] 微信填充结果:', JSON.stringify(fillResult, null, 2))

  if (!fillResult?.success) {
    console.error('[COSE] 微信内容填充失败:', fillResult?.error)
    return { success: false, message: fillResult?.error || '内容填充失败', tabId: tab.id }
  }

  console.log('[COSE] 微信内容填充成功，字数:', fillResult.wordCount)
  const wxBits = []
  if (fillResult.descFilled) wxBits.push('摘要OK')
  if (fillResult.coverDiag) wxBits.push(`封面入口:label${fillResult.coverDiag.labels}/input${fillResult.coverDiag.fileInputs}`)
  var wxSuffix = wxBits.length ? `（${wxBits.join('，')}）` : ''

  // 步骤5b：封面（frontmatter thumb → CDP 拦文件选择器上传）
  let coverRes = null
  if (content.thumb) {
    try {
      coverRes = await setWechatCoverViaCDP(tab.id, content.thumb, chrome)
    } catch (e) { coverRes = { ok: false, err: String(e?.message ?? e) } }
    console.log('[COSE] 微信封面结果:', JSON.stringify(coverRes))
    await new Promise(resolve => setTimeout(resolve, 1500))
  }

  // 步骤5c：原文链接字段（公众号正文禁外链）
  let srcRes = null
  if (content.blogUrl) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: wechatSetSourceUrl,
        args: [content.blogUrl],
        world: 'MAIN',
      })
      srcRes = result
    } catch (e) { srcRes = { ok: false, err: String(e?.message ?? e) } }
    console.log('[COSE] 微信原文链接结果:', JSON.stringify(srcRes))
  }

  // 步骤6：保存为草稿（点击 + 验证提示）
  await new Promise(resolve => setTimeout(resolve, 500))
  let saveRes = null
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: saveWechatDraft,
      world: 'MAIN',
    })
    saveRes = result
  } catch (e) { saveRes = { success: false, error: String(e?.message ?? e) } }
  console.log('[COSE] 微信保存结果:', JSON.stringify(saveRes))

  // 结果上报桥日志
  try {
    const bb = await chrome.storage.sync.get({ pageagent_bridge: 'http://192.168.0.102:8787' })
    await fetch(((bb.pageagent_bridge || 'http://192.168.0.102:8787').replace(/\/$/, '')) + '/log', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ step: '[pageagent] wechat-done', detail: JSON.stringify({
        cover: coverRes, sourceUrl: srcRes, save: saveRes, wordCount: fillResult.wordCount, imageCount: fillResult.imageCount,
      }).slice(0, 1200) }),
    })
  } catch {}

  const bits2 = []
  if (coverRes) bits2.push('封面:' + (coverRes.ok ? 'OK' : 'FAIL:' + (coverRes.err ?? '?')))
  bits2.push('草稿:' + (saveRes?.success ? 'OK' : 'FAIL:' + (saveRes?.error ?? '?')))
  const wxSuffix2 = `（${bits2.join('，')}）`
  return { success: true, message: '已同步并保存为草稿' + wxSuffix + wxSuffix2, tabId: tab.id }
}

// 导出
export { WechatPlatform, fillWechatContent, pickWechatBodyProseMirrorCandidate, syncWechatContent }
