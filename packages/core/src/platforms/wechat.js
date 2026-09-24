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

// 微信公众号封面：拖拽图片到封面区 → 裁剪框点确定 → 等封面生效
function wechatSetCoverByDrop(coverUrl) {
  return (async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms))
    const vis = el => { try { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch { return false } }
    const dbg = {}
    try {
      const area = document.querySelector('#js_cover_area')
      if (!area) return { ok: false, err: 'no-cover-area' }
      const resp = await fetch(coverUrl)
      if (!resp.ok) return { ok: false, err: 'fetch ' + resp.status }
      const blob = await resp.blob()
      const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0]
      const file = new File([blob], `cover.${ext}`, { type: blob.type || 'image/jpeg' })
      const dt = new DataTransfer()
      dt.items.add(file)
      // 单目标拖拽（子节点冒泡覆盖祖先监听；多目标会导致图标连闪）
      const target = document.querySelector('.cover_drop_inner_wrp') || document.querySelector('.select-cover_outer_drop') || area
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
        await sleep(150)
      }
      // 等裁剪框出现：拖拽后出现的任一可见 dialog 即视为封面处理弹窗
      const dlgSel = '.weui-desktop-dialog, [role="dialog"], [class*="crop" i], [class*="dialog" i]'
      let dlg = null
      const t1 = Date.now()
      while (Date.now() - t1 < 12000) {
        const cands = Array.from(document.querySelectorAll(dlgSel)).filter(d => vis(d))
        if (cands.length) { dlg = cands[cands.length - 1]; break }
        await sleep(500)
      }
      dbg.dlgCls = dlg ? String(dlg.className).slice(0, 70) : null
      let crop = null
      if (dlg) {
        // 优先底部主按钮（确认），否则文案匹配
        const findOk = () => {
          const prim = dlg.querySelector('.weui-desktop-dialog__ft .weui-desktop-btn_primary')
            || dlg.querySelector('.weui-desktop-btn_primary')
          if (prim && vis(prim)) return prim
          return Array.from(dlg.querySelectorAll('button, a, [class*="btn" i]'))
            .find(b => /确定|确认|完成|保存|应用/.test((b.textContent || '').trim()) && vis(b))
        }
        let okBtn = null
        const t2 = Date.now()
        while (Date.now() - t2 < 10000) {
          okBtn = findOk()
          if (okBtn && !okBtn.disabled && !/disabled/.test(String(okBtn.className || ''))) break
          await sleep(500)
        }
        if (okBtn) {
          crop = { clicked: (okBtn.textContent || '').trim().slice(0, 8) }
          okBtn.click()
          await sleep(1500)
        } else {
          crop = { err: 'no-confirm-btn', btns: Array.from(dlg.querySelectorAll('button, [class*="btn" i]')).filter(vis).map(b => (b.textContent || '').trim().slice(0, 10)).slice(0, 10) }
        }
      } else {
        crop = { err: 'no-crop-dialog' }
      }
      // 等封面预览出现（背景图/display 变化）
      const t0 = Date.now()
      while (Date.now() - t0 < 30000) {
        const prev = document.querySelector('.js_cover_preview_new') || document.querySelector('.js_cover_preview_square')
        if (prev && vis(prev)) {
          const bg = (prev.style && prev.style.backgroundImage) || ''
          if (bg && bg !== 'none' && !bg.includes('url(\"\")')) return { ok: true, via: 'preview-bg', crop, dbg }
          if (prev.style.display && prev.style.display !== 'none') return { ok: true, via: 'preview-shown', crop, dbg }
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

  // 步骤5b：封面（frontmatter thumb → 封面区拖拽）
  let coverRes = null
  if (content.thumb) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: wechatSetCoverByDrop,
        args: [content.thumb],
        world: 'MAIN',
      })
      coverRes = result
    } catch (e) { coverRes = { ok: false, err: String(e?.message ?? e) } }
    console.log('[COSE] 微信封面结果:', JSON.stringify(coverRes))
    await new Promise(resolve => setTimeout(resolve, 2000))
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
        cover: coverRes, save: saveRes, wordCount: fillResult.wordCount, imageCount: fillResult.imageCount,
      }).slice(0, 900) }),
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
