const { currentVersion, appInfo, releases } = require('../../services/release-notes')

Page({
  data: { currentVersion, appInfo, summary: releases[0].summary },
  openFeatures() { wx.navigateTo({ url: '/pages/releases/releases' }) }
})
