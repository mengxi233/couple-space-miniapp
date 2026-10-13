const { request, upload } = require('../../services/api')
const pad = n => String(n).padStart(2, '0')
Page({
  data: { id: 0, editing: false, loading: false, saving: false, uploading: false, canEdit: false, error: '', images: [], form: { title: '', description: '', details: '', date: '', time: '', linkUrl: '', videoUrl: '' } },
  onLoad(options) {
    const now = new Date()
    this.setData({ id: Number(options.id) || 0, 'form.date': `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}` })
    this.load()
  },
  load() {
    this.setData({ loading: true, error: '', canEdit: false })
    request(this.data.id ? `/timeline/events/${this.data.id}` : '/timeline/events').then(data => {
      if (this.data.id) {
        const event = data.event
        this.saved = event
        this.setData({ form: event, images: event.images.map(url => ({ url })), canEdit: !!data.canEdit, editing: false })
      } else this.setData({ canEdit: !!data.canEdit, editing: true })
    }).catch(error => this.setData({ error: error.message || '加载失败' })).finally(() => this.setData({ loading: false }))
  },
  back() {
    if (this.data.saving || this.data.uploading) return
    wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/timeline/timeline' }) })
  },
  edit() { if (this.data.canEdit) this.setData({ editing: true, playingVideo: false }) },
  playVideo() { this.setData({ playingVideo: true }) },
  videoError() { this.setData({ playingVideo: false }); wx.showToast({ title: '视频无法播放，可复制链接打开', icon: 'none' }) },
  cancel() {
    if (this.data.saving || this.data.uploading) return
    if (!this.data.id) return this.back()
    this.setData({ editing: false, form: this.saved, images: this.saved.images.map(url => ({ url })) })
  },
  input(e) { this.setData({ [`form.${e.currentTarget.dataset.field}`]: e.detail }) },
  dateChange(e) { this.setData({ 'form.date': e.detail.value }) },
  timeChange(e) { this.setData({ 'form.time': e.detail.value }) },
  clearTime() { this.setData({ 'form.time': '' }) },
  addVideo() {
    if (this.data.uploading || this.data.saving) return
    wx.chooseMedia({ count: 1, mediaType: ['video'], sourceType: ['album', 'camera'], maxDuration: 60, success: result => {
      const file = result.tempFiles[0]
      if (!file || file.size > 10 * 1024 * 1024) return wx.showToast({ title: '视频不能超过10MB', icon: 'none' })
      this.setData({ uploading: true })
      upload('/uploads/videos', file.tempFilePath, { timeout: 120000 }).then(data => {
        this.setData({ 'form.videoUrl': data.url })
        wx.showToast({ title: '上传完成，请保存事件', icon: 'none' })
      }).catch(error => wx.showToast({ title: error.message || '视频上传失败', icon: 'none' })).finally(() => this.setData({ uploading: false }))
    } })
  },
  clearVideo() { if (!this.data.uploading && !this.data.saving) this.setData({ 'form.videoUrl': '' }) },
  async addImage(e) {
    if (this.data.uploading || this.data.saving) return
    const files = Array.isArray(e.detail.file) ? e.detail.file : [e.detail.file]
    this.setData({ uploading: true })
    try {
      for (const file of files.slice(0, 6-this.data.images.length)) {
        if (file.size > 10*1024*1024) throw new Error('请选择10MB以内的图片')
        const result = await upload('/uploads/images', file.url || file.path)
        if (!result.url) throw new Error('图片上传失败')
        this.setData({ images: this.data.images.concat({ url: result.url }) })
      }
    } catch (error) { wx.showToast({ title: error.message || '上传失败，请重试', icon: 'none' }) }
    finally { this.setData({ uploading: false }) }
  },
  removeImage(e) { if (!this.data.uploading && !this.data.saving) this.setData({ images: this.data.images.filter((_, index) => index !== e.detail.index) }) },
  preview(e) { const urls = this.data.images.map(image => image.url); wx.previewImage({ urls, current: urls[Number(e.currentTarget.dataset.index)] }) },
  copy(e) {
    const url = this.data.form[e.currentTarget.dataset.field]
    if (url) wx.setClipboardData({ data: url, success: () => wx.showToast({ title: '已复制，请在浏览器打开', icon: 'none' }) })
  },
  save() {
    if (!this.data.canEdit || this.data.saving || this.data.uploading) return
    const form = this.data.form
    if (!form.title.trim()) return wx.showToast({ title: '请填写标题', icon: 'none' })
    for (const field of ['linkUrl', 'videoUrl']) {
      if (form[field] && !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(form[field].trim())) return wx.showToast({ title: '请填写 HTTPS 链接', icon: 'none' })
    }
    this.setData({ saving: true })
    request(this.data.id ? `/timeline/events/${this.data.id}` : '/timeline/events', {
      method: this.data.id ? 'PUT' : 'POST', data: { ...form, images: this.data.images.map(image => image.url) }
    }).then(data => {
      this.saved = data.event
      this.setData({ id: data.event.id, form: data.event, editing: false })
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(error => wx.showToast({ title: error.message || '保存失败，内容已保留', icon: 'none' })).finally(() => this.setData({ saving: false }))
  },
  remove() {
    if (!this.data.canEdit || this.data.saving) return
    wx.showModal({ title: '删除这条大事记录？', content: '删除后无法恢复，双方都将不再看到这条记录。', confirmColor: '#c97982', success: result => {
      if (!result.confirm) return
      this.setData({ saving: true })
      request(`/timeline/events/${this.data.id}`, { method: 'DELETE' }).then(() => {
        this.setData({ saving: false }); this.back()
      }).catch(error => { this.setData({ saving: false }); wx.showToast({ title: error.message || '删除失败', icon: 'none' }) })
    } })
  }
})
