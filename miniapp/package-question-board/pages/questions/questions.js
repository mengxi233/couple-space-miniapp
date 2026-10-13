const app = getApp()
const { request, uploadImages } = require('../../services/question-board')
const MEMBER_ROLES = ['owner', 'member']

function valueOf(event) {
  const detail = event && event.detail
  return detail && typeof detail === 'object' && Object.prototype.hasOwnProperty.call(detail, 'value') ? detail.value : detail
}

function blankEditor() { return { title: '', body: '', images: [] } }

function timeText(value) {
  if (!value) return ''
  const date = new Date(String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace('T', ' ')
  const pad = number => String(number).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function decorate(item) {
  const labels = { pending: '等回答', answered: '已回答', closed: '已结束' }
  return Object.assign({}, item, { statusText: labels[item.status] || '进行中', timeText: timeText(item.updatedAt || item.createdAt) })
}

Page({
  data: {
    questions: [], status: 'all', loading: false, loadingMore: false, refreshing: false,
    offset: 0, hasMore: false, total: 0, summary: { pending: 0, answered: 0, closed: 0 },
    tabs: [{ value: 'all', label: '全部' }, { value: 'pending', label: '待回答' }, { value: 'answered', label: '已回答' }, { value: 'closed', label: '已结束' }],
    showEditor: false, editor: blankEditor(), saving: false, uploading: false
  },
  onShow() {
    const token = app.globalData.token || wx.getStorageSync('couple_token')
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    if (!token || !MEMBER_ROLES.includes(user.role)) {
      wx.showModal({ title: '情侣专属功能', content: '登录并激活情侣身份后，才能向对方提问。', showCancel: false,
        complete: () => wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/apps/apps' }) }) })
      return
    }
    this.load(true)
  },
  onPullDownRefresh() {
    this.setData({ refreshing: true })
    this.load(true).finally(() => { this.setData({ refreshing: false }); wx.stopPullDownRefresh() })
  },
  onReachBottom() { if (this.data.hasMore && !this.data.loadingMore) this.load(false) },
  back() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/apps/apps' }) }) },
  load(reset) {
    this.setData(reset ? { loading: true, offset: 0 } : { loadingMore: true })
    const offset = reset ? 0 : this.data.offset
    return request(`/questions?status=${this.data.status}&limit=30&offset=${offset}`).then(result => {
      const incoming = (result.questions || []).map(decorate)
      const summary = result.summary || this.data.summary
      this.setData({ questions: reset ? incoming : this.data.questions.concat(incoming), offset: offset + incoming.length,
        hasMore: !!result.hasMore, total: Number(result.total || 0), summary,
        tabs: this.data.tabs.map(tab => Object.assign({}, tab, { count: tab.value === 'all' ? Number(result.total || 0) : Number(summary[tab.value] || 0) })) })
    }).catch(error => wx.showToast({ title: error.message || '问题加载失败', icon: 'none' }))
      .finally(() => this.setData({ loading: false, loadingMore: false }))
  },
  chooseStatus(event) { this.setData({ status: event.currentTarget.dataset.value }, () => this.load(true)) },
  openQuestion(event) { wx.navigateTo({ url: `/package-question-board/pages/detail/detail?id=${event.currentTarget.dataset.id}` }) },
  openCreate() { this.setData({ showEditor: true, editor: blankEditor() }) },
  closeEditor() { if (!this.data.saving && !this.data.uploading) this.setData({ showEditor: false }) },
  inputTitle(event) { this.setData({ 'editor.title': valueOf(event) || '' }) },
  inputBody(event) { this.setData({ 'editor.body': valueOf(event) || '' }) },
  addImages(event) {
    if (this.data.uploading) return
    const files = Array.isArray(event.detail.file) ? event.detail.file : [event.detail.file]
    this.setData({ uploading: true })
    uploadImages(files).then(urls => {
      const images = this.data.editor.images.concat(urls.filter(Boolean).map(url => ({ url }))).slice(0, 9)
      this.setData({ 'editor.images': images })
    }).catch(error => wx.showToast({ title: error.message || '图片上传失败', icon: 'none' }))
      .finally(() => this.setData({ uploading: false }))
  },
  removeImage(event) {
    if (this.data.uploading) return
    const images = this.data.editor.images.filter((_, index) => index !== event.detail.index)
    this.setData({ 'editor.images': images })
  },
  saveQuestion() {
    if (this.data.saving || this.data.uploading) return
    const title = this.data.editor.title.trim()
    if (!title) return wx.showToast({ title: '请写下问题标题', icon: 'none' })
    this.setData({ saving: true })
    request('/questions', { method: 'POST', data: { title, body: this.data.editor.body.trim(), images: this.data.editor.images } })
      .then(result => {
        this.setData({ showEditor: false, editor: blankEditor() })
        wx.showToast({ title: '已经问出去啦', icon: 'success' })
        this.load(true)
        if (result && result.question && result.question.id) wx.navigateTo({ url: `/package-question-board/pages/detail/detail?id=${result.question.id}` })
      }).catch(error => wx.showToast({ title: error.message || '发送失败', icon: 'none' }))
      .finally(() => this.setData({ saving: false }))
  }
})
