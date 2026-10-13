const { request } = require('../../services/api')
Page({
  data: { events: [], loading: false, error: '', blocked: false, canEdit: false, query: '', order: 'desc', hasMore: false },
  onShow() { this.load() },
  onUnload() { this.sequence = (this.sequence || 0) + 1 },
  back() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/apps/apps' }) }) },
  login() { wx.navigateTo({ url: '/pages/login/login' }) },
  onQuery(e) { this.setData({ query: e.detail }) },
  search() { this.load() },
  clearSearch() { this.setData({ query: '' }); this.load() },
  toggleOrder() { this.setData({ order: this.data.order === 'desc' ? 'asc' : 'desc' }); this.load() },
  more() { if (!this.data.loading && this.data.hasMore) this.load(true) },
  load(append = false) {
    const sequence = this.sequence = (this.sequence || 0) + 1
    this.setData({ loading: true, error: '', ...(append ? {} : { events: [], canEdit: false, hasMore: false }) })
    request('/timeline/events', { data: { q: this.data.query, order: this.data.order, offset: append ? this.data.events.length : 0 } }).then(data => {
      if (sequence !== this.sequence) return
      this.setData({ events: (append ? this.data.events : []).concat(data.events), canEdit: data.canEdit, hasMore: data.hasMore, blocked: false })
    }).catch(error => {
      if (sequence !== this.sequence) return
      const blocked = [401, 403].includes(error.statusCode)
      this.setData({ error: error.message || '加载失败，请重试', blocked, ...(blocked ? { events: [], canEdit: false, hasMore: false } : {}) })
    }).finally(() => { if (sequence === this.sequence) this.setData({ loading: false }) })
  },
  add() { if (this.data.canEdit) wx.navigateTo({ url: '/pages/timeline-event/timeline-event' }) },
  exportImage() { if (this.data.canEdit) wx.navigateTo({ url: `/pages/timeline-export/timeline-export?order=${this.data.order}&q=${encodeURIComponent(this.data.query)}` }) },
  open(e) { wx.navigateTo({ url: `/pages/timeline-event/timeline-event?id=${e.currentTarget.dataset.id}` }) }
})
