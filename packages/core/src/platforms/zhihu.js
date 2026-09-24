// 知乎平台配置
const ZhihuPlatform = {
  id: 'zhihu',
  name: 'Zhihu',
  icon: 'https://static.zhihu.com/heifetz/favicon.ico',
  url: 'https://www.zhihu.com',
  publishUrl: 'https://zhuanlan.zhihu.com/write',
  title: '知乎',
  type: 'zhihu',
}

import { injectUtils } from './common.js'


// ---- quantclaw 移植自 xpress（cose 前台 tab，直接 btn.click 有效，无需 CDP） ----
function qcVisible(el) {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}
async function qcUploadArticleCover(coverUrl) {
  if (!coverUrl) return { done: 0, skipped: 'no-cover' }
  const dbg = {}
  const label = Array.from(document.querySelectorAll('label'))
    .find(el => (el.textContent ?? '').includes('添加封面') && qcVisible(el))
  dbg.labelFound = !!label
  dbg.labelCount = Array.from(document.querySelectorAll('label')).filter(el => (el.textContent ?? '').includes('封面')).length
  if (label) {
    try { label.scrollIntoView({ block: 'center' }) } catch {}
    await new Promise(r => setTimeout(r, 300))
    // 点 label 唤出 input（知乎封面 input 可能是点击后才挂载）
    try { label.click() } catch {}
    await new Promise(r => setTimeout(r, 800))
  }
  let input = label?.querySelector?.('input[type="file"]')
    || document.querySelector('label.UploadPicture-wrapper input[type="file"]')
  if (!input) {
    for (let i = 0; i < 8 && !input; i++) {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]')).filter(el => !el.disabled)
      dbg.fileInputCount = inputs.length
      input = inputs.find(el => /image|jpg|jpeg|png/i.test(el.accept || '')) || inputs[inputs.length - 1]
      if (!input) await new Promise(r => setTimeout(r, 800))
    }
  }
  dbg.inputFound = !!input
  if (!input) return { done: 0, err: 'no-cover-input', dbg }
  const before = document.querySelectorAll('.UploadPicture-wrapper img, [class*="cover" i] img').length
  try {
    const blob = await (await fetch(coverUrl)).blob()
    const ext = (blob.type.split('/')[1] ?? 'jpg').split('+')[0]
    const file = new File([blob], `cover_${Date.now()}.${ext}`, { type: blob.type || 'image/jpeg' })
    const dt = new DataTransfer()
    dt.items.add(file)
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  catch (e) { dbg.inputAccept = input.accept; return { done: 0, err: 'fetch-or-fill: ' + String(e?.message ?? e), dbg } }
  dbg.filled = true
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    if (document.querySelectorAll('.UploadPicture-wrapper img, [class*="cover" i] img').length > before
      || /更换封面|重新上传|删除/.test(document.body.textContent ?? '')) return { done: 1 }
    await new Promise(r => setTimeout(r, 800))
  }
  return { done: 0, err: 'cover-upload-timeout', dbg }
}
async function qcAddArticleTopics(topics) {
  const list = (topics ?? []).map(t => String(t).replace(/^#+/, '').trim()).filter(Boolean).slice(0, 3)
  if (!list.length) return { done: 0, skipped: 'no-topics' }
  let done = 0
  const detail = []
  const isVisible = qcVisible
  for (const tag of list) {
    const d = { tag }
    try {
      const addBtn = Array.from(document.querySelectorAll('button'))
        .find(b => (b.textContent ?? '').trim().includes('添加话题') && isVisible(b))
      if (!addBtn) { d.err = 'no-add-btn'; detail.push(d); continue }
      try { addBtn.scrollIntoView({ block: 'center' }) } catch {}
      await new Promise(r => setTimeout(r, 500))
      addBtn.click()
      await new Promise(r => setTimeout(r, 1200))
      let box = null
      for (let i = 0; i < 8 && !box; i++) {
        const cands = Array.from(document.querySelectorAll('.Modal-inner input[placeholder], input[placeholder*="话题"], input[placeholder*="搜索"]'))
          .filter(el => isVisible(el))
        box = cands[cands.length - 1] || null
        if (!box) await new Promise(r => setTimeout(r, 800))
      }
      if (!box) { d.err = 'no-search-box'; detail.push(d); continue }
      d.boxFound = true
      // 前台 tab：execCommand insertText 真按键，React 搜索请求可触发
      box.focus()
      box.select?.()
      try { document.execCommand('selectAll', false, null) } catch {}
      try { document.execCommand('delete', false, null) } catch {}
      box.value = ''
      box.dispatchEvent(new Event('input', { bubbles: true }))
      let typeOk = true
      for (const ch of tag) {
        let ok = false
        try { ok = document.execCommand('insertText', false, ch) } catch {}
        if (!ok) { typeOk = false; break }
        await new Promise(r => setTimeout(r, 60))
      }
      if (!typeOk) {
        const proto = box.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(box, tag)
        else box.value = tag
        box.dispatchEvent(new Event('input', { bubbles: true }))
      }
      d.boxValue = (box.value ?? '').slice(0, 20)
      await new Promise(r => setTimeout(r, 2500))
      const chipsBefore = document.querySelectorAll('.css-nut0iz').length
      const items = Array.from(document.querySelectorAll('li, button, [role="option"]'))
        .filter(el => isVisible(el) && (el.textContent ?? '').trim().length > 0
          && !/添加话题|文章话题/.test(el.textContent ?? '')
          && !el.closest?.('.toolbar-section, .Toolbar, [class*="Toolbar"]')
          && el !== addBtn)
      d.suggestCount = items.length
      const first = items.find(el => (el.textContent ?? '').includes(tag)) || items[0]
      if (first) {
        d.firstText = (first.textContent ?? '').trim().slice(0, 40)
        first.click()
        await new Promise(r => setTimeout(r, 1500))
        const chipsAfter = document.querySelectorAll('.css-nut0iz').length
        d.chipsAfter = chipsAfter
        if (chipsAfter > chipsBefore) done++
        else d.err = 'chip-not-grown'
      }
      else { d.err = 'no-suggest' }
      try { box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) } catch {}
      await new Promise(r => setTimeout(r, 600))
    }
    catch (e) { d.err = String(e?.message ?? e) }
    detail.push(d)
  }
  return { done, detail }
}
// alias（fillZhihuContent 内调用名）
const uploadArticleCover = qcUploadArticleCover
const addArticleTopics = qcAddArticleTopics

// 知乎内容填充函数（在页面主世界中执行）
// 知乎现在支持直接粘贴 Markdown，然后弹窗提示转换
// 注意：需要先调用 injectUtils 注入 window.waitFor
function fillZhihuContent(title, markdown, cover, topics) {
  // 等待满足条件的元素出现（使用 MutationObserver）
  function waitForElement(predicate, timeout = 10000) {
    return new Promise(resolve => {
      const el = predicate()
      if (el) return resolve(el)

      const observer = new MutationObserver(() => {
        const el = predicate()
        if (el) {
          observer.disconnect()
          resolve(el)
        }
      })
      observer.observe(document.body, { childList: true, subtree: true })

      setTimeout(() => {
        observer.disconnect()
        resolve(predicate())
      }, timeout)
    })
  }

  // 等待按钮出现并点击
  async function waitAndClickButton(textMatcher, timeout = 5000) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeout) {
      const buttons = document.querySelectorAll('button')
      for (const btn of buttons) {
        if (textMatcher(btn.textContent)) {
          btn.click()
          console.log('[COSE] 已点击按钮:', btn.textContent)
          return true
        }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return false
  }

  async function fillContent() {
    // 第一步：等待知乎编辑器完全加载（避免"草稿加载中"提示）
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 第二步：填充标题
    async function fillTitle() {
      const titleInput = await window.waitFor('textarea[placeholder*="标题"]')
      if (titleInput && title) {
        titleInput.focus()
        // 使用 nativeInputValueSetter 确保 React 识别变更
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value'
        )?.set
        if (nativeSetter) {
          nativeSetter.call(titleInput, title)
        } else {
          titleInput.value = title
        }
        titleInput.dispatchEvent(new Event('input', { bubbles: true }))
        titleInput.dispatchEvent(new Event('change', { bubbles: true }))
        console.log('[COSE] 知乎标题填充成功')
      }
    }

    // 先填充标题
    await fillTitle()

    // 再等待一下确保标题已保存
    await new Promise(resolve => setTimeout(resolve, 500))

    // 第三步：找到并激活知乎编辑器
    const editorSelectors = [
      '.public-DraftEditor-content',
      '[contenteditable="true"]',
      '.DraftEditor-root',
    ]

    let editor = null
    for (const selector of editorSelectors) {
      editor = document.querySelector(selector)
      if (editor) break
    }

    if (!editor) {
      console.log('[COSE] 未找到知乎编辑器')
      return { success: false, error: 'Editor not found' }
    }

    // 激活编辑器：模拟真实点击序列
    const rect = editor.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2

    // 触发鼠标事件序列激活编辑器
    for (const eventType of ['mousedown', 'mouseup', 'click']) {
      const event = new MouseEvent(eventType, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: centerX,
        clientY: centerY,
        button: 0,
      })
      editor.dispatchEvent(event)
    }

    // 聚焦编辑器
    editor.focus()

    // 清空现有内容
    document.execCommand('selectAll', false)
    document.execCommand('delete', false)

    // 等待编辑器状态更新
    await new Promise(resolve => setTimeout(resolve, 100))

    // 第三步：通过剪贴板 + 键盘事件模拟真实粘贴
    // 这是触发知乎 Markdown 检测弹窗的关键方法
    const contentToFill = markdown || ''

    if (!contentToFill) {
      console.log('[COSE] 没有 Markdown 内容需要填充')
      await fillTitle()
      return { success: true, method: 'empty' }
    }

    try {
      // 使用 ClipboardEvent 模拟粘贴 - 这是触发 Markdown 检测弹窗的关键
      // execCommand('insertText') 不会触发弹窗

      // 检查浏览器兼容性
      if (typeof DataTransfer === 'undefined' || typeof ClipboardEvent === 'undefined') {
        throw new Error('浏览器不支持 DataTransfer 或 ClipboardEvent')
      }

      const dt = new DataTransfer()
      dt.setData('text/plain', contentToFill)

      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      })

      editor.focus()
      const dispatched = editor.dispatchEvent(pasteEvent)
      console.log('[COSE] 已触发 ClipboardEvent，dispatched:', dispatched)

      // 等待 Markdown 检测弹窗出现并点击"确认并解析"
      await new Promise(resolve => setTimeout(resolve, 500))

      const parseClicked = await waitAndClickButton(text => text.includes('确认并解析'), 5000)

      if (parseClicked) {
        console.log('[COSE] 已点击"确认并解析"')

        // 等待解析完成并点击"确认"
        await new Promise(resolve => setTimeout(resolve, 500))

        const confirmClicked = await waitAndClickButton(text => text === '确认', 5000)

        if (confirmClicked) {
          console.log('[COSE] 已点击"确认"，Markdown 解析完成')
        }
      } else {
        console.log('[COSE] 未检测到 Markdown 弹窗')
      }
    } catch (err) {
      console.log('[COSE] 内容插入失败:', err.message || err)
    }

    // 等待内容渲染
    await new Promise(resolve => setTimeout(resolve, 300))

    // quantclaw: 封面 + 话题（cover 单 URL，topics 最多 3 个；失败只记 detail 不抛错）
    let coverRes = null, topicRes = null
    if (cover) {
      try { coverRes = await uploadArticleCover(cover) }
      catch (e) { coverRes = { done: 0, err: String(e?.message ?? e) } }
    }
    if (topics?.length) {
      try { topicRes = await addArticleTopics(topics) }
      catch (e) { topicRes = { done: 0, err: String(e?.message ?? e) } }
    }

    return { success: true, method: 'paste-markdown', cover: coverRes, topics: topicRes }
  }

  return fillContent()
}

/**
 * 知乎同步处理器
 * 知乎现在支持直接粘贴 Markdown，然后弹窗提示转换
 * @param {object} tab - Chrome tab 对象
 * @param {object} content - 内容对象 { title, body, markdown }
 * @param {object} helpers - 帮助函数 { chrome, waitForTab, addTabToSyncGroup }
 * @returns {Promise<{success: boolean, message?: string, tabId?: number}>}
 */
async function syncZhihuContent(tab, content, helpers) {
  const { waitForTab } = helpers

  // 等待页面加载完成（waitForTab 使用 chrome.tabs.onUpdated 监听）
  await waitForTab(tab.id)

  // 激活知乎标签页（避免后台标签页限制导致填充失败）
  try {
    await chrome.tabs.update(tab.id, { active: true })
    console.log('[COSE] 已激活知乎标签页')
    // 等待标签页激活完成
    await new Promise(resolve => setTimeout(resolve, 500))
  } catch (err) {
    console.log('[COSE] 激活标签页失败:', err.message || err)
  }

  // 先注入公共工具函数（waitFor 使用 MutationObserver）
  await injectUtils(globalThis.chrome, tab.id)

  // 在页面中执行内容填充
  const result = await globalThis.chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fillZhihuContent,
    args: [content.title, content.markdown, content.thumb || content.cover || null, content.tags || []],
    world: 'MAIN',
  })

  const fillResult = result?.[0]?.result
  if (fillResult?.success) {
    // 等待 2 秒确保内容已保存
    await new Promise(resolve => setTimeout(resolve, 2000))

    // 等待图片上传完成后再刷新
    console.log('[COSE] 开始监听图片上传请求...')
    const uploadComplete = await waitForImageUploadComplete(tab.id)

    if (uploadComplete) {
      console.log('[COSE] 图片上传完成，准备刷新页面')
      try {
        if (chrome?.tabs && tab?.id) {
          await chrome.tabs.reload(tab.id, { bypassCache: false })
          console.log('[COSE] 已模拟用户刷新知乎页面')
        } else {
          console.log('[COSE] chrome.tabs 或 tab.id 不可用，跳过刷新')
        }
      } catch (err) {
        console.log('[COSE] 刷新页面失败:', err.message || err)
      }
    } else {
      console.log('[COSE] 未检测到图片上传请求或超时，跳过刷新')
    }

    const bits = []
    if (fillResult?.cover) bits.push(`封面:${fillResult.cover.done ? 'OK' : ('FAIL:' + (fillResult.cover.err ?? fillResult.cover.skipped ?? '?'))}`)
    if (fillResult?.topics) bits.push(`话题:${fillResult.topics.done ?? 0}/3${fillResult.topics.err ? ':' + fillResult.topics.err : ''}`)
    const suffix = bits.length ? `（${bits.join('，')}）` : ''
    try {
      await fetch('http://127.0.0.1:8787/log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ step: '[pageagent] zhihu-done', detail: JSON.stringify({
          cover: fillResult?.cover ?? null,
          topics: fillResult?.topics ?? null,
        }).slice(0, 800) }),
      })
    } catch {}
    return { success: true, message: '已打开知乎并同步内容' + suffix, tabId: tab.id }
  } else {
    return { success: false, message: fillResult?.error || '内容同步失败', tabId: tab.id }
  }
}

/**
 * 等待图片上传完成
 * @param {number} tabId - 标签页 ID
 * @param {number} timeout - 超时时间（毫秒）
 * @returns {Promise<boolean>}
 */
async function waitForImageUploadComplete(tabId, timeout = 30000) {
  const startTime = Date.now()

  // 在页面中注入监听脚本
  const result = await globalThis.chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => {
      return new Promise(resolve => {
        const pendingUploads = new Map() // uploadId -> { url, completed }
        let hasUploadRequests = false
        let lastUploadTime = 0

        // 检查是否所有上传都完成
        const checkAllComplete = () => {
          if (pendingUploads.size === 0) return false

          for (const [id, info] of pendingUploads) {
            if (!info.completed) return false
          }
          return true
        }

        // 监听 fetch 请求
        const originalFetch = window.fetch
        window.fetch = function (...args) {
          const url = args[0]
          const options = args[1] || {}

          // 检测图片上传请求（知乎的图片上传通常包含这些特征）
          const isImageUpload =
            typeof url === 'string' &&
            (url.includes('/api/v4/images') ||
              url.includes('/api/v4/upload') ||
              url.includes('upload') ||
              (options.method === 'POST' && url.includes('zhihu.com')))

          if (isImageUpload) {
            hasUploadRequests = true
            lastUploadTime = Date.now()
            const uploadId = Date.now() + Math.random()
            pendingUploads.set(uploadId, { url, completed: false })
            console.log('[COSE] 检测到图片上传请求:', url, uploadId)
          }

          return originalFetch
            .apply(this, args)
            .then(response => {
              if (isImageUpload) {
                console.log('[COSE] 图片上传请求完成:', url, response.status)
                // 标记为已完成
                for (const [id, info] of pendingUploads) {
                  if (info.url === url) {
                    info.completed = true
                    break
                  }
                }
              }
              return response
            })
            .catch(error => {
              if (isImageUpload) {
                console.log('[COSE] 图片上传请求失败:', url, error)
                // 即使失败也标记为已完成（有反馈结果）
                for (const [id, info] of pendingUploads) {
                  if (info.url === url) {
                    info.completed = true
                    break
                  }
                }
              }
              throw error
            })
        }

        // 监听 XMLHttpRequest
        const originalOpen = XMLHttpRequest.prototype.open
        const originalSend = XMLHttpRequest.prototype.send

        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
          this._url = url
          this._method = method
          return originalOpen.apply(this, [method, url, ...rest])
        }

        XMLHttpRequest.prototype.send = function (...args) {
          const isImageUpload =
            this._url &&
            (this._url.includes('/api/v4/images') ||
              this._url.includes('/api/v4/upload') ||
              this._url.includes('upload') ||
              (this._method === 'POST' && this._url.includes('zhihu.com')))

          if (isImageUpload) {
            hasUploadRequests = true
            lastUploadTime = Date.now()
            const uploadId = Date.now() + Math.random()
            pendingUploads.set(uploadId, { url: this._url, completed: false })
            console.log('[COSE] 检测到图片上传 XHR:', this._url, uploadId)

            this.addEventListener('loadend', () => {
              console.log('[COSE] 图片上传 XHR 完成:', this._url, this.status)
              // 标记为已完成
              for (const [id, info] of pendingUploads) {
                if (info.url === this._url) {
                  info.completed = true
                  break
                }
              }
            })
          }

          return originalSend.apply(this, args)
        }

        // 定期检查是否所有上传都完成
        const checkTimer = setInterval(() => {
          // 如果没有检测到任何上传请求，说明可能没有图片需要上传
          if (!hasUploadRequests) {
            console.log('[COSE] 未检测到图片上传请求')
            clearInterval(checkTimer)
            resolve(true)
            return
          }

          // 如果所有上传都完成，并且距离最后一个上传请求已经过去2秒（确保没有新请求）
          if (checkAllComplete() && Date.now() - lastUploadTime > 2000) {
            console.log('[COSE] 所有图片上传请求已完成')
            clearInterval(checkTimer)
            resolve(true)
            return
          }
        }, 500)

        // 10秒后如果没有检测到上传请求，认为没有图片需要上传
        setTimeout(() => {
          if (!hasUploadRequests) {
            console.log('[COSE] 10秒内未检测到上传请求，认为无图片')
            clearInterval(checkTimer)
            resolve(true)
          }
        }, 10000)

        // 超时后无论如何都返回
        setTimeout(() => {
          console.log('[COSE] 等待图片上传超时')
          clearInterval(checkTimer)
          resolve(true) // 即使超时也刷新
        }, timeout)
      })
    },
    world: 'MAIN',
  })

  // 等待监听结果
  const uploadResult = result?.[0]?.result
  console.log('[COSE] 图片上传监听结果:', uploadResult)

  // 给一个额外的缓冲时间，确保图片已经完全加载和渲染
  await new Promise(resolve => setTimeout(resolve, 2000))

  return uploadResult !== false
}

// 导出
export { ZhihuPlatform, fillZhihuContent, syncZhihuContent }
