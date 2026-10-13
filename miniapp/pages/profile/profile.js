const app = getApp()
const config = require('../../config')
const { request, upload } = require('../../services/api')
const { currentVersion } = require('../../services/release-notes')

const MEMBER_ROLES = ['owner', 'member']

function messageOf(error, fallback) {
  return (error && (error.message || error.msg || error.detail)) || fallback
}

Page({
  data: {
    user: {},
    loggedIn: false,
    avatarUrl: '',
    nickname: '',
    roleText: '访客模式',
    canEditCouple: false,
    canManageBanners: false,
    canManageRooms: false,
    currentVersion,
    unreadCount: 0,
    emailEnabled: false,
    savingProfile: false,
    showAvatarPicker: false,
    avatarOptions: [
      { id: 'owner', name: config.coupleNames[0], url: '/assets/previews/avatar-yu.jpg' },
      { id: 'member', name: config.coupleNames[1], url: '/assets/previews/avatar-meng.jpg' }
    ],
    showNotificationSettings: false,
    notificationSettings: { inAppEnabled: true, emailEnabled: false, email: '' },
    savingSettings: false,
    showLoveDatePicker: false,
    loveStartDate: config.relationshipStart.slice(0, 10),
    savingLoveDate: false,
    showActivationSheet: false,
    activationCode: '',
    activating: false,
    showBannerManager: false,
    banners: [],
    bannerDisplayCount: 1,
    bannerMaxDisplayCount: 1,
    bannerMaxCount: 8,
    bannerImageList: [],
    bannerUploading: false,
    savingBanners: false
  },

  onShow() {
    const token = app.globalData.token || wx.getStorageSync('couple_token') || ''
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    const loggedIn = Boolean(token)
    const canEditCouple = user.role === 'owner'
    this.setData({
      user,
      loggedIn,
      avatarUrl: user.avatarUrl || (user.role === 'member' ? '/assets/previews/avatar-meng.jpg' : '/assets/previews/avatar-yu.jpg'),
      nickname: user.nickname || '',
      canEditCouple,
      canManageBanners: MEMBER_ROLES.includes(user.role),
      canManageRooms: false,
      roleText: MEMBER_ROLES.includes(user.role) ? '情侣空间成员' : '访客模式'
    })
    if (!loggedIn) return
    this.loadRoomAccess()
    if (wx.getStorageSync('pending_activation')) {
      wx.removeStorageSync('pending_activation')
      setTimeout(() => this.openActivation(), 120)
    }
    this.loadUnread()
    this.loadNotificationSettings()
    this.loadCoupleSettings()
  },

  loadRoomAccess() {
    const token=app.globalData.token||wx.getStorageSync('couple_token')||''
    this.setData({canManageRooms:false})
    if(!token)return
    request('/lightboard/admin/access').then(result=>{
      const currentToken=app.globalData.token||wx.getStorageSync('couple_token')||''
      if(currentToken===token)this.setData({canManageRooms:!!result.canManage})
    }).catch(()=>{})
  },

  loadUnread() {
    request('/notifications').then(data => this.setData({ unreadCount: Number((data && data.unreadCount) || 0) })).catch(() => {})
  },

  loadNotificationSettings() {
    request('/notifications/settings').then(data => {
      const settings = Object.assign({ inAppEnabled: true, emailEnabled: false, email: '' }, (data && data.settings) || {})
      this.setData({ notificationSettings: settings, emailEnabled: !!settings.emailEnabled })
    }).catch(() => {})
  },

  loadCoupleSettings() {
    request('/couples/settings').then(data => {
      const settings = (data && data.settings) || {}
      if (settings.startTime) this.setData({ loveStartDate: String(settings.startTime).slice(0, 10) })
    }).catch(() => {})
  },

  goLogin() { wx.navigateTo({ url: '/pages/login/login' }) },
  openAbout() { wx.navigateTo({ url: '/pages/about/about' }) },
  openRoomManager() { if(this.data.canManageRooms)wx.navigateTo({url:'/pages/lightboard-admin/lightboard-admin'}) },

  openActivation() {
    if (!this.data.loggedIn) {
      wx.setStorageSync('pending_activation', true)
      return wx.navigateTo({ url: '/pages/login/login' })
    }
    if (MEMBER_ROLES.includes(this.data.user.role)) return wx.showToast({ title: '身份已激活', icon: 'none' })
    this.setData({ showActivationSheet: true, activationCode: '' })
  },
  closeActivation() { if (!this.data.activating) this.setData({ showActivationSheet: false }) },
  onActivationInput(event) {
    const value = typeof event.detail === 'string' ? event.detail : ((event.detail || {}).value || '')
    this.setData({ activationCode: String(value).trim().toLowerCase() })
  },
  submitActivation() {
    if (this.data.activating) return
    const activationCode = this.data.activationCode
    if (!/^[a-f0-9]{16}$/.test(activationCode)) return wx.showToast({ title: '请输入16位激活码', icon: 'none' })
    this.setData({ activating: true })
    request('/couples/join', { method: 'POST', data: { activationCode } }).then(data => {
      const user = data.user || Object.assign({}, this.data.user, { role: 'member' })
      app.globalData.user = user
      wx.setStorageSync('couple_user', user)
      this.setData({ user, roleText: '情侣空间成员', canEditCouple: user.role === 'owner', canManageBanners: MEMBER_ROLES.includes(user.role), showActivationSheet: false, activating: false })
      this.loadRoomAccess()
      wx.showToast({ title: '身份激活成功', icon: 'success' })
    }).catch(error => {
      this.setData({ activating: false })
      wx.showToast({ title: messageOf(error, '激活失败'), icon: 'none' })
    })
  },

  logout() {
    wx.removeStorageSync('couple_token')
    wx.removeStorageSync('couple_user')
    wx.removeStorageSync('pending_activation')
    app.globalData.token = ''
    app.globalData.user = null
    this.setData({ user: {}, loggedIn: false, avatarUrl: '', nickname: '', roleText: '访客模式', canEditCouple: false, canManageBanners: false, canManageRooms: false, unreadCount: 0 })
    wx.showToast({ title: '已退出登录', icon: 'success' })
  },

  onNicknameInput(event) { this.setData({ nickname: event.detail.value }) },

  saveProfile() {
    if (!this.data.loggedIn || this.data.savingProfile) return
    const nickname = (this.data.nickname || '').trim()
    if (!nickname) return wx.showToast({ title: '昵称不能为空', icon: 'none' })
    this.setData({ savingProfile: true })
    request('/users/profile', { method: 'PATCH', data: { nickname, avatarUrl: this.data.avatarUrl || '' } }).then(data => {
      const user = data.user || Object.assign({}, this.data.user, { nickname, avatarUrl: this.data.avatarUrl })
      app.globalData.user = user
      wx.setStorageSync('couple_user', user)
      this.setData({ user, nickname: user.nickname || nickname, avatarUrl: user.avatarUrl || '', savingProfile: false })
      wx.showToast({ title: '已保存', icon: 'success' })
    }).catch(error => {
      this.setData({ savingProfile: false })
      wx.showToast({ title: messageOf(error, '保存失败'), icon: 'none' })
    })
  },

  openAvatarPicker() {
    if (!this.data.loggedIn) return wx.showToast({ title: '登录后可以设置头像', icon: 'none' })
    wx.navigateTo({ url: '/pages/profile-edit/profile-edit' })
  },

  closeAvatarPicker() { this.setData({ showAvatarPicker: false }) },

  selectAvatar(event) {
    const url = event.currentTarget.dataset.url
    if (!url) return
    this.setData({ avatarUrl: url, showAvatarPicker: false }, () => this.saveProfile())
    // 头像是本项目内置的两张默认图，选择后立即同步，避免用户忘记点保存。
  },

  openNotifications() { wx.navigateTo({ url: '/pages/notifications/notifications' }) },

  openNotificationSettings() {
    if (!this.data.loggedIn) return wx.showToast({ title: '登录后可以设置通知', icon: 'none' })
    this.loadNotificationSettings()
    this.setData({ showNotificationSettings: true })
  },

  closeNotificationSettings() {
    if (!this.data.savingSettings) this.setData({ showNotificationSettings: false })
  },

  toggleInApp(event) { this.setData({ 'notificationSettings.inAppEnabled': !!(event.detail && event.detail.value) }) },
  toggleEmail(event) {
    const enabled = !!(event.detail && event.detail.value)
    this.setData({ 'notificationSettings.emailEnabled': enabled, emailEnabled: enabled })
  },
  onEmailInput(event) { this.setData({ 'notificationSettings.email': event.detail.value }) },

  saveNotificationSettings() {
    if (this.data.savingSettings) return
    const settings = this.data.notificationSettings
    this.setData({ savingSettings: true })
    request('/notifications/settings', { method: 'PATCH', data: settings }).then(data => {
      const next = Object.assign(settings, (data && data.settings) || {})
      this.setData({ notificationSettings: next, emailEnabled: !!next.emailEnabled, showNotificationSettings: false, savingSettings: false })
      wx.showToast({ title: '通知设置已保存', icon: 'success' })
    }).catch(error => {
      this.setData({ savingSettings: false })
      wx.showToast({ title: messageOf(error, '设置保存失败'), icon: 'none' })
    })
  },

  openLoveDate() {
    if (!this.data.canEditCouple) return wx.showToast({ title: '只有空间创建者可以修改', icon: 'none' })
    this.setData({ showLoveDatePicker: true })
  },

  closeLoveDate() {
    if (!this.data.savingLoveDate) this.setData({ showLoveDatePicker: false })
  },

  onLoveDateChange(event) {
    const date = event.detail.value
    if (!date || this.data.savingLoveDate) return
    this.setData({ savingLoveDate: true })
    request('/couples/settings', { method: 'PATCH', data: { startTime: date } }).then(() => {
      this.setData({ loveStartDate: date, showLoveDatePicker: false, savingLoveDate: false })
      wx.showToast({ title: '相恋日期已更新', icon: 'success' })
    }).catch(error => {
      this.setData({ savingLoveDate: false })
      wx.showToast({ title: messageOf(error, '日期更新失败'), icon: 'none' })
    })
  },

  openBannerManager() {
    if (!this.data.canManageBanners) return wx.showToast({ title: '绑定情侣后可以管理', icon: 'none' })
    this.setData({ showBannerManager: true })
    this.loadBannerManager()
  },

  closeBannerManager() {
    if (!this.data.bannerUploading && !this.data.savingBanners) this.setData({ showBannerManager: false })
  },

  setBannerRows(rows, displayCount) {
    const banners = (rows || []).map(item => Object.assign({}, item, { isActive: item.isActive !== false && item.isActive !== 0 }))
    const activeCount = banners.filter(item => item.isActive).length
    const maxDisplay = Math.max(1, activeCount)
    const count = Math.max(1, Math.min(maxDisplay, Number(displayCount || this.data.bannerDisplayCount || 1)))
    this.setData({ banners, bannerDisplayCount: count, bannerMaxDisplayCount: maxDisplay })
  },

  loadBannerManager() {
    request('/banners/manage').then(data => {
      this.setData({ bannerMaxCount: Number((data && data.maxCount) || 8) })
      this.setBannerRows((data && data.banners) || [], (data && data.displayCount) || 1)
    }).catch(error => wx.showToast({ title: messageOf(error, '轮播图加载失败'), icon: 'none' }))
  },

  uploadBannerImage(event) {
    if (this.data.banners.length >= this.data.bannerMaxCount) return wx.showToast({ title: `最多 ${this.data.bannerMaxCount} 张`, icon: 'none' })
    const file = Array.isArray(event.detail.file) ? event.detail.file[0] : event.detail.file
    const sourcePath = file && (file.url || file.path || file.tempFilePath)
    if (!sourcePath) return
    this.setData({ bannerImageList: [{ url: sourcePath, status: 'uploading', message: '上传中' }], bannerUploading: true })
    upload('/uploads/images', sourcePath).then(data => {
      if (!data || !data.url) throw new Error('上传响应无效')
      return request('/banners', { method: 'POST', data: { imageUrl: data.url } })
    }).then(data => {
      const next = this.data.banners.concat(data.banner || [])
      this.setData({ bannerImageList: [], bannerUploading: false })
      this.setBannerRows(next, Math.min(next.length, this.data.bannerDisplayCount + 1))
      wx.showToast({ title: '轮播图已上传', icon: 'success' })
    }).catch(error => {
      this.setData({ bannerImageList: [], bannerUploading: false })
      wx.showToast({ title: messageOf(error, '轮播图上传失败'), icon: 'none' })
    })
  },

  toggleBanner(event) {
    const index = Number(event.currentTarget.dataset.index)
    const banners = this.data.banners.slice()
    if (!banners[index]) return
    banners[index] = Object.assign({}, banners[index], { isActive: !!(event.detail && event.detail.value) })
    this.setBannerRows(banners, this.data.bannerDisplayCount)
  },

  moveBanner(event) {
    const index = Number(event.currentTarget.dataset.index)
    const direction = Number(event.currentTarget.dataset.direction)
    const target = index + direction
    if (target < 0 || target >= this.data.banners.length) return
    const banners = this.data.banners.slice()
    const current = banners[index]
    banners[index] = banners[target]
    banners[target] = current
    this.setData({ banners })
  },

  changeBannerDisplayCount(event) {
    this.setData({ bannerDisplayCount: Number(event.detail || 1) })
  },

  deleteBanner(event) {
    const index = Number(event.currentTarget.dataset.index)
    const banner = this.data.banners[index]
    if (!banner) return
    wx.showModal({ title: '删除这张轮播图？', content: '删除后首页将不再显示。', confirmText: '删除', success: result => {
      if (!result.confirm) return
      request(`/banners/${banner.id}`, { method: 'DELETE' }).then(() => {
        const next = this.data.banners.filter((item, itemIndex) => itemIndex !== index)
        this.setBannerRows(next, this.data.bannerDisplayCount)
        wx.showToast({ title: '已删除', icon: 'success' })
      }).catch(error => wx.showToast({ title: messageOf(error, '删除失败'), icon: 'none' }))
    } })
  },

  saveBannerSettings() {
    if (this.data.savingBanners || this.data.bannerUploading) return
    this.setData({ savingBanners: true })
    request('/banners/manage', {
      method: 'PUT',
      data: {
        displayCount: this.data.bannerDisplayCount,
        banners: this.data.banners.map(item => ({ id: item.id, isActive: item.isActive }))
      }
    }).then(data => {
      this.setBannerRows((data && data.banners) || this.data.banners, (data && data.displayCount) || this.data.bannerDisplayCount)
      this.setData({ savingBanners: false, showBannerManager: false })
      wx.showToast({ title: '首页轮播已更新', icon: 'success' })
    }).catch(error => {
      this.setData({ savingBanners: false })
      wx.showToast({ title: messageOf(error, '保存失败'), icon: 'none' })
    })
  }
})
