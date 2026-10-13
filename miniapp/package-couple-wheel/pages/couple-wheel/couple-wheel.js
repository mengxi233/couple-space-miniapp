const api = require('../../services/couple-wheel')
const app = getApp()

const COLORS = ['#f3c9cf', '#f8dfcb', '#e0d9ed', '#d9e9e2', '#f4d4bd', '#d9e5f3', '#edd3e7', '#dce8cf', '#f1d8d8', '#e4ddcd']
const CATEGORY_FALLBACK = {
  basic: ['轻松破冰', '日常偏好', '共同回忆', '爱的表达', '沟通相处', '价值观念', '未来想象', '家庭成长', '约会清单', '趣味默契'],
  private: ['心动信号', '身体亲近', '亲吻拥抱', '暧昧氛围', '主动节奏', '私密偏好', '边界安全', '信任脆弱', '热恋想象', '余温照顾']
}

Page({
  data: {
    authorized: false, level: 'basic', mode: 'single', question: null, spinning: false, pageReady: false,
    room: null, roomCode: '', joinCode: '', playerName: '', onlineBusy: false,
    basicCount: 100, privateCount: 100, history: [], catalogSource: '正在加载题库', catalogReady: false
  },

  onLoad(query = {}) {
    const token = app.globalData.token || wx.getStorageSync('couple_token') || ''
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    if (!token || !['owner', 'member'].includes(user.role)) {
      this.showRestricted()
      return
    }
    this.setData({ authorized: true })
    this.used = { basic: [], private: [] }
    this.serverOffset = 0
    this.pendingRoom = String(query.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    this.setLevelData('basic')
    this.refreshCatalog('basic')
    try {
      const saved = wx.getStorageSync('mengyu_couple_wheel') || {}
      this.setData({ playerName: String(saved.name || '').slice(0, 12) })
    } catch (_) {}
    api.access().then(result => {
      if (!result || !result.canUse) {
        this.setData({ authorized: false })
        this.showRestricted()
      }
    }).catch(error => {
      if ([401, 403].includes(error.statusCode)) {
        this.setData({ authorized: false })
        this.showRestricted()
      }
    })
  },

  showRestricted() {
    if (this.restrictedShown) return
    this.restrictedShown = true
    wx.showModal({
      title: '仅限情侣成员',
      content: '请先登录并激活情侣身份，再使用情侣转盘。',
      confirmText: '去激活', confirmColor: '#c97982',
      success: result => {
        if (result.confirm) {
          wx.setStorageSync('pending_activation', true)
          wx.redirectTo({ url: '/pages/profile/profile' })
        } else {
          const pages = getCurrentPages()
          if (pages.length > 1) wx.navigateBack()
          else wx.redirectTo({ url: '/pages/apps/apps' })
        }
      }
    })
  },

  onReady() {
    wx.nextTick(() => this.createSelectorQuery().select('#coupleWheel').fields({ node: true, size: true }).exec(rows => {
      if (!rows[0] || !rows[0].node) return this.setData({ pageReady: true })
      this.canvas = rows[0].node
      this.width = rows[0].width
      this.canvas.width = this.canvas.height = this.width * 2
      this.ctx = this.canvas.getContext('2d')
      this.ctx.scale(2, 2)
      this.draw(0)
      this.setData({ pageReady: true })
      if (this.pendingSpin) {
        const pending = this.pendingSpin
        this.pendingSpin = null
        this.animateQuestion(pending.question, pending.segment, pending.startedAt, pending.duration)
      }
      if (this.pendingRoom) {
        this.setData({ mode: 'online', joinCode: this.pendingRoom })
        this.joinRoom()
      }
    }))
  },

  setLevelData(level) {
    this.pool = []
    this.categories = CATEGORY_FALLBACK[level].slice()
  },

  async refreshCatalog(level) {
    try {
      const result = await api.list(level)
      if (Array.isArray(result.questions) && result.questions.length === 100) {
        if (this.data.level === level) {
          this.pool = result.questions
          this.categories = result.categories.map(item => item.name)
          this.draw(0)
        }
        this.setData({ [`${level}Count`]: result.count, catalogSource: '服务器题库', catalogReady: true })
      }
    } catch (_) {
      if (this.data.level === level) this.setData({ catalogSource: '题库加载失败，点击转盘重试', catalogReady: false })
    }
  },

  async chooseLevel(event) {
    const level = event.currentTarget.dataset.level
    if (level === this.data.level || this.data.spinning) return
    if (level === 'private' && !this.privateConfirmed) {
      const accepted = await new Promise(resolve => wx.showModal({
        title: '私密题库',
        content: '仅供双方自愿的成年情侣使用。任何一方都可以随时跳过、暂停或结束。',
        confirmText: '双方同意', confirmColor: '#c97982', success: result => resolve(result.confirm), fail: () => resolve(false)
      }))
      if (!accepted) return
      this.privateConfirmed = true
    }
    if (this.data.mode === 'online' && this.data.room) {
      if (!this.data.room.isOwner) return wx.showToast({ title: '只有房主可以切换题库', icon: 'none' })
      return this.runOnline(() => api.action(this.data.room.id, 'level', { level }))
    }
    this.applyLevel(level)
  },

  applyLevel(level) {
    this.setLevelData(level)
    this.setData({ level, question: null, history: [], catalogReady: false, catalogSource: '正在加载题库' })
    this.draw(0)
    this.refreshCatalog(level)
  },

  chooseMode(event) {
    const mode = event.currentTarget.dataset.mode
    if (mode === this.data.mode || this.data.spinning) return
    if (mode === 'single') {
      this.stopPolling()
      if (this.data.room) this.exitRoom()
    }
    this.setData({ mode, question: mode === 'single' ? this.data.question : null })
  },

  inputName(event) {
    const playerName = event.detail.value.replace(/[\r\n\t]/g, '').slice(0, 12)
    this.setData({ playerName })
    try { wx.setStorageSync('mengyu_couple_wheel', { name: playerName }) } catch (_) {}
  },

  inputCode(event) { this.setData({ joinCode: event.detail.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }) },

  async createRoom() {
    await this.runOnline(async () => {
      const result = await api.create(this.data.level, this.data.playerName)
      this.applyRoom(result)
      wx.showToast({ title: '房间已创建', icon: 'success' })
    })
  },

  async joinRoom() {
    const code = this.data.joinCode.trim()
    if (code.length !== 6) return wx.showToast({ title: '请输入6位房间码', icon: 'none' })
    await this.runOnline(async () => {
      const result = await api.join(code, this.data.playerName)
      this.applyRoom(result)
      wx.showToast({ title: '已加入房间', icon: 'success' })
    })
  },

  async exitRoom() {
    const room = this.data.room
    if (!room) return
    try { await api.action(room.id, 'leave') } catch (_) {}
    this.stopPolling()
    this.setData({ room: null, roomCode: '', question: null })
    this.applyLevel(this.data.level)
  },

  async runOnline(work) {
    if (this.data.onlineBusy) return
    this.setData({ onlineBusy: true })
    try { await work() } catch (error) { wx.showToast({ title: error.message || '联机请求失败', icon: 'none' }) }
    finally { this.setData({ onlineBusy: false }) }
  },

  applyRoom(result) {
    const room = result.room
    this.serverOffset = Number(result.serverTime || Date.now()) - Date.now()
    if (room.level !== this.data.level) this.applyLevel(room.level)
    const history = (room.history || []).slice().reverse().map(item => ({
      ...item,
      key: item.key || `${item.id}-${item.at}`
    }))
    this.setData({ room, roomCode: room.id, joinCode: room.id, mode: 'online', history })
    this.confirmRemotePrivate(room)
    if (room.spin && room.spin.seq !== this.lastSpinSeq) {
      this.lastSpinSeq = room.spin.seq
      this.categories = room.spin.segments
      this.animateQuestion(room.spin.question, room.spin.segment, room.spin.startedAt, room.spin.duration)
    }
    this.startPolling()
  },

  confirmRemotePrivate(room) {
    if (room.level !== 'private' || this.privateConfirmed || this.privatePrompting) return
    this.privatePrompting = true
    wx.showModal({
      title: '已进入私密题库',
      content: '仅供双方自愿的成年情侣使用。你可以随时跳过、暂停或离开房间。',
      confirmText: '我同意参与', confirmColor: '#c97982',
      success: result => {
        if (result.confirm) this.privateConfirmed = true
        else this.exitRoom()
      },
      complete: () => { this.privatePrompting = false }
    })
  },

  startPolling() {
    if (this.pollTimer || !this.data.room) return
    this.pollTimer = setInterval(async () => {
      if (this.polling || !this.data.room) return
      this.polling = true
      try { this.applyRoom(await api.room(this.data.room.id)) }
      catch (error) {
        if ([403, 404].includes(error.statusCode)) {
          this.stopPolling()
          this.setData({ room: null, roomCode: '' })
          wx.showToast({ title: error.message, icon: 'none' })
        }
      } finally { this.polling = false }
    }, 1500)
  },

  stopPolling() { if (this.pollTimer) clearInterval(this.pollTimer); this.pollTimer = null },

  spin() {
    if (this.data.spinning || !this.ctx) return
    if (this.data.mode === 'online') {
      if (!this.data.room) return wx.showToast({ title: '请先创建或加入房间', icon: 'none' })
      return this.runOnline(async () => this.applyRoom(await api.action(this.data.room.id, 'spin')))
    }
    if (!this.pool.length) {
      this.refreshCatalog(this.data.level)
      return wx.showToast({ title: '正在加载题库，请稍后再试', icon: 'none' })
    }
    let available = this.pool.filter(item => !this.used[this.data.level].includes(item.id))
    if (!available.length) {
      this.used[this.data.level] = []
      available = this.pool
    }
    const question = available[Math.floor(Math.random() * available.length)]
    this.used[this.data.level].push(question.id)
    this.animateQuestion(question, this.categories.indexOf(question.category), Date.now() + 180, 2800)
  },

  animateQuestion(question, segment, startedAt, duration) {
    if (!this.ctx) { this.pendingSpin = { question, segment, startedAt, duration }; return }
    if (this.frame) this.canvas.cancelAnimationFrame(this.frame)
    const startLocal = startedAt - this.serverOffset
    const step = Math.PI * 2 / this.categories.length
    const target = Math.PI * 10 + Math.PI * 2 - (segment + 0.5) * step
    this.setData({ spinning: true, question: null })
    const tick = () => {
      const progress = Math.max(0, Math.min(1, (Date.now() - startLocal) / duration))
      const eased = 1 - Math.pow(1 - progress, 4)
      this.draw(target * eased)
      if (progress < 1) { this.frame = this.canvas.requestAnimationFrame(tick); return }
      const history = this.data.mode === 'online'
        ? this.data.history
        : [{ ...question, key: `${question.id}-${Date.now()}` }].concat(this.data.history).slice(0, 10)
      this.setData({ spinning: false, question, history })
      try { wx.vibrateShort({ type: 'medium' }) } catch (_) {}
    }
    this.frame = this.canvas.requestAnimationFrame(tick)
  },

  draw(angle) {
    if (!this.ctx || !this.categories || !this.categories.length) return
    const context = this.ctx, width = this.width, radius = width / 2 - 10
    const step = Math.PI * 2 / this.categories.length
    context.clearRect(0, 0, width, width)
    context.save(); context.translate(width / 2, width / 2); context.rotate(angle)
    this.categories.forEach((label, index) => {
      context.beginPath(); context.moveTo(0, 0)
      context.arc(0, 0, radius, index * step - Math.PI / 2, (index + 1) * step - Math.PI / 2)
      context.closePath(); context.fillStyle = COLORS[index % COLORS.length]; context.fill()
      context.strokeStyle = '#fff'; context.lineWidth = 1; context.stroke()
      context.save(); context.rotate((index + 0.5) * step - Math.PI / 2)
      context.textAlign = 'right'; context.fillStyle = '#60434c'; context.font = '11px sans-serif'
      context.fillText(label, radius - 12, 4); context.restore()
    })
    context.beginPath(); context.arc(0, 0, 18, 0, Math.PI * 2); context.fillStyle = '#c97982'; context.fill(); context.restore()
    context.save(); context.beginPath(); context.moveTo(width / 2 - 12, 1); context.lineTo(width / 2 + 12, 1); context.lineTo(width / 2, 28); context.closePath(); context.fillStyle = '#904b58'; context.fill(); context.strokeStyle = '#fff7f8'; context.lineWidth = 2; context.stroke(); context.restore()
  },

  copyRoomCode() { if (this.data.roomCode) wx.setClipboardData({ data: this.data.roomCode }) },
  copyCatalogLink() { wx.setClipboardData({ data: `${require('../../../config').apiBaseUrl}/wheel/catalog`, success: () => wx.showToast({ title: '题库网址已复制', icon: 'success' }) }) },
  skipQuestion() {
    if (!this.data.question || this.data.spinning) return
    this.setData({ question: null })
    wx.showToast({ title: '已跳过，换一道也可以', icon: 'none' })
  },
  async removeHistory(event) {
    if (this.data.spinning || this.data.onlineBusy) return
    const key = event.currentTarget.dataset.key
    const item = this.data.history.find(entry => entry.key === key)
    if (!item) return
    if (this.data.mode === 'online' && this.data.room) {
      return this.runOnline(async () => {
        const result = await api.action(this.data.room.id, 'restore', { key })
        this.applyRoom(result)
        wx.showToast({ title: '已删除，下次可能再抽到', icon: 'none' })
      })
    }
    this.used[this.data.level] = this.used[this.data.level].filter(id => id !== item.id)
    this.setData({ history: this.data.history.filter(entry => entry.key !== key) })
    wx.showToast({ title: '已删除，下次可能再抽到', icon: 'none' })
  },
  async clearHistory() {
    if (!this.data.history.length || this.data.spinning || this.data.onlineBusy) return
    const confirmed = await new Promise(resolve => wx.showModal({
      title: '清除最近抽到',
      content: '清除后，这些题会重新回到本轮随机题库中。',
      confirmText: '全部清除', confirmColor: '#c97982',
      success: result => resolve(result.confirm), fail: () => resolve(false)
    }))
    if (!confirmed) return
    if (this.data.mode === 'online' && this.data.room) {
      return this.runOnline(async () => {
        const result = await api.action(this.data.room.id, 'clear_history')
        this.applyRoom(result)
        wx.showToast({ title: '已全部清除', icon: 'success' })
      })
    }
    const restored = new Set(this.data.history.map(item => item.id))
    this.used[this.data.level] = this.used[this.data.level].filter(id => !restored.has(id))
    this.setData({ history: [], question: null })
    wx.showToast({ title: '已全部清除', icon: 'success' })
  },
  back() { wx.navigateBack() },
  onShareAppMessage() {
    if (this.data.room) return { title: `加入情侣转盘 · 房间 ${this.data.room.id}`, path: `/package-couple-wheel/pages/couple-wheel/couple-wheel?room=${this.data.room.id}` }
    return { title: '情侣转盘 · 一起抽一个问题', path: '/package-couple-wheel/pages/couple-wheel/couple-wheel' }
  },
  onHide() { this.stopPolling() },
  onShow() { if (this.data && this.data.room) this.startPolling() },
  onUnload() { this.stopPolling(); if (this.frame && this.canvas) this.canvas.cancelAnimationFrame(this.frame) }
})
