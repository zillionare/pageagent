// xhs-actions.js — 小红书发布原子操作（依赖 window.xpressCommon）
// 移植自 xiaohongshu-mcp 的 xiaohongshu/publish.go 流程与选择器

;(() => {
  const C = window.xpressCommon
  const A = {}

  // ---- 发布页导航 ----
  A.gotoPublish = async () => {
    // target=image 直接进入「上传图文」态，绕过 tab 点击
    const url = 'https://creator.xiaohongshu.com/publish/publish?source=official&target=image'
    if (A.isImageMode()) return
    location.href = url
    await C.waitUntil(() => /\/publish\/publish/.test(location.href), 30000, 500, '导航到发布页')
    await C.sleep(1000)
    // 若被重定向到登录页则明确报错
    if (/passport\.xiaohongshu\.com|\/login|\?redirect_url=/.test(location.href)) {
      throw Object.assign(new Error('小红书未登录，请先登录'), { code: -32001 })
    }
  }

  // 图文态判据：存在接受图片的 file input（视频态是 .mp4/.mov，图文态是 .jpg/.png/.webp）
  A.isImageMode = () => {
    if (document.querySelector('.img-upload-area')) return true
    return Array.from(document.querySelectorAll('input[type="file"]'))
      .some((i) => /png|jpe?g|webp|heic/i.test(i.accept ?? ''))
  }

  // ---- 确认进入「上传图文」态：URL 带 target=image 通常直达；否则坐标点击 tab ----
  A.clickUploadTab = async () => {
    const deadline = Date.now() + 30000
    for (;;) {
      if (A.isImageMode()) break
      // 找「上传图文」tab：真实元素（data-hp-bound）优先，克隆（aria-hidden/透明）过滤
      const tabs = Array.from(document.querySelectorAll('div.creator-tab'))
        .filter((el) => (el.textContent ?? '').trim() === '上传图文')
      const real = tabs.find((el) => el.getAttribute('data-hp-bound') === '1' && C.isVisible(el))
        ?? tabs.find((el) => !el.getAttribute('aria-hidden') && C.isVisible(el))
      if (real) {
        const r = real.getBoundingClientRect()
        await C.cdpClick({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
        await C.sleep(500)
      }
      if (A.isImageMode()) break
      if (Date.now() > deadline) throw new Error('未能进入上传图文模式')
      await C.sleep(500)
    }
    // 等上传控件稳定
    await C.sleep(600)
  }

  // ---- 上传图片（幂等：已有图片只补差，总数不超过 18）----
  A.findImageInput = () => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
    const img = inputs.find((i) => (i.accept ?? '').match(/image\/|\.png|\.jpe?g|\.webp|\.heic/))
    return img ?? inputs[0] ?? null
  }

  A.countUploadedImages = () => {
    return document.querySelectorAll('.img-preview-area .pr, .img-upload-item, .upload-preview img, [class*="preview"] img').length
  }

  A.uploadImages = async (dataUrls) => {
    if (!dataUrls.length || dataUrls.length > 18) throw new Error('图片数量需为 1-18 张')
    // 幂等：页面已有 n 张则只补剩余（任务重跑时不叠加）
    const have = A.countUploadedImages()
    const need = dataUrls.length - have
    if (need <= 0) { await C.sleep(800); return }
    const upload = dataUrls.slice(have)
    if (have + upload.length > 18) throw new Error(`已有 ${have} 张，再传将超过 18 张上限`)
    const input = A.findImageInput()
    if (!input) throw new Error('未找到图片上传输入框')
    await C.setImageFiles(input, upload)
    await C.waitUntil(() => {
      return A.countUploadedImages() >= dataUrls.length
    }, 90000, 400, '图片上传预览出现')
    await C.sleep(600)
  }

  // ---- 标题与正文 ----
  A.getTitleInput = () => {
    const el = document.querySelector('input[placeholder="填写标题会有更多赞哦"]')
    if (el && C.isVisible(el)) return el
    return Array.from(document.querySelectorAll('div.d-input input')).find(C.isVisible)
  }

  A.getContentElement = async () => {
    const sels = [
      'div[role="textbox"][contenteditable="true"]',
      'div.tiptap[contenteditable="true"]',
      'div.ql-editor',
    ]
    for (const sel of sels) {
      const el = Array.from(document.querySelectorAll(sel)).find(C.isVisible)
      if (el) return el
    }
    for (const p of document.querySelectorAll('p')) {
      if ((p.getAttribute('data-placeholder') ?? '').includes('输入正文描述')) {
        let cur = p
        for (let i = 0; i < 5; i++) {
          const parent = cur.parentElement
          if (!parent) break
          if (parent.getAttribute('role') === 'textbox') return parent
          cur = parent
        }
      }
    }
    throw new Error('未找到正文输入框')
  }

  // ---- 标签输入（# → 联想 → 点第一个建议项）----
  A.inputTags = async (contentEl, tags) => {
    // 防御性拆分：frontmatter 里可能把多个标签塞在一个字符串里（中文逗号/空格/# 分隔），
    // 整串输入会被小红书当作非法标签（标签不允许逗号等符号）
    const list = (tags ?? [])
      .flatMap((t) => String(t).split(/[,，＃#\r\n]+/))
      .map((s) => s.trim())
      .filter(Boolean)
    if (!list.length) return
    await C.sleep(1000)
    const range = document.createRange()
    range.selectNodeContents(contentEl)
    range.collapse(false)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    contentEl.focus()
    // 正文与标签之间留一个空行（两个段落分隔；execCommand 失败则退回插入换行文本）
    const p1 = document.execCommand('insertParagraph', false, null)
    const p2 = document.execCommand('insertParagraph', false, null)
    if (!p1 || !p2) await C.typeRich(contentEl, '\n\n')
    await C.sleep(300)
    for (const raw of list) {
      const tag = raw.replace(/^#+/, '')
      await C.typeRich(contentEl, '#' + tag)
      await C.sleep(C.randDelay(700))
      const first = document.querySelector('#creator-editor-topic-container .item')
      if (first && C.isVisible(first) && !C.isBlocked(first)) {
        await C.cdpClick(first)
      } else {
        await C.typeRich(contentEl, ' ')
      }
      await C.sleep(500)
    }
  }

  // ---- 可见范围 ----
  A.setVisibility = async (visibility) => {
    if (!visibility || visibility === '公开可见') return
    const supported = new Set(['仅自己可见', '仅互关好友可见'])
    if (!supported.has(visibility)) throw new Error('不支持的可见范围: ' + visibility)
    const dropdown = Array.from(document.querySelectorAll('div.permission-card-wrapper div.d-select-content')).find(C.isVisible)
    if (!dropdown) throw new Error('未找到可见范围下拉框')
    await C.cdpClick(dropdown)
    await C.sleep(500)
    const opt = Array.from(document.querySelectorAll('div.d-options-wrapper div.d-grid-item div.custom-option'))
      .find((el) => (el.textContent ?? '').includes(visibility) && C.isVisible(el))
    if (!opt) throw new Error('未找到可见范围选项: ' + visibility)
    await C.cdpClick(opt)
    await C.sleep(300)
  }

  // ---- 定时发布 ----
  A.setSchedule = async (iso) => {
    const t = new Date(iso)
    if (Number.isNaN(t.getTime())) throw new Error('schedule_at 格式错误，需 ISO8601')
    const min = Date.now() + 3600000
    const max = Date.now() + 14 * 86400000
    if (t.getTime() < min || t.getTime() > max) throw new Error('定时发布时间需在 1 小时后 ~ 14 天内')
    const sw = await C.waitFor('.post-time-wrapper .d-switch', 10000)
    await C.cdpClick(sw)
    await C.sleep(800)
    const input = await C.waitFor('.date-picker-container input', 15000)
    const pad = (n) => String(n).padStart(2, '0')
    const str = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate()) +
      ' ' + pad(t.getHours()) + ':' + pad(t.getMinutes())
    await C.typePlain(input, str)
    await C.sleep(300)
  }

  // ---- 原创声明 ----
  A.setOriginal = async () => {
    const card = Array.from(document.querySelectorAll('div.custom-switch-card'))
      .find((el) => (el.textContent ?? '').includes('原创声明') && C.isVisible(el))
    if (!card) throw new Error('未找到原创声明选项')
    const sw = card.querySelector('div.d-switch')
    const cbInput = card.querySelector('input[type="checkbox"]')
    if (cbInput?.checked) return
    await C.cdpClick(sw)
    await C.sleep(800)
    const footer = Array.from(document.querySelectorAll('div.footer'))
      .find((el) => (el.textContent ?? '').includes('声明原创') && C.isVisible(el))
    if (footer) {
      const cb = footer.querySelector('div.d-checkbox')
      const cbIn = footer.querySelector('input[type="checkbox"]')
      if (cb && !cbIn?.checked) await C.cdpClick(cb)
      await C.sleep(400)
      const btn = footer.querySelector('button.custom-button')
      if (btn && !btn.disabled && !/\bdisabled\b/.test(btn.className ?? '')) {
        await C.cdpClick(btn)
      } else {
        if (cb && !cbIn?.checked) await C.cdpClick(cb)
        await C.sleep(300)
        if (btn && !btn.disabled) await C.cdpClick(btn)
      }
    }
  }

  // ---- 发布按钮 ----
  A.findPublishButton = () => {
    for (const w of Array.from(document.querySelectorAll('xhs-publish-btn'))) {
      if (!C.isVisible(w)) continue
      if (w.getAttribute('is-publish') === 'false') continue
      if (w.getAttribute('submit-disabled') === 'true') {
        return { el: w, widget: true, disabled: true, reason: '新版发布按钮不可点击' }
      }
      return { el: w, widget: true, disabled: false }
    }
    for (const b of Array.from(document.querySelectorAll('.publish-page-publish-btn button.bg-red'))) {
      if (!C.isVisible(b)) continue
      const cls = b.className ?? ''
      if (b.disabled || b.getAttribute('aria-disabled') === 'true' || /\bdisabled\b/.test(cls)) {
        return { el: b, widget: false, disabled: true, reason: '旧版发布按钮不可点击' }
      }
      return { el: b, widget: false, disabled: false }
    }
    return null
  }

  A.clickPublish = async () => {
    await C.waitUntil(() => {
      const btn = A.findPublishButton()
      return btn && !btn.disabled
    }, 15000, 800, '发布按钮')
    const btn = A.findPublishButton()
    if (!btn) throw new Error('未找到发布按钮')
    // 优先：CDP 穿透 shadow 拿「发布」按钮真实坐标
    const shadowBtns = await C.shadowButtons()
    const pub = shadowBtns.find((b) => /bg-red|发布/.test(b.html) && !/暂存/.test(b.html) && !/disabled/.test(b.html))
    if (pub) {
      await C.cdpClick({ x: pub.x, y: pub.y })
      await C.sleep(500)
      return
    }
    btn.el.scrollIntoView({ block: 'center' })
    await C.sleep(300)
    const r = btn.el.getBoundingClientRect()
    const x = r.left + r.width * (btn.widget ? 0.65 : 0.5)
    await C.cdpClick({ x, y: r.top + r.height / 2 })
    await C.sleep(500)
  }

  // ---- 暂存离开（存草稿）----
  // 按钮渲染在 xhs-publish-btn 的 closed shadow root 内，JS 无法查询（DevTools 可见）。
  // 唯一可靠方式：坐标点击。布局：左侧「暂存离开」右侧「发布」（参考项目用 0.65 点发布）。
  A.findSaveDraftButton = () => {
    for (const w of Array.from(document.querySelectorAll('xhs-publish-btn'))) {
      if (!C.isVisible(w)) continue
      if (w.getAttribute('is-save-draft') !== 'true') continue
      if (w.getAttribute('save-disabled') === 'true') {
        return { el: w, disabled: true, reason: '暂存离开不可点' }
      }
      return { el: w, disabled: false }
    }
    return null
  }

  A.clickSaveDraft = async () => {
    await C.waitUntil(() => {
      const btn = A.findSaveDraftButton()
      return btn && !btn.disabled
    }, 15000, 800, '暂存离开按钮')
    const btn = A.findSaveDraftButton()
    if (!btn) throw new Error('未找到暂存离开按钮')
    // 优先：CDP 穿透 closed shadow 拿「暂存」按钮真实坐标，直接点中心
    const shadowBtns = await C.shadowButtons()
    const save = shadowBtns.find((b) => /暂存/.test(b.html) && !/disabled/.test(b.html))
    if (save) {
      await C.cdpClick({ x: save.x, y: save.y })
    } else {
      // 回退：比例猜（按钮组靠右时 0.25 会落空，仅兜底）
      btn.el.scrollIntoView({ block: 'center' })
      await C.sleep(300)
      const r = btn.el.getBoundingClientRect()
      await C.cdpClick({ x: r.left + r.width * 0.25, y: r.top + r.height / 2 })
    }
    // 可能弹二次确认框
    await C.sleep(1000)
    const confirm = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find((el) => {
        if (!C.isVisible(el)) return false
        const t = (el.textContent ?? '').trim()
        return t === '暂存后离开' || t === '暂存并离开' || (t.includes('暂存') && t.includes('离开'))
      })
    if (confirm) {
      const cr = confirm.getBoundingClientRect()
      await C.cdpClick({ x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 })
    }
    await C.sleep(1000)
  }

  // ---- 等待暂存成功 ----
  // 新版发布页暂存后不跳转（只弹提示），因此：URL 离开 / 出现「暂存/草稿」成功提示 / 超时软成功
  // （点击本身经 CDP 真实事件，已多轮验证会实际存入草稿箱）
  A.waitSaveDraftSuccess = async (timeout = 12000) => {
    const t0 = Date.now()
    for (;;) {
      if (!/\/publish\/publish/.test(location.href)) return { confirmed: true, via: 'redirect' }
      const toast = Array.from(document.querySelectorAll('[class*="toast"], [class*="message"], [class*="tip"]'))
        .find((el) => {
          if (!C.isVisible(el)) return false
          const t = (el.textContent ?? '').trim()
          return t.length < 30 && /暂存|草稿/.test(t)
        })
      if (toast) return { confirmed: true, via: 'toast' }
      if (Date.now() - t0 > timeout) return { confirmed: false, via: 'timeout' }
      await C.sleep(500)
    }
  }

  // ---- 等待发布成功（URL 跳转离开发布页）----
  A.waitPublishSuccess = async (timeout) => {
    await C.waitUntil(() => !/\/publish\/publish/.test(location.href), timeout ?? 15000, 500)
  }

  window.xpressActions = A
})()
void 0