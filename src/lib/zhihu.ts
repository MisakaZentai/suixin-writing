/**
 * 知乎发布：把渲染好的块序列变成一段可在知乎写文章页执行的脚本。
 *
 * 做法（与社区工具 zhihu-md-importer 相同）：知乎编辑器（Draft.js）处理粘贴事件时，
 * 会把剪贴板里的 HTML 转成段落、标题、列表等，把图片文件交给它自己的上传流程传到知乎图床。
 * 脚本在编辑器上按顺序合成粘贴事件：一段 HTML、一张图片（等它传完）、再一段 HTML……
 *
 * 约定：脚本只往草稿里填内容，从不点"发布"——发不发由作者决定。
 */
export type PublishPart =
  | { kind: 'html'; html: string }
  | { kind: 'image'; name: string; mime: string; base64: string; caption: string }

/**
 * 调整成知乎编辑器接得住的 HTML：正文里的一级标题降为二级，四级以下变成加粗段落，
 * 表格按行变成"单元格 | 单元格"的段落，分割线变成一行居中的破折号。
 */
export function zhihuHtml(html: string): string {
  return html
    .replace(/<h1>([\s\S]*?)<\/h1>/g, '<h2>$1</h2>')
    .replace(/<h([4-6])>([\s\S]*?)<\/h\1>/g, '<p><strong>$2</strong></p>')
    .replace(/<hr\s*\/?>/g, '<p>———</p>')
    .replace(/<table>[\s\S]*?<\/table>/g, (table) =>
      Array.from(table.matchAll(/<tr>([\s\S]*?)<\/tr>/g))
        .map((row) => `<p>${Array.from(row[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g), (c) => c[1].trim()).join(' | ')}</p>`)
        .join('')
    )
}

/** 单个脚本太大时（图片多），拆成几段依次执行；每段约 maxBytes */
export function splitParts(parts: PublishPart[], maxBytes: number): PublishPart[][] {
  const chunks: PublishPart[][] = [[]]
  let size = 0
  for (const p of parts) {
    const n = p.kind === 'html' ? p.html.length : p.base64.length
    if (size + n > maxBytes && chunks[chunks.length - 1].length) {
      chunks.push([])
      size = 0
    }
    chunks[chunks.length - 1].push(p)
    size += n
  }
  return chunks
}

export interface ScriptOptions {
  /** 第几段（从 1 起）/ 共几段；只有第一段设置标题 */
  chunk?: number
  chunks?: number
}

/**
 * 生成在知乎写文章页执行的脚本。执行结果（Promise）形如
 * { ok, done: 已放入的块数, images, uploaded, captions, failed: [...], next? }，
 * 同时存到 window.__suixinPublish，出错时可从 resumeFrom 继续。
 */
export function publishScript(title: string, parts: PublishPart[], opts: ScriptOptions = {}): string {
  const chunk = opts.chunk ?? 1
  const chunks = opts.chunks ?? 1
  // 转义 <：脚本即使被嵌进 <script> 标签，数据里的 "</script>" 也不会提前结束它
  const payload = JSON.stringify({ title: chunk === 1 ? title : null, parts, chunk, chunks }).replace(/</g, '\\u003c')
  return `/* 随心写作 · 知乎发布脚本（第 ${chunk}/${chunks} 段）
 * 在知乎"写文章"页面（https://zhuanlan.zhihu.com/write）执行：把内容按顺序粘贴进草稿。
 * 只填草稿，不会点"发布"。执行结果见返回值或 window.__suixinPublish。
 */
(async () => {
  const DATA = ${payload};
  const IMG_HOST = /^https:\\/\\/(pic\\d*|picx?|pic-private)[^/]*\\.(zhimg|zhihu)\\.com/;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = (window.__suixinPublish = window.__suixinPublish || { chunks: {} });
  const result = { ok: false, chunk: DATA.chunk, chunks: DATA.chunks, done: 0, total: DATA.parts.length, images: 0, uploaded: 0, captions: 0, failed: [] };
  state.chunks[DATA.chunk] = result;
  state.last = result;

  if (!/(^|\\.)zhihu\\.com$/.test(location.hostname)) {
    result.error = '请在知乎写文章页面执行（当前是 ' + location.hostname + '）';
    return result;
  }
  const editor = document.querySelector('.public-DraftEditor-content[contenteditable="true"]') || document.querySelector('[contenteditable="true"]');
  if (!editor) {
    result.error = '没找到知乎的正文编辑器：请先打开 https://zhuanlan.zhihu.com/write 并等页面加载完';
    return result;
  }

  // 标题：知乎用 React 管理输入框，要走原生 setter 再派发 input 事件
  if (DATA.title) {
    const titleBox = document.querySelector('textarea[placeholder*="标题"], input[placeholder*="标题"]');
    if (titleBox) {
      const proto = titleBox.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(titleBox, DATA.title.slice(0, 100));
      titleBox.dispatchEvent(new Event('input', { bubbles: true }));
      result.title = true;
    } else result.title = false;
  }

  // 光标放到正文最后，并让编辑器同步选区
  const caretToEnd = () => {
    editor.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    editor.dispatchEvent(new Event('select', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
    document.dispatchEvent(new Event('selectionchange'));
  };
  const paste = (dt) => editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  const zhihuImages = () => Array.from(editor.querySelectorAll('img')).filter((i) => IMG_HOST.test(i.src)).length;
  const pendingImages = () => Array.from(editor.querySelectorAll('img')).filter((i) => /^(blob|data):/.test(i.src)).length;

  const setCaption = async (before, caption) => {
    // 尽力而为：新上传的那张图下面的"添加图片注释"
    for (let t = 0; t < 10; t++) {
      const figures = Array.from(editor.querySelectorAll('figure'));
      const fig = figures[figures.length - 1];
      const box = fig && fig.querySelector('textarea, input, figcaption[contenteditable="true"], [contenteditable="true"]');
      if (box && box !== editor) {
        if (box.tagName === 'TEXTAREA' || box.tagName === 'INPUT') {
          const proto = box.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(box, caption);
          box.dispatchEvent(new Event('input', { bubbles: true }));
          box.dispatchEvent(new Event('blur', { bubbles: true }));
        } else {
          box.textContent = caption;
          box.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
        return true;
      }
      await sleep(200);
    }
    return false;
  };

  const start = Math.max(0, (window.__suixinResumeFrom || 1) - 1);
  window.__suixinResumeFrom = undefined;
  for (let i = start; i < DATA.parts.length; i++) {
    const part = DATA.parts[i];
    caretToEnd();
    await sleep(80);
    const dt = new DataTransfer();
    if (part.kind === 'html') {
      dt.setData('text/html', part.html);
      dt.setData('text/plain', part.html.replace(/<[^>]+>/g, ''));
      paste(dt);
      await sleep(250);
    } else {
      result.images++;
      const bin = atob(part.base64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const before = zhihuImages();
      dt.items.add(new File([bytes], part.name, { type: part.mime }));
      paste(dt);
      // 等知乎把图传到它的图床：新图出现且没有上传中的图
      let ok = false;
      for (let t = 0; t < 120; t++) {
        await sleep(500);
        if (zhihuImages() > before && pendingImages() === 0) { ok = true; break; }
      }
      if (ok) {
        result.uploaded++;
        if (part.caption && (await setCaption(before, part.caption))) result.captions++;
      } else {
        result.failed.push({ part: i + 1, name: part.name, reason: '图片 60 秒内没有传完' });
        result.resumeFrom = i + 2;
      }
      await sleep(300);
    }
    result.done = i + 1;
  }
  result.ok = result.failed.length === 0;
  result.note = '内容已放进草稿（知乎会自动保存）。请作者检查后自己点"发布"。';
  return result;
})();
`
}
