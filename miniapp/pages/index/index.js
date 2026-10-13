const app = getApp()
const config = require('../../config')
const { request, upload } = require('../../services/api')
const { recordTimeLabel } = require('../../services/calendar')

const EVENTS_STORAGE_KEY = 'couple_space_calendar_events'
const DELETED_STORAGE_KEY = 'couple_space_calendar_deleted_events'
const LOVE_START = config.relationshipStart
const DEFAULT_BANNERS = [
  { id: 'local-1', url: '/assets/previews/banner-1.jpg' },
  { id: 'local-2', url: '/assets/previews/banner-2.jpg' }
]

function pad(value) {
  return String(value).padStart(2, '0')
}

function toIsoDate(year, month, day) {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

function todayIso() {
  const now = new Date()
  return toIsoDate(now.getFullYear(), now.getMonth(), now.getDate())
}

function dateLabel(dateText) {
  const parts = String(dateText || '').split('-').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) return dateText || ''
  return `${parts[0]}年${parts[1]}月${parts[2]}日`
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return true
}

function normalizeEvent(raw, fallbackId) {
  const source = raw || {}
  const eventDate = source.eventDate || source.event_date || source.date || todayIso()
  const id = source.id || source.eventId || source.event_id || fallbackId
  return {
    id: String(id),
    eventDate: String(eventDate).slice(0, 10),
    title: source.title || source.name || '',
    content: source.content || source.description || '',
    linkUrl: source.linkUrl || source.link_url || source.link || '',
    mood: source.mood || source.emoji || '😊',
    imageUrl: source.imageUrl || source.image_url || source.image || '',
    isPublic: source.isPublic !== undefined
      ? toBoolean(source.isPublic, true)
      : source.is_public !== undefined ? toBoolean(source.is_public, true) : true,
    createdBy: source.createdBy || source.created_by || '',
    updatedBy: source.updatedBy || '',
    updatedByName: source.updatedByName || '',
    updatedAt: source.updatedAt || '',
    editorLabel: source.updatedBy
      ? '最后编辑：' + (source.updatedByName || '未命名用户')
      : '历史编辑者未记录',
    updatedTimeLabel: source.updatedAt ? recordTimeLabel(source.updatedAt) : '',
    createdAt: source.createdAt || source.created_at || '',
    recordTimeLabel: recordTimeLabel(source.createdAt || source.created_at),
    localOnly: Boolean(source.localOnly)
  }
}

function readStorage(key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    return value === '' || value === undefined || value === null ? fallback : value
  } catch (error) {
    return fallback
  }
}

Page({
  data: {
    banners: DEFAULT_BANNERS,
    avatars: [
      { id: 'owner', url: '/assets/previews/avatar-yu.jpg', name: config.coupleNames[0] },
      { id: 'member', url: '/assets/previews/avatar-meng.jpg', name: config.coupleNames[1] }
    ],
    loveTime: '0天 00:00:00',
    loveStart: LOVE_START,
    points: 0,
    user: {},
    roleText: '访客模式',
    canEdit: false,
    calendarWechat: null,
    subscribingCalendar: false,
    calendarSubscriptionHint: '点击订阅，接收对方下一条日历新记录提醒',

    calendarTitle: '',
    calendarYear: 0,
    calendarMonth: 0,
    calendarDays: [],
    selectedDay: 1,
    selectedDate: '',
    selectedDateLabel: '',
    weekDays: ['日', '一', '二', '三', '四', '五', '六'],
    allEvents: [],
    events: [],
    selectedEvents: [],

    showEventEditor: false,
    editingEventId: '',
    eventFormDateLabel: '',
    eventFormTitle: '',
    eventFormContent: '',
    eventFormLink: '',
    eventFormMood: '😊',
    customMoodSelected: false,
    customMood: '',
    eventFormPublic: true,
    eventImageList: [],
    imageUploading: false,
    moodOptions: [
      { value: '😊', label: '开心' },
      { value: '🥰', label: '心动' },
      { value: '😌', label: '平静' },
      { value: '🤗', label: '期待' },
      { value: '😢', label: '想念' },
      { value: '😴', label: '慵懒' }
    ],
    savingEvent: false
  },

  onLoad(options = {}) {
    const incoming = String(options.recordDate || '')
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(incoming) ? new Date(incoming + 'T00:00:00+08:00') : null
    const selectedDate = parsed && Number.isFinite(parsed.getTime()) ? incoming : todayIso()
    const parts = selectedDate.split('-').map(Number)
    const user = app.globalData.user || {}
    this.setData({
      user,
      roleText: this.getRoleText(user),
      canEdit: this.canEditUser(user),
      calendarYear: parts[0],
      calendarMonth: parts[1] - 1,
      selectedDate,
      selectedDay: parts[2],
      selectedDateLabel: dateLabel(selectedDate)
    })
    this.buildCalendar()
    this.loadHome()
    this.loadBanners()
    this.loadEvents()
    this.startLoveClock()
  },

  onShow() {
    this.pageClosed = false
    // 登录页通过 navigateBack 返回时，同步最新的用户角色。
    if (!this.data.selectedDate) return
    const user = app.globalData.user || {}
    const nextCanEdit = this.canEditUser(user)
    if (user.role !== this.data.user.role || nextCanEdit !== this.data.canEdit) {
      this.setData({ user, roleText: this.getRoleText(user), canEdit: nextCanEdit })
    }
    this.loadHome()
    this.loadBanners()
    this.loadEvents()
    this.loadCalendarSubscription()
  },

  onUnload() {
    this.pageClosed = true
    if (this.timer) clearInterval(this.timer)
  },

  getRoleText(user) {
    return ['owner', 'member'].includes(user && user.role) ? '情侣空间' : '访客模式'
  },

  canEditUser(user) {
    return ['owner', 'member'].includes(user && user.role)
  },

  applyCalendarSubscription(config) {
    const hint = config.canAttempt ? '已记录订阅意愿，实际可发送次数以微信为准' :
      config.lastStatus === 'pending' || config.lastStatus === 'sending' ? '有一条提醒待发送，可继续订阅下一条' :
      config.lastStatus === 'no_subscription' ? '微信订阅次数已用完或授权已取消，请重新订阅' :
      ['unknown', 'failed'].includes(config.lastStatus) ? '上次发送未确认或失败，日历记录仍可正常查看' :
      '点击订阅，接收对方下一条日历新记录提醒'
    this.setData({ calendarWechat: config, calendarSubscriptionHint: hint })
  },

  loadCalendarSubscription() {
    if (!this.data.canEdit) { this.setData({ calendarWechat: null }); return }
    const token = app.globalData.token
    request('/calendar/wechat/subscription').then(config => {
      if (!this.pageClosed && token === app.globalData.token && this.data.canEdit) this.applyCalendarSubscription(config)
    }).catch(() => {
      if (!this.pageClosed && token === app.globalData.token) this.setData({ calendarWechat: null,
        calendarSubscriptionHint: '订阅状态暂时无法获取，请稍后重试；不影响日历记录' })
    })
  },

  subscribeCalendar() {
    if (!this.data.canEdit || this.data.subscribingCalendar) return
    if (!this.data.calendarWechat) { this.loadCalendarSubscription(); wx.showToast({ title: '正在刷新，请稍后再点订阅', icon: 'none' }); return }
    if (!this.data.calendarWechat.configured) { wx.showToast({ title: '微信通知服务尚未配置', icon: 'none' }); return }
    if (typeof wx.requestSubscribeMessage !== 'function') { wx.showToast({ title: '请升级微信后重试', icon: 'none' }); return }
    const config = this.data.calendarWechat
    const token = app.globalData.token
    this.setData({ subscribingCalendar: true })
    const finish = () => { if (!this.pageClosed) this.setData({ subscribingCalendar: false }) }
    // Must be called directly during the user's tap, before any network await.
    wx.requestSubscribeMessage({
      tmplIds: [config.templateId],
      success: async result => {
        if (result[config.templateId] !== 'accept') {
          wx.showToast({ title: '未订阅，不影响正常使用', icon: 'none' }); finish(); return
        }
        if (token !== app.globalData.token || this.pageClosed) { finish(); return }
        const receiptId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
        let version = 'release'
        try { version = wx.getAccountInfoSync().miniProgram.envVersion } catch (_) {}
        const body = { templateId: config.templateId, result: 'accept', receiptId,
          state: { develop: 'developer', trial: 'trial', release: 'formal' }[version] || 'formal' }
        try {
          let saved
          try { saved = await request('/calendar/wechat/subscription', { method: 'POST', data: body }) }
          catch (error) {
            if (error.statusCode || token !== app.globalData.token || this.pageClosed) throw error
            saved = await request('/calendar/wechat/subscription', { method: 'POST', data: body })
          }
          if (!this.pageClosed && token === app.globalData.token) {
            this.applyCalendarSubscription(saved)
            wx.showToast({ title: '已订阅下次消息', icon: 'success' })
          }
        } catch (_) { if (!this.pageClosed) wx.showToast({ title: '订阅登记失败，请稍后重试', icon: 'none' }) }
        finally { finish() }
      },
      fail: () => { wx.showToast({ title: '未能打开订阅，请检查微信设置', icon: 'none' }); finish() }
    })
  },

  async stopCalendarSubscription() {
    if (this.data.subscribingCalendar) return
    this.setData({ subscribingCalendar: true })
    try {
      const config = await request('/calendar/wechat/subscription', { method: 'POST', data: { enabled: false } })
      if (!this.pageClosed) this.applyCalendarSubscription(config)
    } catch (_) { wx.showToast({ title: '暂停失败，请稍后重试', icon: 'none' }) }
    finally { if (!this.pageClosed) this.setData({ subscribingCalendar: false }) }
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' })
  },

  loadHome() {
    request('/home').then(data => {
      const couple = (data && data.couple) || {}
      const start = couple.startTime || couple.start_time
      const next = { points: Number((data && data.points) || 0) }
      if (start) {
        let startText = String(start).trim()
        if (/^\d{4}-\d{2}-\d{2}$/.test(startText)) startText = `${startText}T00:00:00+08:00`
        else if (!startText.includes('T')) startText = `${startText.replace(' ', 'T')}+08:00`
        else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(startText)) startText = `${startText}+08:00`
        next.loveStart = startText
      }
      const members = Array.isArray(data && data.members) ? data.members : []
      if (members.length) {
        next.avatars = members.slice(0, 2).map((member, index) => ({
          id: String(member.id || index),
          name: member.role === 'owner' ? config.coupleNames[0] : config.coupleNames[1],
          url: member.avatarUrl || (member.role === 'owner' ? '/assets/previews/avatar-yu.jpg' : '/assets/previews/avatar-meng.jpg')
        }))
      }
      this.setData(next, () => {
        // Settings can be changed from“我的”; restart the formatter with the
        // server value when the page becomes visible again.
        if (next.loveStart) this.startLoveClock()
      })
    }).catch(() => {})
  },

  loadBanners() {
    request('/banners').then(data => {
      const rows = Array.isArray(data && data.banners) ? data.banners : []
      if (data && data.configured) this.setData({ banners: rows })
      else this.setData({ banners: DEFAULT_BANNERS })
    }).catch(() => {
      if (!this.data.banners.length) this.setData({ banners: DEFAULT_BANNERS })
    })
  },

  loadEvents() {
    const localEvents = readStorage(EVENTS_STORAGE_KEY, []).map((item, index) => normalizeEvent(item, `local-${index}`))
    const deletedIds = readStorage(DELETED_STORAGE_KEY, [])
    request('/calendar/events').then(data => {
      const payload = data && (data.events || data.data || data.items || data)
      const remoteItems = Array.isArray(payload) ? payload : []
      const merged = {}
      remoteItems.forEach((item, index) => {
        const event = normalizeEvent(item, `remote-${index}`)
        if (!deletedIds.includes(event.id)) merged[event.id] = event
      })
      // Only unsynced drafts override the server, not stale cached records.
      localEvents.forEach(event => {
        if (event.localOnly && !deletedIds.includes(event.id)) merged[event.id] = event
      })
      this.setEvents(Object.values(merged))
    }).catch(() => {
      this.setEvents(localEvents.filter(event => !deletedIds.includes(event.id)))
    })
  },

  setEvents(events) {
    const normalized = (events || []).map((item, index) => normalizeEvent(item, `local-${index}`))
      .sort((a, b) => `${b.eventDate}${b.createdAt}`.localeCompare(`${a.eventDate}${a.createdAt}`))
    const visible = this.data.canEdit ? normalized : normalized.filter(item => item.isPublic !== false)
    this.setData({
      allEvents: normalized,
      events: visible,
      selectedEvents: visible.filter(item => item.eventDate === this.data.selectedDate)
    }, () => {
      this.persistEvents(normalized)
      this.buildCalendar()
    })
  },

  persistEvents(events) {
    try {
      wx.setStorageSync(EVENTS_STORAGE_KEY, events || this.data.allEvents || this.data.events)
    } catch (error) {
      // 图片临时路径可能导致缓存空间不足，失败时不影响当前页面操作。
    }
  },

  buildCalendar() {
    const year = this.data.calendarYear || new Date().getFullYear()
    const month = this.data.calendarMonth === undefined ? new Date().getMonth() : this.data.calendarMonth
    const firstDay = new Date(year, month, 1).getDay()
    const count = new Date(year, month + 1, 0).getDate()
    const now = new Date()
    const eventMap = {}
    ;(this.data.events || []).forEach(event => {
      eventMap[event.eventDate] = (eventMap[event.eventDate] || 0) + 1
    })
    const days = []
    for (let index = 0; index < firstDay; index += 1) {
      days.push({ day: '', date: '', muted: true })
    }
    for (let day = 1; day <= count; day += 1) {
      const date = toIsoDate(year, month, day)
      days.push({
        day,
        date,
        muted: false,
        today: date === toIsoDate(now.getFullYear(), now.getMonth(), now.getDate()),
        selected: date === this.data.selectedDate,
        marked: date === LOVE_START.slice(0, 10),
        eventCount: eventMap[date] || 0
      })
    }
    // 固定六行高度，切换月份时页面不会跳动。
    while (days.length < 42) days.push({ day: '', date: '', muted: true })
    this.setData({
      calendarTitle: `${year}年${month + 1}月`,
      calendarDays: days,
      selectedEvents: (this.data.events || []).filter(item => item.eventDate === this.data.selectedDate)
    })
  },

  selectDay(event) {
    const date = event.currentTarget.dataset.date
    if (!date) return
    const parts = date.split('-').map(Number)
    this.setData({
      selectedDate: date,
      selectedDay: parts[2],
      selectedDateLabel: dateLabel(date),
      selectedEvents: (this.data.events || []).filter(item => item.eventDate === date)
    }, () => this.buildCalendar())
  },

  previousMonth() {
    this.changeMonth(-1)
  },

  nextMonth() {
    this.changeMonth(1)
  },

  changeMonth(offset) {
    let year = this.data.calendarYear
    let month = this.data.calendarMonth + offset
    if (month < 0) { year -= 1; month = 11 }
    if (month > 11) { year += 1; month = 0 }
    const maxDay = new Date(year, month + 1, 0).getDate()
    const day = Math.min(this.data.selectedDay || 1, maxDay)
    const selectedDate = toIsoDate(year, month, day)
    this.setData({
      calendarYear: year,
      calendarMonth: month,
      selectedDay: day,
      selectedDate,
      selectedDateLabel: dateLabel(selectedDate)
    }, () => this.buildCalendar())
  },

  openAddEvent() {
    if (!this.data.canEdit) {
      wx.showToast({ title: '登录并绑定后才能记录', icon: 'none' })
      return
    }
    this.setData({
      showEventEditor: true,
      editingEventId: '',
      eventFormDateLabel: this.data.selectedDateLabel,
      eventFormTitle: '',
      eventFormContent: '',
      eventFormLink: '',
      eventFormMood: '😊',
      customMoodSelected: false,
      customMood: '',
      eventFormPublic: true,
      eventImageList: [],
      imageUploading: false,
      eventFormImage: ''
    })
  },

  openEditEvent(event) {
    if (!this.data.canEdit) {
      wx.showToast({ title: '访客只能查看公开记录', icon: 'none' })
      return
    }
    const id = String(event.currentTarget.dataset.id)
    const item = (this.data.events || []).find(record => record.id === id)
    if (!item) return
    this.setData({
      showEventEditor: true,
      editingEventId: item.id,
      eventFormDateLabel: dateLabel(item.eventDate),
      eventFormTitle: item.title || '',
      eventFormContent: item.content || '',
      eventFormLink: item.linkUrl || '',
      eventFormMood: item.mood || '😊',
      customMoodSelected: !this.data.moodOptions.some(option => option.value === item.mood),
      customMood: this.data.moodOptions.some(option => option.value === item.mood) ? '' : item.mood,
      eventFormPublic: item.isPublic !== false,
      eventImageList: item.imageUrl ? [{ url: item.imageUrl }] : [],
      imageUploading: false,
      eventFormImage: item.imageUrl || ''
    })
  },

  closeEventEditor() {
    if (this.data.savingEvent) return
    this.setData({ showEventEditor: false })
  },

  onTitleInput(event) {
    this.setData({ eventFormTitle: event.detail })
  },

  onContentInput(event) {
    this.setData({ eventFormContent: event.detail })
  },

  onLinkInput(event) {
    this.setData({ eventFormLink: typeof event.detail === 'string' ? event.detail : ((event.detail || {}).value || '') })
  },

  selectMood(event) {
    this.setData({ eventFormMood: event.currentTarget.dataset.mood || '😊', customMoodSelected: false })
  },

  selectCustomMood() {
    this.setData({ customMoodSelected: true })
  },

  onCustomMoodInput(event) {
    const value = typeof event.detail === 'string' ? event.detail : ((event.detail || {}).value || '')
    this.setData({ customMood: value })
  },

  togglePublic(event) {
    this.setData({ eventFormPublic: Boolean(event.detail && event.detail.value) })
  },

  afterRead(event) {
    const file = Array.isArray(event.detail.file) ? event.detail.file[0] : event.detail.file
    const sourcePath = file && (file.url || file.path || file.tempFilePath)
    if (!sourcePath) return
    this.setData({ eventImageList: [{ url: sourcePath, status: 'uploading', message: '上传中' }], imageUploading: true })
    upload('/uploads/images', sourcePath).then(data => {
      const path = data && data.url
      if (!path) throw new Error('上传响应无效')
      this.setData({ eventImageList: [{ url: path, status: 'done' }], eventFormImage: path, imageUploading: false })
    }).catch(() => {
      // Network outages should not make the diary unusable; keep a durable
      // local copy and clearly tell the user it has not synced to the partner.
      this.persistImage(sourcePath).then(path => {
        this.setData({ eventImageList: [{ url: path, status: 'failed', message: '仅本机' }], eventFormImage: path, imageUploading: false })
        wx.showToast({ title: '图片已保存在本机，网络恢复后可重试', icon: 'none' })
      })
    })
  },

  persistImage(sourcePath) {
    return new Promise(resolve => {
      if (!wx.env || !wx.env.USER_DATA_PATH || !wx.getFileSystemManager) {
        resolve(sourcePath)
        return
      }
      const destination = `${wx.env.USER_DATA_PATH}/calendar-${Date.now()}.jpg`
      wx.getFileSystemManager().copyFile({
        srcPath: sourcePath,
        destPath: destination,
        success: () => resolve(destination),
        fail: () => resolve(sourcePath)
      })
    })
  },

  deleteImage() {
    this.setData({ eventImageList: [], eventFormImage: '', imageUploading: false })
  },

  previewEventImage(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  openEventLink(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '链接已复制', icon: 'success' }) })
  },

  saveEvent() {
    if (this.data.savingEvent) return
    if (this.data.imageUploading) return wx.showToast({ title: '图片还在上传，请稍等', icon: 'none' })
    const title = String(this.data.eventFormTitle || '').trim()
    const content = String(this.data.eventFormContent || '').trim()
    const linkUrl = String(this.data.eventFormLink || '').trim()
    const mood = this.data.customMoodSelected ? String(this.data.customMood || '').trim() : this.data.eventFormMood
    if (!mood) return wx.showToast({ title: '请输入自定义心情', icon: 'none' })
    if (Array.from(mood).length > 16) return wx.showToast({ title: '心情最多16个字符', icon: 'none' })
    if (!title && !content && !linkUrl && !this.data.eventImageList.length) {
      wx.showToast({ title: '写点内容再保存吧', icon: 'none' })
      return
    }
    const imageUrl = this.data.eventImageList.length ? (this.data.eventImageList[0].url || '') : ''
    const payload = {
      eventDate: this.data.selectedDate,
      title,
      content,
      linkUrl,
      mood,
      imageUrl,
      isPublic: this.data.eventFormPublic !== false
    }
    this.setData({ savingEvent: true })
    const editingId = this.data.editingEventId
    const current = (this.data.events || []).find(item => item.id === editingId)
    const createdAt = current ? current.createdAt : new Date().toISOString()
    const editor = app.globalData.user || this.data.user || {}
    const finish = (savedEvent, localOnly, message) => {
      const fallback = normalizeEvent(Object.assign({}, current || {}, payload, {
        id: editingId || `local-${Date.now()}`,
        createdAt,
        updatedBy: localOnly ? (editor.id || '') : '',
        updatedByName: localOnly ? (editor.nickname || '') : '',
        updatedAt: localOnly ? new Date().toISOString() : '',
        localOnly
      }), editingId || `local-${Date.now()}`)
      const next = savedEvent ? normalizeEvent({ ...fallback, ...savedEvent, localOnly: false }, fallback.id) : fallback
      if (editingId) {
        this.setEvents((this.data.events || []).map(item => item.id === editingId ? next : item))
      } else {
        this.setEvents([next].concat(this.data.events || []))
      }
      this.setData({ showEventEditor: false, savingEvent: false })
      wx.showToast({ title: message, icon: localOnly ? 'none' : 'success' })
    }

    if (editingId && current && !current.localOnly) {
      request(`/calendar/events/${encodeURIComponent(editingId)}`, { method: 'PATCH', data: payload })
        .then(data => finish(data && (data.event || data.data || (data.id ? data : null)), false, '已更新'))
        .catch(() => finish(null, true, '已保存到本地'))
      return
    }
    if (!editingId) {
      request('/calendar/events', { method: 'POST', data: payload })
        .then(data => finish(data && (data.event || data.data || (data.id ? data : null)), false, '已记录'))
        .catch(() => finish(null, true, '已保存到本地'))
      return
    }
    finish(null, true, '已更新')
  },

  deleteEvent(event) {
    if (!this.data.canEdit) {
      wx.showToast({ title: '访客不能删除记录', icon: 'none' })
      return
    }
    const id = String(event.currentTarget.dataset.id)
    const item = (this.data.events || []).find(record => record.id === id)
    if (!item) return
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后无法恢复',
      confirmColor: '#c97982',
      success: result => {
        if (!result.confirm) return
        const remove = () => {
          const next = (this.data.events || []).filter(record => record.id !== id)
          this.setEvents(next)
          const deletedIds = readStorage(DELETED_STORAGE_KEY, [])
          if (!deletedIds.includes(id)) deletedIds.push(id)
          wx.setStorageSync(DELETED_STORAGE_KEY, deletedIds)
          wx.showToast({ title: '已删除', icon: 'success' })
        }
        if (!item.localOnly) {
          request(`/calendar/events/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(remove).catch(remove)
        } else remove()
      }
    })
  },

  startLoveClock() {
    if (this.timer) clearInterval(this.timer)
    const start = new Date(this.data.loveStart || LOVE_START).getTime()
    const update = () => {
      const total = Math.max(0, Math.floor((Date.now() - start) / 1000))
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const mins = Math.floor((total % 3600) / 60)
      const secs = total % 60
      this.setData({ loveTime: `${days}天 ${pad(hours)}:${pad(mins)}:${pad(secs)}` })
    }
    update()
    this.timer = setInterval(update, 1000)
  }
})
