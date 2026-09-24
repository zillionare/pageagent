// zhihu-pin.js — 知乎想法填稿：接收 background 的 xpress 消息，填文字+图片，停在发布前（人来点发布）。
//
// 消息: {type:'xpress', action:'publish_pin'|'check_login_zhihu', payload:{...}}
// publish_pin payload: { text, images: [dataURL|http(s)] }
//   - text: 想法文字（建议 <500 字）
//   - images: 1-18 张
// 回包: {result:{filled:true, imageCount, needHuman:true}} 或 {error:{code,message}}
//
// 注意：知乎想法无草稿箱。按原则只填稿不点发布，人来点。
// 目标页：https://www.zhihu.com/ring-feeds（需用户已登录）

;(() => {
  // 幂等 guard：manifest 自动注入 + background 动态注入可能让本文件执行两次，
  // 重复执行会注册第二个 onMessage 监听，同一条 publish 消息被两个流程并发执行
  // （编辑器里两处同时打字、互相 selectAll 覆盖、最终只剩残余一段）。
  if (window.__xpressZhihuPinLoaded) return
  window.__xpressZhihuPinLoaded = true
  const C = window.xpressCommon
  const A = window.xpressZhihuActions
  // 共享忙锁（挂 window）：即使 guard 被绕过（如 iframe 上下文），并发消息也串行
  const lock = (() => {
    if (!window.__xpressZhihuLock) window.__xpressZhihuLock = { busy: false }
    return window.__xpressZhihuLock
  })()

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'xpress-zhihu') return
    if (lock.busy) {
      sendResponse({ error: { code: -32002, message: '已有知乎任务进行中' } })
      return
    }
    lock.busy = true
    ;(async () => {
      try {
        let result
        switch (msg.action) {
          case 'check_login':
            result = await doCheckLogin()
            break
          case 'publish_pin':
            result = await doPublishPin(msg.payload)
            break
          case 'publish_ring_pin':
            result = await doPublishRingPin(msg.payload)
            break
          case 'publish_article':
            result = await doPublishArticle(msg.payload)
            break
          case 'zhihu_api_probe':
            result = await doZhihuApiProbe(msg.payload)
            break
          case 'zhihu_draft_article':
            result = await doZhihuDraftArticle(msg.payload)
            break
          case 'zhihu_ensure_markdown':
            result = { ok: true, skipped: true, message: '已按 cose 方案去掉开关检查' }
            break
          case 'dump_zhihu':
            result = await doDumpZhihu(msg.payload)
            break
          case 'test_upload_step':
            result = await doTestUploadStep(msg.payload)
            break
          default:
            result = { error: { code: -32601, message: '未知 action: ' + msg.action } }
        }
        // v:2 = 含本地tab+插入图片修复的新版（background 据此判断是否需刷新页面加载新 content）
        if (result && !result.error) result.v = 5
        sendResponse(result)
      } catch (e) {
        sendResponse({ error: { code: e.code ?? -32002, message: e.message ?? String(e), href: location.href, title: document.title } })
      } finally {
        lock.busy = false
      }
    })()
    return true
  })

  async function doCheckLogin() {
    const h = location.href
    // 未登录会被踢到登录页/弹登录框
    if (/login|signin/i.test(h)) return { is_logged_in: false, username: null }
    const hits = []
    for (const s of ['.Avatar', '[class*="avatar"]', '.AppHeader-profile', '[aria-label*="我"]']) {
      const el = document.querySelector(s)
      if (el && C.isVisible(el)) hits.push(s)
    }
    return { is_logged_in: hits.length > 0, username: null, debug: { hits } }
  }

  async function doDumpZhihu(payload) {
    // 诊断：打开想法编辑器 → 快照上传相关 DOM → 存草稿退出（不发布）
    // step=find: 只找文案（payload.keywords 数组），不点不展开，用于定位按钮
    const step = String(payload?.step ?? 'full')
    const out = { href: location.href, title: document.title, step, v: 5 }
    const snap = (el, extra) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return Object.assign({
        tag: el.tagName, cls: (el.className ?? '').toString().slice(0, 120),
        id: el.id || null, accept: el.accept ?? null,
        visible: C.isVisible(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      }, extra ?? {})
    }
    // 1. 确保编辑器展开（find 模式跳过，不碰页面）
    // step=openRing: 点圈子页“发想法”按钮，展开圈子编辑器，回传编辑器结构（只读，不填）
    if (step === 'openRing') {
      const btn = window.xpressZhihuActions?.findRingPostBtn?.()
        || C.findByText('div, button', '发想法')
      out.ringBtn = btn ? { tag: btn.tagName,
        cls: (btn.className ?? '').toString().slice(0, 100), visible: C.isVisible(btn),
        rect: (() => { const r = btn.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })() } : null
      // 合成 click 常被知乎过滤，用 CDP 真实点击（小红书发布按钮同理）
      if (btn && C.isVisible(btn)) {
        try { await C.cdpClick(btn); out.cdpOk = true } catch (e) { out.cdpErr = String(e.message ?? e); btn.click() }
        await C.sleep(3000)
        out.modalAfter = !!document.querySelector('.Modal-inner .WritePinV2-Form')
        // CDP 不行再试聚焦+回车
        if (!out.modalAfter) {
          try { btn.scrollIntoView({ block: 'center' }); await C.sleep(500); btn.focus(); await C.sleep(300) } catch {}
          out.afterFocus = !!document.querySelector('.Modal-inner .WritePinV2-Form')
        }
        // Modal 开着：抓工具栏按钮 svg 类名 + file input（Modal 保持开着，供下一步调试）
        if (out.modalAfter || out.afterFocus) {
          out.toolbarSvgs = Array.from(document.querySelectorAll(
            '.Modal-inner .WritePinToolbar button, .Modal-inner .WritePinV2-Form button'))
            .map((b) => {
              const svg = b.querySelector('svg')
              const r = b.getBoundingClientRect()
              return { svgCls: svg ? (svg.getAttribute('class') || '').slice(0, 60) : null,
                text: (b.textContent ?? '').trim().slice(0, 15),
                visible: C.isVisible(b),
                rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
            })
          out.formInputs = Array.from(document.querySelectorAll(
            '.Modal-inner input[type="file"]')).map((el) => ({
              accept: el.accept, disabled: el.disabled, multiple: el.multiple,
              display: (el.style?.display || ''),
              parentCls: (el.parentElement?.className ?? '').toString().slice(0, 100),
            }))
        }
      }
      out.afterClick = {
        url: location.href,
        formFound: !!document.querySelector('.WritePinV2-Form, .WriteArea, .PinCreator, [class*="PinEditor"], [class*="RingComposer"]'),
        editorSels: ['.WritePinV2-Form', '.WriteArea', '.PinCreator', '.public-DraftEditor-content',
          '[class*="Modal"] .public-DraftEditor-content', '.Modal-inner'].map((s) => ({
            sel: s, count: document.querySelectorAll(s).length,
          })),
        modalText: (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 400) || null,
      }
      // 编辑器内按钮（话题/图片/发布）
      out.editorButtons = Array.from(document.querySelectorAll(
        '.WritePinV2-Form button, .WriteArea button, .Modal-inner button, [role="dialog"] button'))
        .slice(0, 25).map((b) => ({
          text: (b.textContent ?? '').trim().slice(0, 25),
          cls: (b.className ?? '').toString().slice(0, 100),
          visible: C.isVisible(b),
          html: (b.innerHTML || '').slice(0, 150),
        }))
      // 话题/圈子相关文案
      const kws2 = ['话题', '圈子', '同步', '选择', '标签', '发布']
      out.topicTexts = []
      const walker2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
      let n2 = 0
      const seen2 = new Set()
      while (walker2.nextNode()) {
        const el = walker2.currentNode
        if (++n2 > 8000) break
        if (!(el instanceof HTMLElement)) continue
        const t = (el.innerText ?? '').trim()
        if (!t || t.length > 25) continue
        if (!kws2.some((k) => t.includes(k))) continue
        const key = el.tagName + '|' + t
        if (seen2.has(key)) continue
        seen2.add(key)
        const r = el.getBoundingClientRect()
        if (r.width === 0) continue
        out.topicTexts.push({ tag: el.tagName, text: t,
          cls: (el.className ?? '').toString().slice(0, 80), visible: C.isVisible(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
        if (out.topicTexts.length >= 30) break
      }
      return out
    }
    if (step === 'find') {
      const kws = Array.isArray(payload?.keywords) ? payload.keywords : ['发想法']
      out.found = []
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
      let n = 0
      const seen = new Set()
      // eslint-disable-next-line no-constant-condition
      while (walker.nextNode()) {
        const el = walker.currentNode
        if (++n > 8000) break
        if (!(el instanceof HTMLElement)) continue
        const t = (el.innerText ?? '').trim()
        if (!t || t.length > 30) continue
        // 只收叶子（含关键词且子元素不含同样文本，避免容器重复）
        if (!kws.some((k) => t.includes(k))) continue
        const key = el.tagName + '|' + t
        if (seen.has(key)) continue
        seen.add(key)
        const r = el.getBoundingClientRect()
        out.found.push({
          tag: el.tagName, text: t,
          cls: (el.className ?? '').toString().slice(0, 100),
          aria: el.getAttribute?.('aria-label') || null,
          visible: C.isVisible(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        })
        if (out.found.length >= 40) break
      }
      return out
    }
    try {
      const btn = C.findByText('div', '发想法') || document.querySelector('.css-1bz4syk')
      if (btn && C.isVisible(btn)) { btn.click(); await C.sleep(2000) }
    } catch (e) { out.openComposerErr = String(e.message ?? e) }
    const trigger = document.querySelector('.WriteArea .css-1lkz3hi')
      || C.findByText('div, span', '分享此刻的想法')
    if (trigger && C.isVisible(trigger) && !trigger.isContentEditable) {
      try { trigger.click(); await C.sleep(1500) } catch {}
    }
    out.formFound = !!document.querySelector('.WritePinV2-Form, .WriteArea')
    // 2. 工具栏按钮快照
    out.toolbarButtons = Array.from(
      document.querySelectorAll('.WritePinV2-Form button, .WriteArea button'))
      .slice(0, 20).map((b) => snap(b, {
        html: (b.innerHTML || '').slice(0, 200),
        text: (b.textContent ?? '').trim().slice(0, 20),
        hasImageIcon: (b.innerHTML || '').includes('ZDI--Image24'),
      }))
    // 3. 点图片按钮（如 step=upload 则点）
    if (step === 'upload' || step === 'full') {
      const imgBtn = (() => {
        const btns = Array.from(document.querySelectorAll('.WritePinV2-Form button, .WriteArea button'))
        for (const b of btns) {
          if (b.innerHTML.includes('ZDI--Image24') && C.isVisible(b)) return b
        }
        return C.findByText('button', '图片') || document.querySelector('[aria-label*="图片"]')
      })()
      out.imgBtn = snap(imgBtn, { found: !!imgBtn })
      if (imgBtn) { try { imgBtn.click(); await C.sleep(2000) } catch (e) { out.imgBtnClickErr = String(e.message ?? e) } }
      // 4. 点后全页 input[type=file] 快照
      out.fileInputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .map((el) => snap(el, {
          disabled: el.disabled, multiple: el.multiple,
          name: el.name || null,
          outer: (el.outerHTML || '').slice(0, 300),
          parentCls: (el.parentElement?.className ?? '').toString().slice(0, 150),
        }))
      // 5. Modal 快照
      const modal = document.querySelector('.Modal-inner, [role="dialog"]')
      out.modal = snap(modal, {
        found: !!modal,
        text: (modal?.textContent ?? '').trim().slice(0, 500),
        buttons: modal ? Array.from(modal.querySelectorAll('button'))
          .slice(0, 10).map((b) => ({ text: (b.textContent ?? '').trim().slice(0, 30), cls: (b.className ?? '').toString().slice(0, 80), visible: C.isVisible(b) })) : [],
      })
    }
    // 6. 图片预览区现状
    out.previewImgs = Array.from(
      document.querySelectorAll('.WritePinV2-Form img, .WriteArea img'))
      .slice(0, 10).map((el) => ({ src: (el.src || '').slice(0, 120), cls: (el.className ?? '').toString().slice(0, 80) }))
    // 7. 关闭按钮候选（closeAndSaveDraft 诊断）：全量 visible button（不限尺寸）
    const vw2 = window.innerWidth
    out.allButtons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(C.isVisible)
      .slice(0, 60).map((b) => {
        const r = b.getBoundingClientRect()
        return {
          text: (b.textContent ?? '').trim().slice(0, 25),
          aria: b.getAttribute('aria-label') || null,
          cls: (b.className ?? '').toString().slice(0, 100),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          inForm: !!b.closest('.WritePinV2-Form, .WriteArea'),
        }
      })
    out.v = 4
    return out
  }

  // 单步实验2：塞文件 → 点“插入图片” → 等预览，全程观测。
  // payload: { image: dataURL }
  async function doTestUploadStep(payload) {
    const out = { href: location.href, v: 5 }
    const A2 = window.xpressZhihuActions
    // 确保编辑器展开 + 点图片按钮
    try {
      const btn = C.findByText('div', '发想法') || document.querySelector('.css-1bz4syk')
      if (btn && C.isVisible(btn)) { btn.click(); await C.sleep(2000) }
    } catch {}
    const trigger = document.querySelector('.WriteArea .css-1lkz3hi')
      || C.findByText('div, span', '分享此刻的想法')
    if (trigger && C.isVisible(trigger) && !trigger.isContentEditable) {
      try { trigger.click(); await C.sleep(1500) } catch {}
    }
    const imgBtn = (() => {
      const btns = Array.from(document.querySelectorAll('.WritePinV2-Form button, .WriteArea button'))
      for (const b of btns) {
        if (b.innerHTML.includes('ZDI--Image24') && C.isVisible(b)) return b
      }
      return C.findByText('button', '图片') || document.querySelector('[aria-label*="图片"]')
    })()
    out.imgBtnFound = !!imgBtn
    if (imgBtn) { imgBtn.click(); await C.sleep(2000) }
    // 先切到“本地图片上传”tab（默认可能是公共图片库）
    out.modalTextBefore = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 200)
    const localTab = C.findByText('.Modal-inner div, .Modal-inner button, [role="dialog"] div, [role="tab"]', '本地图片上传')
    out.localTabFound = !!localTab
    if (localTab) { localTab.click(); await C.sleep(1500) }
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    out.inputsTotal = inputs.length
    out.inputs = inputs.map((el, i) => ({
      i, accept: el.accept, disabled: el.disabled, multiple: el.multiple,
      filesBefore: el.files?.length ?? -1,
      parentCls: (el.parentElement?.className ?? '').toString().slice(0, 100),
    }))
    // 对每个 input 都试塞文件，看哪个能吃进去
    // payload.only: 只塞第几个 input（对照实验）；payload.noInsert: 不点插入图片
    const dataUrl = payload?.image
    if (!dataUrl) { out.note = 'no image given'; return out }
    const blob = await (await fetch(dataUrl)).blob()
    out.blobSize = blob.size; out.blobType = blob.type
    out.perInput = []
    const only = payload?.only
    for (let i = 0; i < inputs.length; i++) {
      if (only !== undefined && i !== only) {
        out.perInput.push({ i, skipped: true }); continue
      }
      const el = inputs[i]
      const r = { i }
      try {
        const dt = new DataTransfer()
        dt.items.add(new File([blob], `probe_${i}.png`, { type: 'image/png' }))
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set
        if (setter) setter.call(el, dt.files)
        else el.files = dt.files
        r.afterSetter = el.files?.length ?? -1
        el.dispatchEvent(new Event('change', { bubbles: true }))
        el.dispatchEvent(new Event('input', { bubbles: true }))
        await C.sleep(1500)
        r.afterEvents = el.files?.length ?? -1
        r.fileName = el.files?.[0]?.name ?? null
      } catch (e) { r.err = String(e.message ?? e) }
      out.perInput.push(r)
    }
    await C.sleep(2000)
    out.modalText = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 300)
    out.previewCount = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
    out.inputsAfter = Array.from(document.querySelectorAll('input[type="file"]')).map((el) => el.files?.length ?? -1)
    // 点“插入图片”并观测（noInsert 时跳过）
    const insertBtn = C.findByText('.Modal-inner button, [role="dialog"] button', '插入图片')
    out.insertBtnFound = !!insertBtn
    if (insertBtn && !payload?.noInsert) {
      const r = insertBtn.getBoundingClientRect()
      out.insertBtnRect = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      out.insertBtnVisible = C.isVisible(insertBtn)
      out.insertBtnBlocked = C.isBlocked(insertBtn)
      out.insertBtnCls = (insertBtn.className ?? '').toString().slice(0, 120)
      insertBtn.click()
      await C.sleep(3000)
      out.modalAfterClick = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 200) || '(modal closed)'
      out.previewAfterClick = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
      // 再等10秒看预览涨不涨
      await C.sleep(10000)
      out.previewAfterWait = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
      out.modalAfterWait = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 200) || '(modal closed)'
    }
    return out
  }

  async function doPublishPin(payload) {
    const text = String(payload.text ?? '').trim()
    if (!text) throw Object.assign(new Error('想法文字不能为空'), { code: -32600 })
    const images = Array.isArray(payload.images) ? payload.images : []
    if (images.length > 18) throw Object.assign(new Error('想法图片最多 18 张'), { code: -32600 })
    for (const im of images) {
      if (typeof im !== 'string' || (!im.startsWith('data:') && !/^https?:\/\//.test(im))) {
        throw Object.assign(new Error('图片需 data URL 或 http(s) 链接'), { code: -32600 })
      }
    }

    // 1. 当前页找“发想法”按钮点开（圈子页/关注页）；找不到才跳 ring-feeds
    C.progress('openComposer')
    let editor = null;
    try {
      const btn = C.findByText('div', '发想法')
        || document.querySelector('.css-1bz4syk');
      if (btn && C.isVisible(btn)) {
        btn.click();
        await C.sleep(2000);
      }
    } catch {}
    // 2. 填文字（标题可选填入标题框）
    C.progress('fillText')
    editor = await A.getPinEditor()
    if (!editor) throw new Error('未找到想法输入框（页面结构可能已变）')
    try {
      const titleInput = A.getPinTitleInput && A.getPinTitleInput()
      const title = String(payload.title ?? '').trim()
      if (titleInput && title) {
        titleInput.focus()
        titleInput.value = title
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        await C.sleep(400)
      }
    } catch {}
    // Draft.js：CDP 原生输入（execCommand 路径已证伪，见圈子流程注释）
    await C.cdpType(editor, String(text))
    await C.sleep(800)

    // 3. 传图片
    let uploaded = 0
    if (images.length) {
      C.progress('uploadImages', `${images.length} 张`)
      uploaded = await A.uploadPinImages(images)
    }

    // 4. 点 X → 选“保存草稿”进草稿箱（不点发布）
    C.progress('saveDraft')
    const closeRes = await A.closeAndSaveDraft()
    const closed = typeof closeRes === 'object' ? closeRes.saved : !!closeRes
    const closeDbg = typeof closeRes === 'object' ? closeRes.dbg : null
    C.progress('done')
    return { filled: true, imageCount: uploaded, needHuman: false,
             savedDraft: closed, closeDbg,
             message: closed ? '已存入知乎草稿箱' : '已填好，未存草稿（请人工处理）' }
  }

  // 圈子想法：圈子页点“发想法”→ Modal 编辑器 → 填标题/正文/图/话题 → 停住不发布（人来点）。
  // payload: { text, title?, images?, topics?[] }
  async function doPublishRingPin(payload) {
    const text = String(payload.text ?? '').trim()
    if (!text) throw Object.assign(new Error('想法文字不能为空'), { code: -32600 })
    const title = String(payload.title ?? '').trim()
    const images = Array.isArray(payload.images) ? payload.images : []
    if (images.length > 18) throw Object.assign(new Error('想法图片最多 18 张'), { code: -32600 })
    const topics = Array.isArray(payload.topics) ? payload.topics.map(String).filter(Boolean) : []

    // 1. 点圈子页“发想法”（合成点击无效，必须 CDP 真实点击；按钮是右上叶子节点）。
    // Modal 已开着时跳过点击（复用已开编辑器，避免重复点击关闭）。
    C.progress('openRingComposer')
    if (!document.querySelector('.Modal-inner .WritePinV2-Form .TitleArea textarea')) {
      // 独立 tab 刚开圈子页，右上按钮异步加载：等出现（最多 15s）再找
      await C.waitUntil(() => !!(A.findRingPostBtn()
        || C.findByText('div, button', '发想法')), 15000, 500, '发想法按钮')
        .catch(() => { throw new Error('未找到圈子“发想法”按钮（需在圈子页）') })
      const ringBtn = A.findRingPostBtn()
        || C.findByText('div, button', '发想法')
      if (!ringBtn || !C.isVisible(ringBtn)) throw new Error('未找到圈子“发想法”按钮（需在圈子页）')
      try { await C.cdpClick(ringBtn) } catch (e) { ringBtn.click() }
      // 等圈子 Modal 编辑器出现（.Modal-inner .WritePinV2-Form + 标题框为判据）
      await C.waitUntil(() => !!document.querySelector(
        '.Modal-inner .WritePinV2-Form .TitleArea textarea'), 15000, 500, '圈子编辑器')
        .catch(() => { throw new Error('圈子编辑器未弹出') })
      await C.sleep(800)
    }

    // 2. 填标题（圈子 Modal 有独立标题框；之前 bug 是标题填进正文）
    if (title) {
      C.progress('fillTitle')
      const titleInput = document.querySelector('.Modal-inner .TitleArea textarea, .Modal-inner textarea[name="title"]')
      if (!titleInput) throw new Error('未找到圈子标题框')
      await C.type(titleInput, title)
      await C.sleep(400)
    }

    // 3. 填正文（Modal 内 Draft.js）：CDP 原生输入，等价人类键入。
    // execCommand 路径已证伪（丢段/错位/清空 5 种死法），不再使用。
    C.progress('fillText')
    const editor = document.querySelector('.Modal-inner .public-DraftEditor-content[contenteditable="true"]')
    if (!editor) throw new Error('未找到圈子正文框')
    await C.cdpType(editor, String(text))
    await C.sleep(800)
    // 校验落地：首行+末行必须在，否则报错（不再静默重打，避免叠加）
    {
      const cur = (document.querySelector('.Modal-inner .public-DraftEditor-content')?.textContent) ?? ''
      const _lines = String(text).split('\n').filter((s) => s.trim())
      const _first = (_lines[0] ?? '').slice(0, 12)
      const _last = (_lines[_lines.length - 1] ?? '').slice(0, 12)
      if (!cur.includes(_first) || !cur.includes(_last)) {
        throw Object.assign(new Error(
          `正文落地校验失败（缺首/末行，当前 ${cur.length} 字：${cur.slice(0, 80)}）`), { code: -32002 })
      }
    }

    // 4. 传图片（复用首页逻辑；圈子 Modal 内 input 优先）
    let uploaded = 0
    if (images.length) {
      C.progress('uploadImages', `${images.length} 张`)
      uploaded = await A.uploadPinImages(images)
    }

    // 5. 加话题（点 Hash 按钮 → 输入#话题 → 点联想第一项）
    let topicCount = 0, topicDetail = null
    if (topics.length) {
      C.progress('addTopics', topics.join(','))
      const tr = await A.addPinTopics(editor, topics)
      topicCount = tr?.done ?? 0
      topicDetail = tr?.detail ?? null
    }

    // 6. 点 X → 确认框点“保存”（圈子 Modal 关后自动存草稿，显式点保存更稳定；不点发布）。
    // debugHold=true 时跳过关闭，Modal 保持开着供人工检查（调试丢段问题用）。
    C.progress('saveDraft')
    let savedDraft = false
    if (payload.debugHold) {
      C.progress('done')
      const eds = Array.from(document.querySelectorAll(
        '.Modal-inner .public-DraftEditor-content[contenteditable="true"]'))
      const ed = eds.find((e) => C.isVisible(e)) || eds[0] || null
      return { filled: true, title: !!title, imageCount: uploaded, topicCount, topicDetail,
               savedDraft: false, debugHold: true,
               editorCount: eds.length,
               editors: eds.map((e) => {
                 const r = e.getBoundingClientRect()
                 return { visible: C.isVisible(e),
                   editorId: e.querySelector('[data-editor]')?.getAttribute('data-editor') || null,
                   blocks: e.querySelectorAll('[data-block="true"]').length,
                   rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
               }),
               editorParagraphs: ed ? ed.querySelectorAll('[data-block="true"]').length : -1,
               editorText: ed ? (ed.textContent ?? '').slice(0, 300) : null,
               message: '调试保持：Modal 未关闭，请人工检查编辑器内容' }
    }
    try {
      const closeBtn = document.querySelector(
        '.Modal-inner .Modal-closeButton[aria-label="关闭"], button[aria-label="关闭"].Modal-closeButton')
        || C.findByText('.Modal-inner button', '×')
      if (closeBtn && C.isVisible(closeBtn)) {
        try { await C.cdpClick(closeBtn) } catch { closeBtn.click() }
        await C.sleep(1500)
        // 确认框：找“保存/保存草稿”
        const saveBtn = C.findByText('button, [role="button"]', '保存草稿')
          || C.findByText('button, [role="button"]', '保存')
        if (saveBtn && C.isVisible(saveBtn)) {
          try { await C.cdpClick(saveBtn) } catch { saveBtn.click() }
          await C.sleep(2500)
          savedDraft = true
        }
      }
    } catch (e) { savedDraft = false }

    // 存草稿后自动验证：进草稿箱读最新一条，对比标题+正文行数。
    // 编辑器显示全但存盘丢段时这里报错，不再静默成功。
    let verified = null
    if (savedDraft) {
      try {
        verified = await A.verifyRingDraft(title, text)
      } catch (e) {
        verified = { ok: false, err: String(e.message ?? e) }
      }
      if (verified && !verified.ok) savedDraft = false
    }

    C.progress('done')
    return { filled: true, title: !!title, imageCount: uploaded, topicCount, topicDetail, savedDraft, verified,
             message: savedDraft ? '圈子想法已存草稿（已验证）' : '圈子想法已填好（标题/正文/图片/话题），请人工检查后点发布' }
  }

  // 知乎文章填稿：md 经 background 落盘到本机 Downloads → CDP setFileInputFiles 指给
  // 导入控件（等价人类在文件框选文件；系统文件框扩展够不着，只能绕过它）。
  // 关键顺序：先点“导入”→二级菜单“导入文档”（页面进入导入态，否则 setFile 走附件流），
  // 再发下载导入消息。等导入完成 → 停住不关。绝不自动点发布。
  // payload: { title, markdown }
  async function doPublishArticle(payload) {
    const title = String(payload.title ?? '').trim()
    const markdown = String(payload.html ?? payload.markdown ?? '').trim()
    if (!title) throw Object.assign(new Error('文章标题不能为空'), { code: -32600 })
    if (!markdown) throw Object.assign(new Error('文章正文不能为空'), { code: -32600 })
    // 1. 填标题（native setter，React 认）
    C.progress('fillTitle')
    let titleInput = null
    for (let i = 0; i < 15 && !titleInput; i++) {
      const el = document.querySelector('textarea[placeholder*="标题"]')
        || document.querySelector('.Write-title textarea, .Write-title input')
      if (el && C.isVisible(el)) titleInput = el
      if (!titleInput) await C.sleep(800)
    }
    if (!titleInput) throw new Error('未找到标题框')
    titleInput.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (setter) setter.call(titleInput, title)
    else titleInput.value = title
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    await C.sleep(500)
    // 2. 找正文编辑器并聚焦（抄 cose：真实鼠标序列）
    C.progress('focusEditor')
    const editor = document.querySelector('.public-DraftEditor-content')
      || document.querySelector('.public-DraftEditor-content[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
    if (!editor) throw new Error('未找到正文编辑器')
    const er = editor.getBoundingClientRect()
    const cx = er.left + er.width / 2, cy = er.top + er.height / 2
    for (const t of ['mousedown', 'mouseup', 'click']) {
      editor.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }))
    }
    editor.focus()
    // 2.5 清空编辑器（抄 cose：execCommand selectAll + delete）
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    await C.sleep(200)
    // 3. 粘贴 raw Markdown 的 text/plain（抄 cose：这是触发知乎解析弹窗的关键）
    C.progress('pasteMarkdown')
    const dt = new DataTransfer()
    dt.setData('text/plain', markdown)
    editor.focus()
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
    await C.sleep(1500)
    // 4. 弹窗点「确认并解析」→「确认」（等按钮出现，超时则认为无弹窗）
    C.progress('parseMarkdown')
    const waitAndClick = async (matchFn, timeout) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const btns = document.querySelectorAll('button')
        for (const btn of btns) {
          if (matchFn(btn.textContent ?? '')) { btn.click(); return true }
        }
        await C.sleep(200)
      }
      return false
    }
    const parsed = await waitAndClick((t) => t.includes('确认并解析'), 5000)
    let confirmed = false
    if (parsed) {
      await C.sleep(500)
      confirmed = await waitAndClick((t) => t === '确认', 5000)
    }
    await C.sleep(300)
    C.progress('done')
    const wc = (editor.textContent ?? '').length
    return { filled: true, title, via: 'paste-markdown', bodyChars: wc, parsed, confirmed,
      message: '知乎文章已粘贴（含公式/图片解析），请人工选专栏/话题/封面后点发布' }
  }

  // API 探针：在已登录页面上下文里调知乎接口，回传状态+body（逆向字段用）。
  // payload: { method?, url, body? }，默认 GET。
  async function doZhihuApiProbe(payload) {
    const method = (payload.method || 'GET').toUpperCase()
    const url = String(payload.url || '')
    if (!url) throw Object.assign(new Error('缺少 url'), { code: -32600 })
    const opts = { method, credentials: 'include', headers: { 'Content-Type': 'application/json' } }
    if (payload.body !== undefined && method !== 'GET') opts.body = JSON.stringify(payload.body)
    const resp = await fetch(url, opts)
    const text = await resp.text()
    let data = null
    try { data = JSON.parse(text) } catch {}
    return { status: resp.status, url, body: data ?? text.slice(0, 2000) }
  }

    // 知乎文章填稿（抄 cose 方案，比 API 稳——公式/图片由知乎自己解析）：
  // 打开专栏写作页 → 填标题 → 编辑器粘贴 Markdown（ClipboardEvent）→
  // 弹窗点「确认并解析」→「确认」→ 停住不关。由用户选专栏/话题/封面后手动点发布。
  // 绝不自动点发布。 payload: { title, markdown }
  async function doZhihuDraftArticle(payload) {
    const title = String(payload.title ?? '').trim()
    const markdown = String(payload.html ?? payload.markdown ?? '').trim()
    if (!title) throw Object.assign(new Error('文章标题不能为空'), { code: -32600 })
    if (!markdown) throw Object.assign(new Error('文章正文不能为空'), { code: -32600 })
    // 1. 标题（native setter + input/change，React 认）
    C.progress('fillTitle')
    let titleInput = null
    for (let i = 0; i < 20 && !titleInput; i++) {
      const el = document.querySelector('textarea[placeholder*="标题"]')
        || document.querySelector('.Write-title textarea, .Write-title input')
      if (el && C.isVisible(el)) titleInput = el
      if (!titleInput) await C.sleep(800)
    }
    if (!titleInput) throw new Error('未找到标题框')
    titleInput.focus()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    if (setter) setter.call(titleInput, title)
    else titleInput.value = title
    titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    titleInput.dispatchEvent(new Event('change', { bubbles: true }))
    await C.sleep(500)
    // 2. 激活正文编辑器（真实鼠标序列 + focus）
    C.progress('focusEditor')
    const editor = document.querySelector('.public-DraftEditor-content[contenteditable="true"]')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
    if (!editor) throw new Error('未找到正文编辑器')
    const er = editor.getBoundingClientRect()
    const cx = er.left + er.width / 2, cy = er.top + er.height / 2
    for (const t of ['mousedown', 'mouseup', 'click']) {
      editor.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }))
    }
    editor.focus()
    // 2.5 清空编辑器现有内容（抄 cose：execCommand selectAll + delete）
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    await C.sleep(200)
    // 3. 粘贴 raw Markdown（抄 cose：text/plain ClipboardEvent —— 触发知乎“Markdown 检测”弹窗的关键）
    C.progress('pasteMarkdown')
    const dt = new DataTransfer()
    dt.setData('text/plain', markdown)
    editor.dispatchEvent(new ClipboardEvent('paste',
      { bubbles: true, cancelable: true, clipboardData: dt }))
    // 4. 弹窗点「确认并解析」→「确认」（等按钮出现，超时则认为无弹窗）
    C.progress('parseMarkdown')
    const waitAndClick = async (matchFn, timeout) => {
      const t0 = Date.now()
      while (Date.now() - t0 < timeout) {
        const btns = document.querySelectorAll('button')
        for (const btn of btns) {
          if (matchFn(btn.textContent ?? '')) { btn.click(); return true }
        }
        await C.sleep(200)
      }
      return false
    }
    const parsed = await waitAndClick((t) => t.includes('确认并解析'), 5000)
    let confirmed = false
    if (parsed) {
      await C.sleep(500)
      confirmed = await waitAndClick((t) => t === '确认', 5000)
    }
    await C.sleep(300)
    const A2 = window.xpressZhihuActions
    C.progress('done')
    // 封面 + 话题（payload.cover 单 URL，payload.topics 最多 3 个；失败只记 detail 不抛错）
    let coverRes = null, topicRes = null
    if (payload.cover) {
      C.progress('uploadCover')
      try { coverRes = await A2.uploadArticleCover(payload.cover) }
      catch (e) { coverRes = { done: 0, err: String(e.message ?? e) } }
    }
    if (payload.topics?.length) {
      C.progress('addTopics')
      try { topicRes = await A2.addArticleTopics(payload.topics) }
      catch (e) { topicRes = { done: 0, err: String(e.message ?? e) } }
    }
    return { drafted: true, via: 'paste-markdown', parsed, confirmed, cover: coverRes, topics: topicRes,
      message: '知乎文章已粘贴（含公式/图片解析），请人工选专栏后点发布' }
  }
})()
