const { identity, showCoupleAccessGuide } = require('../../services/app-access')

const APPS = [
  { id: 'anniversaries', name: '纪念日', desc: '重要日子，每一年都记得', tag: '年度提醒', icon: 'calendar-o', coupleOnly: true },
  { id: 'timeline', name: '大事纪年表', desc: '沿着时间重温重要时刻', tag: '共同记录', icon: 'clock-o', coupleOnly: true },
  { id: 'questions', name: '问问对方', desc: '提问、回答和慢慢聊下去', tag: '留言 · 评分', icon: 'chat-o', coupleOnly: true },
  { id: 'decision', name: '做个决定', desc: '把生活的小纠结交给随机', tag: '随机选择', icon: 'replay', coupleOnly: true },
  { id: 'coupleWheel', name: '情侣转盘', desc: '从轻松了解到两个人的深聊', tag: '单机 · 联机', icon: 'like-o', coupleOnly: true },
  { id: 'lightboard', name: '手持灯牌', desc: '把想说的话亮给对方看', tag: '横屏弹幕', icon: 'label-o', coupleOnly: false },
  { id: 'soundboard', name: '六键小剧场', desc: '按下按钮，让剧情响起来', tag: '双主题音效', icon: 'volume-o', coupleOnly: false }
]

Page({
  data: { isCoupleMember: false, apps: [] },
  onShow() {
    const isCoupleMember = identity().activated
    this.setData({ isCoupleMember, apps: this.buildApps(isCoupleMember) })
  },
  buildApps(isCoupleMember) {
    return APPS.map(item => ({
      ...item,
      locked: item.coupleOnly && !isCoupleMember,
      displayTag: item.coupleOnly && !isCoupleMember ? `情侣专属 · ${item.tag}` : item.tag
    }))
  },
  openApp(event) {
    const id = event.currentTarget.dataset.id
    const selected = APPS.find(item => item.id === id)
    if (!selected) return
    if (selected.coupleOnly && !identity().activated) {
      showCoupleAccessGuide()
      return
    }
    const routes = {
      anniversaries: '/pages/anniversaries/anniversaries',
      timeline: '/pages/timeline/timeline',
      questions: '/package-question-board/pages/questions/questions',
      decision: '/pages/decision/decision',
      coupleWheel: '/package-couple-wheel/pages/couple-wheel/couple-wheel',
      lightboard: '/pages/lightboard/lightboard',
      soundboard: '/package-soundboard/pages/soundboard/soundboard'
    }
    if (routes[id]) wx.navigateTo({ url: routes[id] })
  }
})
