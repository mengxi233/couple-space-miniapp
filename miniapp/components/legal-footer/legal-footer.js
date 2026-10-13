const config = require('../../config')

Component({
  data: { year: new Date().getFullYear(), filingNumber: config.filingNumber, copyrightOwner: config.copyrightOwner },
  methods: {
    showFiling() {
      wx.showModal({
        title: '小程序备案信息',
        content: `${config.filingNumber}\n查询网址：https://beian.miit.gov.cn/\n也可在微信右上角「…」的小程序资料中查看备案信息。`,
        confirmText: '复制网址',
        success: result => {
          if (result.confirm) wx.setClipboardData({ data: 'https://beian.miit.gov.cn/' })
        }
      })
    }
  }
})
