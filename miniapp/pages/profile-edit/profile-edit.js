const app = getApp()
const { request, upload } = require('../../services/api')
Page({
  data: { nickname: '', avatarUrl: '', qq: '', busy: false, loading: true, ready: false, fromLogin: false, error: '', showAvatar: false, showQQ: false, showName: false, draftName: '', statusBarHeight: 44 },
  onLoad(options) { this.setData({ fromLogin: options.fromLogin === '1', statusBarHeight: wx.getWindowInfo ? wx.getWindowInfo().statusBarHeight : 44 }); this.load() },
  openAvatar() { if (!this.data.busy) this.setData({ showAvatar: true, showQQ: false }) },
  openQQ() { if (!this.data.busy) this.setData({ showQQ: true }) },
  openName() { if (!this.data.busy) this.setData({ showName: true, draftName: this.data.nickname }) },
  draftName(e) { this.setData({ draftName: e.detail.value }) },
  confirmName() {
    const nickname = this.data.draftName.trim()
    if (!nickname) return wx.showToast({ title: '请输入名字', icon: 'none' })
    this.setData({ nickname, showName: false })
  },
  closeSheets() { if (!this.data.busy) this.setData({ showAvatar: false, showName: false, showQQ: false }) },
  load() {
    this.setData({ loading: true, ready: false, error: '' })
    request('/auth/me').then(data => this.setData({ nickname: data.user.nickname || '', avatarUrl: data.user.avatarUrl || '', ready: true, showAvatar: this.data.fromLogin }))
      .catch(error => this.setData({ error: error.message || '资料加载失败' })).finally(() => this.setData({ loading: false }))
  },
  nickname(e) { this.setData({ nickname: e.detail.value }) },
  qq(e) { this.setData({ qq: e.detail.value }) },
  chooseAvatar(e) { if (e.detail.avatarUrl) this.uploadAvatar(e.detail.avatarUrl) },
  choosePhoto() {
    if (this.data.busy) return
    wx.chooseMedia({ count: 1, mediaType: ['image'], sizeType: ['compressed'], success: result => this.uploadAvatar(result.tempFiles[0].tempFilePath) })
  },
  async uploadAvatar(path) {
    if (this.data.busy) return
    this.setData({ busy: true })
    try {
      const data = await upload('/uploads/avatars', path)
      this.setData({ avatarUrl: data.url, showAvatar: false, showQQ: false })
      wx.showToast({ title: '头像已选择，请保存资料', icon: 'none' })
    } catch (error) { wx.showToast({ title: error.message || '头像上传失败', icon: 'none' }) }
    finally { this.setData({ busy: false }) }
  },
  fetchQQ() {
    if (this.data.busy) return
    const qq = this.data.qq.trim()
    if (!/^[1-9]\d{4,11}$/.test(qq)) return wx.showToast({ title: '请输入5至12位QQ号', icon: 'none' })
    this.setData({ busy: true })
    request('/users/qq-avatar', { method: 'POST', data: { qq }, timeout: 15000 }).then(data => {
      this.setData({ avatarUrl: data.url, showAvatar: false, showQQ: false })
      wx.showToast({ title: '头像已获取，请保存资料', icon: 'none' })
    }).catch(error => wx.showToast({ title: error.message || 'QQ头像获取失败', icon: 'none' })).finally(() => this.setData({ busy: false }))
  },
  done() { if (!this.data.busy) wx.redirectTo({ url: '/pages/profile/profile' }) },
  save() {
    if (this.data.busy || !this.data.ready) return
    const nickname = this.data.nickname.trim()
    if (!nickname) return wx.showToast({ title: '请输入昵称', icon: 'none' })
    this.setData({ busy: true })
    request('/users/profile', { method: 'PATCH', data: { nickname, avatarUrl: this.data.avatarUrl } }).then(data => {
      app.globalData.user = data.user
      wx.setStorageSync('couple_user', data.user)
      this.setData({ busy: false })
      wx.showToast({ title: '资料已保存', icon: 'success' })
      this.done()
    }).catch(error => { this.setData({ busy: false }); wx.showToast({ title: error.message || '保存失败', icon: 'none' }) })
  }
})
