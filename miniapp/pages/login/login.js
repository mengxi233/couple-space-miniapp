const app = getApp()
const { request } = require('../../services/api')

Page({
  data: { invite: '', showInvite: false, loggingIn: false },

  onLoad() {
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    if (app.globalData.token && !['owner', 'member'].includes(user.role)) this.setData({ showInvite: true })
  },

  login() {
    if (this.data.loggingIn) return
    this.setData({ loggingIn: true })
    wx.login({
      success: ({ code }) => {
        request('/auth/wechat-login', { method: 'POST', data: { code } })
          .then(data => {
            if (!data || !data.token) throw new Error('登录响应无效')
            const user = data.user || {}
            app.globalData.token = data.token
            app.globalData.user = user
            wx.setStorageSync('couple_token', data.token)
            wx.setStorageSync('couple_user', user)
            this.setData({ showInvite: !['owner', 'member'].includes(user.role), loggingIn: false })
            wx.showToast({ title: '登录成功', icon: 'success' })
            setTimeout(() => wx.redirectTo({ url: '/pages/profile-edit/profile-edit?fromLogin=1' }), 450)
          })
          .catch(err => {
            this.setData({ loggingIn: false })
            wx.showToast({ title: err?.message || '登录失败', icon: 'none' })
          })
      },
      fail: () => { this.setData({ loggingIn: false }); wx.showToast({ title: '微信登录失败', icon: 'none' }) }
    })
  },

  enterGuest() {
    app.globalData.token = ''
    app.globalData.user = { nickname: '访客', role: 'guest' }
    wx.removeStorageSync('couple_token')
    wx.setStorageSync('couple_user', app.globalData.user)
    wx.navigateBack()
  },

  onInviteInput(e) {
    const value = typeof e.detail === 'string' ? e.detail : ((e.detail || {}).value || '')
    this.setData({ invite: value.trim() })
  },

  bindInvite() {
    if (!/^[a-f0-9]{16}$/.test(this.data.invite)) return wx.showToast({ title: '请输入16位激活码', icon: 'none' })
    request('/couples/join', { method: 'POST', data: { activationCode: this.data.invite } })
      .then(data => {
        if (!data?.user) throw new Error('绑定响应无效')
        app.globalData.user = data.user
        wx.setStorageSync('couple_user', data.user)
        wx.showToast({ title: '绑定成功', icon: 'success' })
        setTimeout(() => wx.navigateBack(), 500)
      })
      .catch(err => wx.showToast({ title: err?.message || '邀请码无效', icon: 'none' }))
  }
})
