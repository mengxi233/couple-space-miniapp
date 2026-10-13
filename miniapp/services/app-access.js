const MEMBER_ROLES = ['owner', 'member']

function identity() {
  const app = getApp()
  const token = app.globalData.token || wx.getStorageSync('couple_token') || ''
  const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
  return { token, user, activated: Boolean(token && MEMBER_ROLES.includes(user.role)) }
}

function showCoupleAccessGuide(options = {}) {
  const current = identity()
  if (current.activated) return true
  wx.showModal({
    title: '情侣专属应用',
    content: current.token
      ? '完成情侣身份激活后，就可以使用这个应用。'
      : '请先微信登录并激活情侣身份，再使用这个应用。',
    confirmText: current.token ? '去激活' : '去登录',
    confirmColor: '#c97982',
    success: result => {
      if (result.confirm) {
        wx.setStorageSync('pending_activation', true)
        wx.navigateTo({ url: current.token ? '/pages/profile/profile' : '/pages/login/login' })
        return
      }
      if (options.leaveOnCancel) {
        wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/apps/apps' }) })
      }
    }
  })
  return false
}

module.exports = { MEMBER_ROLES, identity, showCoupleAccessGuide }
