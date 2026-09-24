// xhs-publish.js — 发布编排：接收 background 的 xpress 消息，执行发布流程，回传结果。
//
// 消息: {type:'xpress', action:'publish_content'|'check_login'|'publish_video', payload:{...}}
// 回包: {error:{code,message}} 或 {result:{...}}

;(() => {
  // 幂等 guard（同 zhihu-pin.js）：防 manifest 自动注入 + 动态注入双注册导致并发双跑
  if (window.__xpressXhsPublishLoaded) return
  window.__xpressXhsPublishLoaded = true
  const C = window.xpressCommon
  const A = window.xpressActions

  const lock = (() => {
    if (!window.__xpressXhsLock) window.__xpressXhsLock = { busy: false }
    return window.__xpressXhsLock
  })()

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'xpress') return
    if (lock.busy) {
      sendResponse({ error: { code: -32002, message: '已有发布任务进行中' } })
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
          case 'dump_page':
            result = await doDumpPage()
            break
          case 'publish_content':
            result = await doPublish(msg.payload)
            break
          case 'publish_video':
            result = { error: { code: -32601, message: 'publish_video 尚未实现' } }
            break
          default:
            result = { error: { code: -32601, message: '未知 action: ' + msg.action } }
        }
        sendResponse(result)
      } catch (e) {
        sendResponse({ error: { code: e.code ?? -32002, message: e.message ?? String(e), href: location.href, title: document.title } })
      } finally {
        lock.busy = false
      }
    })()
    return true // 异步 sendResponse
  })

  // ---- check_login ----
  async function doCheckLogin() {
    const h = location.href
    const debug = { href: h, reason: [], hasCookie: false }
    // 创作中心：能正常打开（未被重定向到登录页）即视为已登录
    if (/creator\.xiaohongshu\.com/.test(h) && !/passport|redirect_url=|\/login/.test(h)) {
      debug.reason.push('creator_page')
      return { is_logged_in: true, username: null, debug }
    }
    // 被重定向到登录页 → 未登录
    if (/passport\.xiaohongshu\.com|\?redirect_url=/i.test(h)) {
      debug.reason.push('redirect_to_login')
      return { is_logged_in: false, username: null, debug }
    }
    // cookie 会话信号（web_session 存在即认为已登录，辅助判定）
    const hasCookie = /(^|;)\s*web_session=[^;]/.test(document.cookie)
    debug.hasCookie = hasCookie
    // DOM 特征并集：头像 / 用户名 / 用户中心 / 消息入口（覆盖多版本页面结构）
    const sels = [
      '[data-user-id]',
      '.user-name',
      '.user-info',
      '.user-center',
      '.side-bar .avatar',
      '.nav-util .avatar',
      '[class*="avatar"]',
      '.reds-icon-messages',
    ]
    const hits = []
    for (const s of sels) {
      const el = document.querySelector(s)
      if (el && C.isVisible(el)) hits.push(s)
    }
    debug.reason.push(hits.length ? 'dom:' + hits.join(',') : 'no_dom_hit')
    debug.reason.push('cookie:' + (hasCookie ? 'yes' : 'no'))
    return { is_logged_in: hasCookie || hits.length > 0, username: null, debug }
  }

  // ---- dump_page：诊断发布页 DOM 结构（用于适配选择器）----
  async function doDumpPage() {
    const out = {
      href: location.href,
      title: document.title,
      tabs: [],
      inputs: [],
      buttons: [],
      textareas: [],
      fileInputs: [],
      uploadAreas: [],
      draftWords: [],
      publishBtn: null,
      divs: [],
    }
    // 收集可见的 tab / 按钮 / input[type=file] / contenteditable / textbox
    for (const el of document.querySelectorAll('div')) {
      if (!C.isVisible(el)) continue
      const t = (el.textContent ?? '').trim()
      if (t && t.length < 20 && /tab|upload|图文|笔记|视频|发布/.test(t) && el.children.length <= 3) {
        out.tabs.push({ cls: el.className, text: t })
      }
    }
    for (const el of document.querySelectorAll('button, [role="button"], .btn, .d-button')) {
      if (!C.isVisible(el)) continue
      const t = (el.textContent ?? '').trim()
      out.buttons.push({ tag: el.tagName, cls: el.className, text: t.slice(0, 30) })
    }
    for (const el of document.querySelectorAll('input')) {
      if (!C.isVisible(el)) continue
      out.inputs.push({ type: el.type, cls: el.className, accept: el.accept, placeholder: el.placeholder })
    }
    for (const el of document.querySelectorAll('[contenteditable="true"], [role="textbox"], textarea')) {
      if (!C.isVisible(el)) continue
      out.textareas.push({ tag: el.tagName, cls: el.className, ph: el.getAttribute('data-placeholder') ?? el.placeholder })
    }
    // file input（无论可见性都列出，上传控件常为隐藏）
    for (const el of document.querySelectorAll('input[type="file"]')) {
      out.fileInputs.push({ cls: el.className, accept: el.accept, multiple: el.multiple, visible: C.isVisible(el) })
    }
    // 疑似上传区域
    for (const el of document.querySelectorAll('[class*="upload"], [class*="uploader"], [class*="Upload"]')) {
      if (!C.isVisible(el)) continue
      const r = el.getBoundingClientRect()
      out.uploadAreas.push({ cls: el.className.slice(0, 80), text: (el.textContent ?? '').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) })
    }
    out.uploadAreas = out.uploadAreas.slice(0, 15)
    out.fileInputs = out.fileInputs.slice(0, 15)
    // 含「暂存/草稿/返回/离开/退出」文案的可见元素
    for (const el of document.querySelectorAll('button, [role="button"], span, a, [class*="btn"]')) {
      if (!C.isVisible(el)) continue
      const t = (el.textContent ?? '').trim()
      if (/暂存|草稿|返回|离开|退出|保存/.test(t) && t.length <= 20) {
        out.draftWords.push({ tag: el.tagName, cls: el.className.slice(0, 60), text: t })
      }
    }
    out.draftWords = out.draftWords.slice(0, 20)
    // xhs-publish-btn 内部结构
    const widgets = document.querySelectorAll('xhs-publish-btn')
    const widget = widgets[0]
    if (widget) {
      out.publishBtn = {
        count: widgets.length,
        attrs: {
          'is-publish': widget.getAttribute('is-publish'),
          'is-save-draft': widget.getAttribute('is-save-draft'),
          'submit-text': widget.getAttribute('submit-text'),
          'save-text': widget.getAttribute('save-text'),
          'submit-disabled': widget.getAttribute('submit-disabled'),
          'save-disabled': widget.getAttribute('save-disabled'),
        },
        innerHTML: (widget.innerHTML || '').slice(0, 300),
        childTags: Array.from(widget.children).map((c) => c.tagName + '.' + (c.className || '')).slice(0, 8),
        hasShadow: !!widget.shadowRoot,
        visible: C.isVisible(widget),
        rect: (() => { const r = widget.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })(),
      }
      // 真实发布按钮容器 rect
      const real = document.querySelector('.publish-page-publish-btn')
      if (real) {
        const rr = real.getBoundingClientRect()
        out.publishBtn.realBtn = {
          rect: { x: Math.round(rr.x), y: Math.round(rr.y), w: Math.round(rr.width), h: Math.round(rr.height) },
          clss: real.className,
          btns: Array.from(real.querySelectorAll('button')).map((b) => ({
            text: (b.textContent ?? '').trim(),
            cls: b.className,
            rect: (() => { const r = b.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } })(),
          })),
        }
      }
    } else {
      out.publishBtn = { count: widgets.length, note: 'not found by tagName' }
    }
    out.tabs = out.tabs.slice(0, 25)
    out.buttons = out.buttons.slice(0, 25)
    out.inputs = out.inputs.slice(0, 25)
    out.textareas = out.textareas.slice(0, 25)
    out.shadowButtons = await C.shadowButtons()
    return out
  }

  // ---- publish_content ----
  async function doPublish(payload) {
    const title = String(payload.title ?? '').trim()
    if (!title || title.length > 20) throw Object.assign(new Error('标题必须 ≤20 字'), { code: -32600 })
    const content = String(payload.content ?? '' )
    if (!content) throw Object.assign(new Error('正文不能为空'), { code: -32600 })
    const images = Array.isArray(payload.images) ? payload.images : []
    if (!images.length || images.length > 18) throw Object.assign(new Error('图片需 1-18 张'), { code: -32600 })
    for (const im of images) {
      if (typeof im !== 'string' || (!im.startsWith('data:') && !/^https?:\/\//.test(im))) throw Object.assign(new Error('图片需 data URL 或 http(s) 链接'), { code: -32600 })
    }
    const tags = Array.isArray(payload.tags) ? payload.tags.map(String) : []

    // 1. 去发布页
    C.progress('gotoPublish')
    await A.gotoPublish()
    C.progress('clickUploadTab')
    await A.clickUploadTab()

    // 2. 上传图片
    C.progress('uploadImages', `${images.length} 张`)
    await A.uploadImages(images)

    // 3. 标题
    C.progress('fillTitle')
    const titleEl = A.getTitleInput()
    if (!titleEl) throw new Error('未找到标题输入框')
    await C.typePlain(titleEl, title)

    // 4. 正文（先数据级清空，防止任务重跑时文字叠加；execCommand 的 selectAll/delete
    //    对 tiptap 有副作用会导致后续插入失效，故不用）
    C.progress('fillContent')
    const contentEl = await A.getContentElement()
    if (!contentEl) throw new Error('未找到正文输入框')
    contentEl.focus()
    contentEl.textContent = ''
    contentEl.dispatchEvent(new Event('input', { bubbles: true }))
    await C.sleep(300)
    await C.typeRich(contentEl, content)

    // 5. 标签
    C.progress('inputTags', tags.join(','))
    await A.inputTags(contentEl, tags)

    // 6. 可选设置
    C.progress('optionalSettings')
    await A.setVisibility(payload.visibility)
    if (payload.is_original) await A.setOriginal()
    if (payload.schedule_at) await A.setSchedule(payload.schedule_at)

    // 7. 草稿模式：自动点「暂存离开」保存到草稿（经 CDP 真实点击，React 必响应）
    if (payload.mode === 'draft') {
      C.progress('clickSaveDraft')
      await A.clickSaveDraft()
      C.progress('waitSaveDraftSuccess')
      const save = await A.waitSaveDraftSuccess()
      C.progress('done', `draft ${save.via}`)
      return {
        status: save.confirmed ? '已暂存到草稿' : '已点击暂存离开（未捕获成功提示，请到草稿箱确认）',
        title,
        images: images.length,
        draft: true,
        confirmed: save.confirmed,
      }
    }
    C.progress('clickPublish')
    await A.clickPublish()
    C.progress('waitPublishSuccess')
    await A.waitPublishSuccess()
    C.progress('done', 'published')

    return { status: '发布完成', title, images: images.length }
  }
})()
void 0