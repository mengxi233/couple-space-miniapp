const config = require('./config')

App({
  globalData: {
    apiBaseUrl: config.apiBaseUrl,
    appName: config.appName,
    coupleNames: config.coupleNames,
    relationshipStart: config.relationshipStart,
    user: null,
    token: ''
  },
  onLaunch() {
    this.globalData.token = wx.getStorageSync('couple_token') || ''
    this.globalData.user = wx.getStorageSync('couple_user') || null
  }
})
