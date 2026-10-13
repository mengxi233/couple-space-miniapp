// Logical coordinates are independent of device pixel ratio: one complete image only.
function layout(events, measure) {
  const rows = []
  let y = 210
  function text(value, size, color) {
    if (!value) return
    for (const paragraph of String(value).split('\n')) {
      let line = ''
      for (const char of paragraph) {
        if (line && measure(line + char, size) > 568) {
          rows.push({ type: 'text', text: line, size, color, y }); y += size * 1.6; line = ''
        }
        line += char
      }
      rows.push({ type: 'text', text: line, size, color, y }); y += size * 1.6
    }
    y += 10
  }
  events.forEach(event => {
    rows.push({ type: 'node', y })
    text(`${event.date} ${event.time || ''}`, 23, '#b8757e')
    text(event.title, 30, '#493c40')
    text(event.description, 24, '#806b71')
    text(event.details, 23, '#806b71')
    for (const url of event.images || []) {
      rows.push({ type: 'image', url, y }); y += 330
    }
    text(event.linkUrl ? `相关链接：${event.linkUrl}` : '', 20, '#b8757e')
    text(event.videoUrl ? `视频链接：${event.videoUrl}` : '', 20, '#b8757e')
    y += 34
  })
  return { rows, height: Math.ceil(y + 90) }
}
function dimensions(height) {
  const scale = Math.min(1, 12000 / height)
  if (scale < 0.6) throw new Error('记录内容太长，无法生成清晰的单张长图。请返回搜索筛选后再导出。')
  return { width: Math.floor(750 * scale), height: Math.ceil(height * scale), scale }
}
async function collect(request, query, order, active = () => true) {
  const events = [], ids = new Set()
  let more = true
  while (more) {
    if (!active()) throw new Error('已取消')
    const result = await request('/timeline/events', { data: { q: query, order, offset: events.length } })
    if (!result.events.length && result.hasMore) throw new Error('记录发生变化，请重新导出')
    for (const event of result.events) {
      if (ids.has(event.id)) throw new Error('记录发生变化，请重新导出')
      ids.add(event.id); events.push(event)
    }
    more = result.hasMore
    if (events.length > 500) throw new Error('记录较多，请返回搜索筛选后再导出单张长图')
  }
  return events
}
module.exports = { layout, dimensions, collect }
