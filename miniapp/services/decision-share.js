const { options } = require('./little-apps')
function makeShare(draft, result, unique) {
  const items = options(draft)
  if (items.some(item => !item.trim())) throw new Error('请先填写完整选项')
  const winner = items.indexOf(result)
  const encoded = encodeURIComponent(JSON.stringify({ v: 1, o: items, r: winner, u: !!unique }))
  const path = '/pages/decision/decision?s=' + encoded
  // Keep link payload conservatively bounded, rather than silently truncate choices.
  if (path.length > 1000) throw new Error('分享内容较长，请减少选项或缩短文字后分享')
  return { title: winner >= 0 ? `我抽到了「${result}」｜做个决定` : '这些选项怎么选？一起来转转盘', path }
}
function readShare(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 1000) throw new Error('分享内容无效')
  const value = JSON.parse(decodeURIComponent(encoded))
  if (value.v !== 1 || !Array.isArray(value.o) || !value.o.every(x => typeof x === 'string' && !/[\r\n]/.test(x))) throw new Error('分享内容无效')
  const items = options(value.o.join('\n'))
  if (items.length !== value.o.length || !Number.isInteger(value.r) || value.r < -1 || value.r >= items.length) throw new Error('分享结果无效')
  return { draft: items.join('\n'), result: value.r >= 0 ? items[value.r] : '', unique: !!value.u }
}
module.exports = { makeShare, readShare }
