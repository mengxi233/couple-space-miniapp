// Small, dependency-free Markdown renderer for the todo detail preview.
// The server stores Markdown as source; this renderer only emits a whitelisted
// subset of HTML understood by the mini-program rich-text component.
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]))
}

function safeUrl(value) {
  const url = String(value || '').trim()
  return /^(https?:\/\/|\/)/i.test(url) ? url.replace(/"/g, '&quot;') : ''
}

function inline(value) {
  let text = escapeHtml(value)
  text = text.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g, (all, alt, url) => {
    const safe = safeUrl(url)
    return safe ? `<img src="${safe}" alt="${escapeHtml(alt)}" style="max-width:100%;border-radius:12rpx;"/>` : escapeHtml(all)
  })
  text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (all, label, url) => {
    const safe = safeUrl(url)
    return safe ? `<a href="${safe}">${label}</a>` : label
  })
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  text = text.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>')
  return text
}

function renderMarkdown(markdown) {
  const source = String(markdown || '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return ''
  const lines = source.split('\n')
  const output = []
  let inCode = false
  let code = []
  let listType = ''

  const closeList = () => {
    if (listType) output.push(`</${listType}>`)
    listType = ''
  }
  const flushCode = () => {
    if (inCode) {
      output.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      code = []
      inCode = false
    }
  }

  lines.forEach(line => {
    if (/^\s*```/.test(line)) {
      closeList()
      if (inCode) flushCode()
      else inCode = true
      return
    }
    if (inCode) {
      code.push(line)
      return
    }
    const trimmed = line.trim()
    if (!trimmed) {
      closeList()
      return
    }
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      closeList()
      const level = heading[1].length
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      return
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      closeList(); output.push('<hr/>'); return
    }
    const quote = trimmed.match(/^>\s?(.*)$/)
    if (quote) {
      closeList(); output.push(`<blockquote>${inline(quote[1])}</blockquote>`); return
    }
    const task = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.+)$/)
    if (task) {
      if (listType !== 'ul') { closeList(); output.push('<ul>'); listType = 'ul' }
      output.push(`<li>${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${inline(task[2])}</li>`)
      return
    }
    const unordered = trimmed.match(/^[-*+]\s+(.+)$/)
    if (unordered) {
      if (listType !== 'ul') { closeList(); output.push('<ul>'); listType = 'ul' }
      output.push(`<li>${inline(unordered[1])}</li>`); return
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/)
    if (ordered) {
      if (listType !== 'ol') { closeList(); output.push('<ol>'); listType = 'ol' }
      output.push(`<li>${inline(ordered[1])}</li>`); return
    }
    closeList()
    output.push(`<p>${inline(trimmed)}</p>`)
  })
  flushCode(); closeList()
  return output.join('')
}

// Convert the built-in mini-program editor output back to the Markdown-like
// source used by the API. The conversion intentionally covers the formats we
// expose in the mobile toolbar and keeps unknown markup as readable text.
function htmlToMarkdown(html) {
  let source = String(html || '').replace(/\r\n?/g, '\n')
  if (!source.trim()) return ''
  source = source
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (_, src) => `![](${src})\n`)
    .replace(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, value) => `## ${value}\n`)
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>|<b[^>]*>([\s\S]*?)<\/b>/gi, (_, strong, bold) => `**${strong || bold || ''}**`)
    .replace(/<em[^>]*>([\s\S]*?)<\/em>|<i[^>]*>([\s\S]*?)<\/i>/gi, (_, italic, oblique) => `*${italic || oblique || ''}*`)
    .replace(/<s[^>]*>([\s\S]*?)<\/s>|<del[^>]*>([\s\S]*?)<\/del>/gi, (_, strike, deleted) => `~~${strike || deleted || ''}~~`)
    .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, value) => `> ${value}\n`)
    .replace(/<li[^>]*data-list=["']unchecked["'][^>]*>([\s\S]*?)<\/li>/gi, '- [ ] $1\n')
    .replace(/<li[^>]*data-list=["']checked["'][^>]*>([\s\S]*?)<\/li>/gi, '- [x] $1\n')
    .replace(/<li[^>]*data-checked=["']false["'][^>]*>([\s\S]*?)<\/li>/gi, '- [ ] $1\n')
    .replace(/<li[^>]*data-checked=["']true["'][^>]*>([\s\S]*?)<\/li>/gi, '- [x] $1\n')
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(?:p|div|section|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;/gi, "'").replace(/&quot;/gi, '"')
  return source.replace(/\n{3,}/g, '\n\n').trim()
}

module.exports = { renderMarkdown, htmlToMarkdown }
