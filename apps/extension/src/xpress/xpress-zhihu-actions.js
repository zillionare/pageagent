// xhsZhihuActions — 知乎想法页 DOM 操作（选择器集中一处，页面改版只改这里）
;(() => {
  const C = window.xpressCommon
  const A = {}

  // 想法输入框（首页 WriteArea，WritePinV2-Form 展开态）
  // 标题框：.TitleArea textarea / textarea[name="title"]
  // 正文：.public-DraftEditor-content[contenteditable="true"]
  A.getPinEditor = async () => {
    const sels = [
      '.WritePinV2-Form .public-DraftEditor-content[contenteditable="true"]',
      '.WriteArea .public-DraftEditor-content[contenteditable="true"]',
      '.WriteArea [contenteditable="true"]',
      '.PinCreator-content .DraftEditor-root [contenteditable="true"]',
      '.PinCreator [contenteditable="true"]',
    ];
    for (let i = 0; i < 10; i++) {
      // 先点占位展开（折叠态的“分享此刻的想法...”）
      const trigger = document.querySelector('.WriteArea .css-1lkz3hi')
        || C.findByText('div, span', '分享此刻的想法');
      if (trigger && C.isVisible(trigger) && !trigger.isContentEditable) {
        try {
          trigger.click();
          await C.sleep(1200);
        } catch {}
      }
      for (const s of sels) {
        const el = document.querySelector(s)
        if (el && C.isVisible(el)) return el
      }
      await C.sleep(300)
    }
    return null
  }

  // 想法标题框（可空）
  A.getPinTitleInput = () => {
    const sels = [
      '.WritePinV2-Form .TitleArea textarea',
      '.WriteArea textarea[name="title"]',
      'textarea[placeholder="标题"]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s)
      if (el && C.isVisible(el)) return el
    }
    return null
  }

  // 想法“发想法”按钮（WriteArea 右下 .css-usknaz；圈子页 .css-1bz4syk 容器）
  A.getPinSubmitBtn = () => {
    const btns = [
      '.WriteArea .css-usknaz',
      '.css-1bz4syk',
    ];
    for (const s of btns) {
      const el = document.querySelector(s)
      if (el && C.isVisible(el)) return el
    }
    return C.findByText('button, div', '发想法')
  }

  // dataUrl 数组转 File 数组
  A.dataUrlsToFiles = async (images) => {
    const out = []
    for (let i = 0; i < images.length; i++) {
      const blob = await (await fetch(images[i])).blob()
      const ext = (images[i].match(/data:([^;,]+)/)?.[1] ?? 'image/png').split('/')[1] ?? 'png'
      out.push(new File([blob], `pin_${Date.now()}_${i}.${ext}`, { type: blob.type }))
    }
    return out
  }

  // 想法图片上传：点工具栏图片按钮 → 切“本地图片上传”tab → 塞文件 → 点“插入图片”确认。
  // （实测：默认 tab 是公共图片库，塞文件无效；必须先切本地 tab，塞完点“插入图片”图片才进编辑器。）
  A.uploadPinImages = async (images) => {
    const dbg = { v: 3 }
    // 点图片按钮（工具栏 ZDI--Image24 所在 button）。
    // 注意：圈子 Modal 的工具栏在 .WritePinToolbar 内，与 .WritePinV2-Form 是兄弟关系，
    // 只查 .WritePinV2-Form button 会漏掉（之前 imgBtnFound:false 的根因）。
    const imgBtn = (() => {
      const btns = Array.from(document.querySelectorAll(
        '.Modal-inner .WritePinToolbar button, .Modal-inner .WritePinV2-Form button, .WritePinV2-Form button, .WriteArea button'))
      // 找含 Image 图标的按钮
      for (const b of btns) {
        if (b.innerHTML.includes('ZDI--Image24') && C.isVisible(b)) return b
      }
      return C.findByText('button', '图片')
        || document.querySelector('[aria-label*="图片"]')
    })()
    dbg.imgBtnFound = !!imgBtn
    dbg.imgBtnCount = document.querySelectorAll(
      '.Modal-inner .WritePinToolbar button, .Modal-inner .WritePinV2-Form button').length
    if (imgBtn) {
      try {
        // 合成点击常被过滤，优先 CDP 真实点击
        await C.cdpClick(imgBtn)
      } catch {
        try { imgBtn.click() } catch {}
      }
      await C.sleep(2000)
    }
    // 切到“本地图片上传”tab（默认是公共图片库，其 input 塞文件无效）
    const localTab = C.findByText('.Modal-inner div, .Modal-inner button, [role="dialog"] div, [role="tab"]', '本地图片上传')
    dbg.localTabFound = !!localTab
    dbg.modalTextBefore = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 120)
    if (localTab) {
      try { localTab.click() } catch {}
      await C.sleep(1500)
    }
    // 本地上传项的 input：上传 Modal 内 .css-1lx7oj > input[type=file]（圈子/首页通用）；
    //  fallback：parent 在 Modal 内的，或最后一个 accept 含 image 的。
    let input = null
    for (let i = 0; i < 10; i++) {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
        .filter((el) => !el.disabled)
      input = inputs.find((el) => el.closest('.css-1lx7oj'))
        || inputs.find((el) => el.closest('.Modal-inner, [role="dialog"]'))
        || inputs.reverse().find((el) => (el.accept || '').includes('image'))
        || inputs[0]
      if (input) break
      await C.sleep(800)
    }
    if (!input) throw new Error('未找到图片上传控件 ' + JSON.stringify(dbg))
    dbg.inputAccept = input.accept
    dbg.inputParent = (input.parentElement?.className ?? '').toString().slice(0, 80)
    const before = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
    dbg.previewBefore = before
    // 用原生 setter 塞文件（React 受控组件直接赋值 files 不触发 onChange，必须走 setter + 事件）
    let files = null, setter = null, protoSetter = null
    try {
      files = await A.dataUrlsToFiles(images)
      setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set
      protoSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'files')?.set
      const dt = new DataTransfer()
      files.forEach((f) => dt.items.add(f))
      if (protoSetter && setter && protoSetter !== setter) {
        // React 劫持了实例属性，用原型链原生 setter 绕过
        protoSetter.call(input, dt.files)
      } else {
        input.files = dt.files
      }
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // 等 React 吃进文件：Modal 文字出现“已上传 N 张”或“插入图片”按钮（固定 sleep 会撞竞态）
      await C.waitUntil(() => {
        const t = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '')
        return /已上传|插入图片/.test(t)
      }, 15000, 400, 'Modal识别文件').catch(() => {})
      await C.sleep(800)
    } catch (e) {
      throw new Error('塞文件失败: ' + (e.message ?? e))
    }
    // 点确认：首页是“插入图片”，圈子上传 Modal 是“确认/完成”（塞完出现）；都没有则直接等预览。
    // 无插入按钮时（圈子）：塞完直接等预览，涨了即确认。
    let confirmed = false
    const findConfirmBtn = () =>
      C.findByText('.Modal-inner button, [role="dialog"] button', '插入图片')
      || C.findByText('.Modal-inner button, [role="dialog"] button', '确认')
      || C.findByText('.Modal-inner button, [role="dialog"] button', '完成')
      || C.findByText('.Modal-inner button, [role="dialog"] button', '确定')
    const hasInsertBtn = () => !!findConfirmBtn()
    for (let round = 0; round < 2 && !confirmed; round++) {
      if (round > 0) {
        // 重试：重新塞文件（input 可能已被 Modal 消费，找不到就用原 input）
        try {
          const dt2 = new DataTransfer()
          files.forEach((f) => dt2.items.add(f))
          if (protoSetter && setter && protoSetter !== setter) protoSetter.call(input, dt2.files)
          else input.files = dt2.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
          await C.waitUntil(() => {
            const t = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '')
            return /已上传|插入图片/.test(t)
          }, 15000, 400, 'Modal识别文件').catch(() => {})
          await C.sleep(800)
        } catch {}
      }
      for (let i = 0; i < 10; i++) {
        const insertBtn = findConfirmBtn()
        if (insertBtn && C.isVisible(insertBtn)) {
          dbg.insertBtnFound = true
          insertBtn.click()
          await C.sleep(2500)
          break
        }
        // 圈子 Modal 无插入按钮：不等了，直接去查 preview
        if (!hasInsertBtn() && i >= 2) break
        await C.sleep(800)
      }
      dbg.modalAfterInsert = (document.querySelector('.Modal-inner, [role="dialog"]')?.textContent ?? '').trim().slice(0, 150) || '(closed)'
      // 短等 8s 看 preview 涨不涨，涨了即确认
      const tC = Date.now()
      for (;;) {
        await C.sleep(1000)
        if (document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length > before) {
          confirmed = true
          break
        }
        if (Date.now() - tC > 8000) break
      }
    }
    if (!confirmed) {
      dbg.previewAfter = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
      throw new Error(`图片未上传成功 ${JSON.stringify(dbg)}`)
    }
    // 等图片预览出现（确认上传生效），超时报错
    const t0 = Date.now()
    for (;;) {
      await C.sleep(1000)
      const now = document.querySelectorAll('.WritePinV2-Form img, .WriteArea img').length
      if (now > before) break
      if (Date.now() - t0 > 60000) {
        dbg.previewAfter = now
        throw new Error(`图片未上传成功 ${JSON.stringify(dbg)}`)
      }
    }
    await C.sleep(1500)
    return images.length
  }

  // 文章封面上传：点“添加封面”label → 找 input[type=file] → 塞 url 图 → 等封面图出现。
  // cover: 单张图片 URL（http(s) 或 data:）。返回 {done, err?}。
  A.uploadArticleCover = async (coverUrl) => {
    if (!coverUrl) return { done: 0, skipped: 'no-cover' }
    const label = C.findByText('label', '添加封面')
      || C.findByText('label', '添加文章封面')
    if (label && C.isVisible(label)) {
      try { label.scrollIntoView({ block: 'center' }) } catch {}
      await C.sleep(300)
    }
    let input = label?.querySelector?.('input[type="file"]')
      || document.querySelector('label.UploadPicture-wrapper input[type="file"]')
    if (!input) {
      for (let i = 0; i < 8 && !input; i++) {
        const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter((el) => !el.disabled)
        input = inputs.find((el) => /image|jpg|jpeg|png/i.test(el.accept || '')) || inputs[inputs.length - 1]
        if (!input) await C.sleep(800)
      }
    }
    if (!input) return { done: 0, err: 'no-cover-input' }
    const before = document.querySelectorAll('.UploadPicture-wrapper img, [class*="cover" i] img').length
    try {
      const blob = await (await fetch(coverUrl)).blob()
      const ext = (blob.type.split('/')[1] ?? 'jpg').split('+')[0]
      const file = new File([blob], `cover_${Date.now()}.${ext}`, { type: blob.type || 'image/jpeg' })
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set
      const dt = new DataTransfer()
      dt.items.add(file)
      if (setter) setter.call(input, dt.files)
      else input.files = dt.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      input.dispatchEvent(new Event('input', { bubbles: true }))
    } catch (e) {
      return { done: 0, err: 'fetch-or-fill: ' + (e.message ?? e) }
    }
    // 等封面缩略图出现（最多 30s）
    const ok = await C.waitUntil(() =>
      document.querySelectorAll('.UploadPicture-wrapper img, [class*="cover" i] img').length > before
      || /更换封面|重新上传|删除/.test(document.body.textContent ?? ''), 30000, 800, '封面上图').then(() => true).catch(() => false)
    return ok ? { done: 1 } : { done: 0, err: 'cover-upload-timeout' }
  }

  // 文章话题添加：点“添加话题”→ 搜索框逐个输话题名 → 联想选第一项 → 回车确认。
  // topics: 最多 3 个。返回 {done, detail}。
  A.addArticleTopics = async (topics) => {
    const list = (topics ?? []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean).slice(0, 3)
    if (!list.length) return { done: 0, skipped: 'no-topics' }
    let done = 0
    const detail = []
    for (const tag of list) {
      const d = { tag }
      try {
        // “添加话题”按钮可能在可视区外（findByText 带 blocked 检查会漏），直接 query 后滚到可见
        let addBtn = Array.from(document.querySelectorAll('button'))
          .find((b) => (b.textContent ?? '').trim().includes('添加话题') && C.isVisible(b))
        if (!addBtn) { d.err = 'no-add-btn'; detail.push(d); continue }
        try { addBtn.scrollIntoView({ block: 'center' }) } catch {}
        await C.sleep(500)
        try { await C.cdpClick(addBtn) } catch { addBtn.click() }
        await C.sleep(1200)
        // 话题搜索框（Modal 或行内 input）
        let box = null
        for (let i = 0; i < 8 && !box; i++) {
          const cands = Array.from(document.querySelectorAll('.Modal-inner input[placeholder], input[placeholder*="话题"], input[placeholder*="搜索"]'))
            .filter((el) => C.isVisible(el))
          box = cands[cands.length - 1] || null
          if (!box) await C.sleep(800)
        }
        if (!box) { d.err = 'no-search-box'; detail.push(d); continue }
        d.boxFound = true
        // 真按键管线：先清空框 → CDP 点进框聚焦 → xpress-cdp-text 发字（React 搜索请求要真键盘事件）
        try {
          box.focus()
          box.select?.()
          document.execCommand('selectAll', false, null)
          document.execCommand('delete', false, null)
          box.value = ''
          box.dispatchEvent(new Event('input', { bubbles: true }))
          await C.cdpClick(box)
          await C.sleep(400)
          const resp = await chrome.runtime.sendMessage({ type: 'xpress-cdp-text', text: tag })
          if (resp?.error) throw new Error(resp.error)
          d.typedVia = 'cdp-text'
        } catch (e) {
          d.typedVia = 'fallback:' + String(e.message ?? e).slice(0, 60)
          const proto = box.tagName === 'TEXTAREA'
            ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
          box.focus()
          if (setter) setter.call(box, tag)
          else box.value = tag
          box.dispatchEvent(new Event('input', { bubbles: true }))
        }
        d.boxValue = (box.value ?? '').slice(0, 20)
        await C.sleep(2500)
        // 联想第一项（话题联想是 BUTTON.css-gfrh4c，不是 li；全文档找，排除添加话题按钮）
        const chipsBefore = document.querySelectorAll('.css-nut0iz, [class*="topic" i] [class*="tag" i]').length
        const items = Array.from(document.querySelectorAll(
          'li, button, [role="option"], [class*="suggest" i] li, [class*="Suggest"] li, [class*="dropdown" i] li'))
          .filter((el) => C.isVisible(el) && (el.textContent ?? '').trim().length > 0
            && !/添加话题|文章话题/.test(el.textContent ?? '')
            && !/ToolbarButton|toolbar-section/.test(el.className ?? '')
            && !el.closest?.('.toolbar-section, .Toolbar, [class*="Toolbar"]')
            && el !== addBtn)
        d.suggestCount = items.length
        d.suggestSample = items.slice(0, 3).map((el) => (el.textContent ?? '').trim().slice(0, 30))
        const first = items.find((el) => (el.textContent ?? '').includes(tag)) || items[0]
        if (first) {
          d.firstText = (first.textContent ?? '').trim().slice(0, 40)
          try { await C.cdpClick(first) } catch { first.click() }
          await C.sleep(1500)
          // 按 chip 数验证真加上了
          const chipsAfter = document.querySelectorAll('.css-nut0iz, [class*="topic" i] [class*="tag" i]').length
          d.chipsAfter = chipsAfter
          if (chipsAfter > chipsBefore) done++
          else d.err = 'chip-not-grown'
        } else { d.err = 'no-suggest' }
        // 关掉话题搜索框（Esc 或点外部），准备下一个
        try { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch {}
        await C.sleep(600)
      } catch (e) { d.err = String(e.message ?? e) }
      detail.push(d)
    }
    return { done, detail }
  }

  window.xpressZhihuActions = A

  // 存草稿后验证：跳到草稿箱（想法 tab），读最新一条的标题+正文行数，再跳回圈子页。
  // 返回 {ok, draftTitle, draftLines, expectLines, err?}。只读不写。
  A.verifyRingDraft = async (expectTitle, expectText) => {
    const ringUrl = 'https://www.zhihu.com/ring/host/1940469824917603882?tab=new'
    const draftUrl = 'https://www.zhihu.com/creator/manage/creation/draft?type=pin'
    const expectLines = String(expectText ?? '').split('\n').filter((s) => s.trim()).length
    const goto = async (url) => {
      location.href = url
      await C.waitUntil(() => {
        if (!/\/draft/.test(url)) return /\/ring\/host/.test(location.href)
        return /creation\/draft/.test(location.href)
      }, 20000, 500, '导航').catch(() => {})
      await C.sleep(2500)
    }
    try {
      await goto(draftUrl)
      // 草稿箱第一条：标题 + 正文摘要
      const first = document.querySelector('[class*="Draft"], [class*="draft"]')
      const titleEl = document.querySelector('.Modal-inner, body')
      const bodyText = document.body?.textContent ?? ''
      // 找期望标题
      const hasTitle = expectTitle ? bodyText.includes(expectTitle.slice(0, 12)) : true
      // 数期望首尾行是否在
      const lines = String(expectText ?? '').split('\n').filter((s) => s.trim())
      const firstLine = (lines[0] ?? '').slice(0, 15)
      const lastLine = (lines[lines.length - 1] ?? '').slice(0, 15)
      const hasFirst = firstLine ? bodyText.includes(firstLine) : true
      const hasLast = lastLine ? bodyText.includes(lastLine) : true
      const ok = hasTitle && hasFirst && hasLast
      const out = { ok, hasTitle, hasFirst, hasLast, expectLines,
        draftTitle: expectTitle,
        snippet: bodyText.slice(0, 200) }
      await goto(ringUrl)
      return out
    } catch (e) {
      try { await goto(ringUrl) } catch {}
      return { ok: false, err: String(e.message ?? e), expectLines }
    }
  }

  // 圈子「发想法」按钮：找叶子文本节点（容器 DIV 的 textContent 也含关键词，必须排除；
  // CSS 哈希类名每次发版都变，不可靠）。限定右上区域（x>50%宽，y<250，高<150），排除圈子简介区。
  // 返回最小可见叶子元素。
  A.findRingPostBtn = () => {
    const vw = window.innerWidth
    const cands = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    let n = 0
    while (walker.nextNode()) {
      const el = walker.currentNode
      if (++n > 8000) break
      if (!(el instanceof HTMLElement)) continue
      const own = Array.from(el.childNodes).filter((x) => x.nodeType === 3)
        .map((x) => x.textContent ?? '').join('').trim()
      if (!own.includes('发想法') || own.length > 10) continue
      const r = el.getBoundingClientRect()
      if (r.x < vw * 0.5 || r.y > 250 || r.height > 150 || r.width === 0) continue
      cands.push({ el, area: r.width * r.height })
    }
    cands.sort((a, b) => a.area - b.area)
    return (cands[0]?.el ?? null)
      || C.findByText('div, button', '发想法')
      || document.querySelector('.css-ui3esq, .css-1bz4syk, .css-1rdop6i')
  }

  // 圈子想法加话题：点工具栏 # 按钮（自动插入 # 并弹联想）→ 输入话题名 → 点联想第一项。
  // 实测：自己 execCommand 输 # 不会触发联想（Draft.js 事件序列不完整），必须点官方按钮。
  // 返回 {done, detail[]}。
  // 注意：editor 引用可能已 detached（Draft.js 重渲染会替换 DOM），先重查。
  A.addPinTopics = async (editor, topics) => {
    let done = 0
    const detail = []
    if (editor && !editor.isConnected) {
      detail.push('editor-detached,requery')
      editor = document.querySelector('.Modal-inner .public-DraftEditor-content[contenteditable="true"]')
        || document.querySelector('.WritePinV2-Form .public-DraftEditor-content[contenteditable="true"]')
    }
    if (!editor) return { done: 0, detail: detail.concat(['no-editor']), skipped: 'no-editor' }
    detail.push('editor-connected:' + !!editor.isConnected)
    for (const raw of topics) {
      const tag = String(raw).replace(/^#+/, '').trim()
      if (!tag) continue
      const d = { tag }
      try {
        // 1. 点工具栏 # 按钮（Hash24）
        const hashBtn = (() => {
          const btns = Array.from(document.querySelectorAll(
            '.Modal-inner .WritePinToolbar button, .Modal-inner .WritePinV2-Form button'))
          for (const b of btns) {
            if ((b.innerHTML || '').includes('ZDI--Hash24') && C.isVisible(b)) return b
          }
          return null
        })()
        d.hashBtnFound = !!hashBtn
        if (!hashBtn) { d.err = 'no-hash-btn'; detail.push(d); continue }
        try { await C.cdpClick(hashBtn) } catch { hashBtn.click() }
        await C.sleep(1200)
        // 2. 输入话题名（# 已由按钮插入，只输名字）
        let okAll = true
        for (const ch of tag) {
          let ok = false
          try { ok = document.execCommand('insertText', false, ch) } catch {}
          if (!ok) okAll = false
          await C.sleep(80)
        }
        d.insertOk = okAll
        await C.sleep(1500)
        // 3. 联想 dropdown：找含话题名的可见项
        const items = Array.from(document.querySelectorAll(
          '.Modal-inner [class*="suggest"], .Modal-inner [class*="Suggest"], .Modal-inner [class*="mention"], .Modal-inner [class*="Mention"], .Modal-inner [class*="dropdown"], .Modal-inner [class*="Dropdown"], .Modal-inner [class*="menu"], .Modal-inner [class*="Menu"], .Modal-inner [class*="list"], .Modal-inner [class*="List"], [role="listbox"] [role="option"], .Modal-inner li'))
          .filter((el) => C.isVisible(el) && (el.textContent ?? '').includes(tag))
        d.suggestCount = items.length
        const first = items[0]
          || Array.from(document.querySelectorAll(
            '.Modal-inner [class*="dropdown"] li, .Modal-inner [class*="Dropdown"] li, .Modal-inner [class*="menu"] li, [role="option"]'))
            .find((el) => C.isVisible(el) && (el.textContent ?? '').trim().length > 0)
        d.firstText = first ? (first.textContent ?? '').trim().slice(0, 40) : null
        if (first) {
          const r = first.getBoundingClientRect()
          await C.cdpClick({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
          done++
          await C.sleep(800)
        } else {
          // 无联想：空格收尾留纯文本
          try { document.execCommand('insertText', false, ' ') } catch {}
        }
        d.afterText = (document.querySelector(
          '.Modal-inner .public-DraftEditor-content')?.textContent ?? '').slice(-60)
      } catch (e) { d.err = String(e.message ?? e) }
      detail.push(d)
      await C.sleep(600)
    }
    return { done, detail }
  }

  // 关闭想法编辑器 → 点“保存草稿”进草稿箱。返回 {saved, dbg}。
  A.closeAndSaveDraft = async () => {
    const dbg = { v: 3, vw: window.innerWidth }
    // 全量快照：aria 含关闭/close 的元素
    dbg.ariaClose = Array.from(document.querySelectorAll('[aria-label]'))
      .filter((el) => /关闭|close/i.test(el.getAttribute('aria-label') ?? ''))
      .slice(0, 8).map((el) => {
        const r = el.getBoundingClientRect()
        return { tag: el.tagName, aria: el.getAttribute('aria-label'),
          cls: (el.className ?? '').toString().slice(0, 100),
          visible: C.isVisible(el),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      })
    // 找 X 关闭按钮（对话框右上角）
    const closeBtn = document.querySelector('[aria-label*="关闭"], [aria-label*="close" i]')
      || C.findByText('button', '×')
      || (() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'))
        return btns.find((b) => {
          const r = b.getBoundingClientRect()
          return r.width > 0 && r.width < 60 && r.x > window.innerWidth * 0.7 && r.y < 200
        })
      })()
    dbg.closeBtnFound = !!closeBtn
    if (closeBtn) {
      const r = closeBtn.getBoundingClientRect()
      dbg.closeBtn = { tag: closeBtn.tagName, text: (closeBtn.textContent ?? '').slice(0, 20),
        aria: closeBtn.getAttribute?.('aria-label') || null, visible: C.isVisible(closeBtn),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    }
    if (!closeBtn || !C.isVisible(closeBtn)) return { saved: false, dbg }
    closeBtn.click()
    await C.sleep(1200)
    // 确认对话框：找“保存草稿”
    dbg.confirmText = (document.body?.textContent ?? '').length
    dbg.dialogText = Array.from(document.querySelectorAll('[role="dialog"], .Modal-inner'))
      .map((el) => (el.textContent ?? '').trim().slice(0, 200))
    const saveBtn = C.findByText('button, [role="button"], div', '保存草稿')
    dbg.saveBtnFound = !!saveBtn
    if (!saveBtn || !C.isVisible(saveBtn)) return { saved: false, dbg }
    saveBtn.click()
    await C.sleep(2000)
    return { saved: true, dbg: null }
  }
  try { console.log('[xpress v0.2.1] zhihu-actions injected, hasCommon=' + !!window.xpressCommon) } catch {}
})()