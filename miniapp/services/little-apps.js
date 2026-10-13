const fonts = [
  { name: '默认字体', family: 'sans-serif', weight: 'normal' },
  { name: '经典粗体', family: 'sans-serif', weight: 'bold' },
  { name: '宋体', family: '"Songti SC", "SimSun", serif', weight: 'normal' },
  { name: '楷体', family: '"Kaiti SC", "KaiTi", serif', weight: 'normal' },
  { name: '像素字 · 缝合像素', family: 'FusionPixel, sans-serif', weight: 'normal' }
]
const themes = [
  { name: '黑底白字', bg: '#000000', fg: '#ffffff' },
  { name: '白底黑字', bg: '#ffffff', fg: '#111111' },
  { name: '蓝底白字', bg: '#1456b8', fg: '#ffffff' },
  { name: '心动玫瑰', bg: '#25151c', fg: '#ff9fba' },
  { name: '暖黄灯牌', bg: '#161308', fg: '#ffe26a' },
  { name: '薄荷荧光', bg: '#081e1c', fg: '#77ffdd' }
]
const defaultBoard = { text: '今天也要开心呀', font: 1, bg: '#000000', fg: '#ffffff', size: 65, speed: 100, direction: 0, glow: false, mirror: false, backgroundImage: '' }
function options(text) {
  const list = [...new Set(String(text).split('\n').map(x => x.trim()).filter(Boolean))]
  if (list.length < 2 || list.length > 20) throw new Error('请输入 2 至 20 个不同选项，每行一个')
  if (list.some(x => Array.from(x).length > 24)) throw new Error('每个选项最多 24 个字')
  return list
}
function pick(count, random = Math.random) {
  if (!Number.isInteger(count) || count < 1) throw new Error('没有可选项')
  return Math.min(count - 1, Math.floor(random() * count))
}
function board(value = {}) {
  const result = { ...defaultBoard, ...value }
  result.text = Array.from(String(result.text || '').replace(/[\r\n]+/g, ' ')).slice(0, 40).join('')
  for (const key of ['fg', 'bg']) if (!/^#[0-9a-f]{6}$/i.test(result[key])) result[key] = defaultBoard[key]
  for (const [key,min,max] of [['font',0,4],['direction',0,2],['size',25,90],['speed',30,240]]) result[key] = Math.min(max,Math.max(min,Number.isFinite(Number(result[key])) ? Number(result[key]) : defaultBoard[key]))
  result.font = Math.floor(result.font); result.direction = Math.floor(result.direction)
  result.glow = !!result.glow; result.mirror = !!result.mirror
  result.backgroundImage = typeof result.backgroundImage === 'string' && /^(wxfile:\/\/|https?:\/\/(usr|tmp)\/)/.test(result.backgroundImage) && result.backgroundImage.length < 1000 ? result.backgroundImage : ''
  return result
}
module.exports = { fonts, themes, defaultBoard, options, pick, board }
