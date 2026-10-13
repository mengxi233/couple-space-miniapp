const { request } = require('../../services/api')
const { layout, dimensions, collect } = require('../../services/timeline-poster')
Page({
  data: { query: '', order: 'desc', busy: false, saving: false, status: '', path: '', error: '', count: 0 },
  onLoad(options) {
    let query = ''
    try { query = decodeURIComponent(options.q || '') } catch (_) {}
    this.setData({ query, order: options.order === 'asc' ? 'asc' : 'desc' })
  },
  onUnload() { this.closed = true; if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1 } },
  back() { wx.navigateBack() },
  preview() { if (this.data.path) wx.previewImage({ current: this.data.path, urls: [this.data.path] }) },
  async generate() {
    if (this.data.busy) return
    this.setData({ busy: true, error: '', status: '读取全部记录…' })
    try {
      const events = await collect(request, this.data.query, this.data.order, () => !this.closed)
      if (this.closed) return
      if (!events.length) throw new Error('当前范围没有记录，请返回调整搜索条件')
      const canvas = this.canvas = await new Promise((resolve, reject) => {
        this.createSelectorQuery().select('#posterCanvas').fields({ node: true }).exec(result => {
          if (result[0] && result[0].node) resolve(result[0].node)
          else reject(new Error('无法创建画布，请更新微信后重试'))
        })
      })
      if (this.closed) return
      const ctx = canvas.getContext('2d')
      const plan = layout(events, (value, size) => { ctx.font = `${size}px sans-serif`; return ctx.measureText(value).width })
      const size = dimensions(plan.height)
      canvas.width = size.width; canvas.height = size.height
      ctx.scale(size.scale, size.scale)
      ctx.fillStyle = '#fff7f8'; ctx.fillRect(0, 0, 750, plan.height)
      ctx.textBaseline = 'top'
      ctx.fillStyle = '#b8757e'; ctx.font = '19px sans-serif'; ctx.fillText('OUR MILESTONES', 48, 45)
      ctx.fillStyle = '#493c40'; ctx.font = 'bold 40px sans-serif'; ctx.fillText('大事纪年表', 48, 85)
      ctx.fillStyle = '#9c8489'; ctx.font = '21px sans-serif'
      ctx.fillText(`${events.length} 个值得记住的时刻 · ${this.data.order === 'asc' ? '最早在前' : '最新在前'}`, 48, 148)
      ctx.strokeStyle = '#ecd5d9'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(57, 220); ctx.lineTo(57, plan.height - 120); ctx.stroke()
      let images = 0
      for (const row of plan.rows) {
        if (this.closed) return
        if (row.type === 'node') {
          ctx.fillStyle = '#c97982'; ctx.beginPath(); ctx.arc(57, row.y + 12, 8, 0, Math.PI * 2); ctx.fill()
        } else if (row.type === 'text') {
          ctx.fillStyle = row.color; ctx.font = `${row.size}px sans-serif`; ctx.fillText(row.text, 100, row.y)
        } else {
          this.setData({ status: `绘制照片 ${++images}…` })
          const picture = await this.loadImage(canvas, row.url)
          if (this.closed) return
          const ratio = Math.min(568 / picture.width, 310 / picture.height)
          ctx.fillStyle = '#f5e9eb'; ctx.fillRect(100, row.y, 568, 310)
          ctx.drawImage(picture, 100 + (568 - picture.width * ratio) / 2, row.y + (310 - picture.height * ratio) / 2, picture.width * ratio, picture.height * ratio)
        }
      }
      ctx.fillStyle = '#bb9693'; ctx.font = '20px sans-serif'; ctx.fillText('把值得记住的时刻，串成我们的故事', 100, plan.height - 60)
      this.setData({ status: '生成完整长图…' })
      const output = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvas, x: 0, y: 0, width: size.width, height: size.height, destWidth: size.width, destHeight: size.height, fileType: 'png', success: resolve, fail: () => reject(new Error('当前设备无法生成这张长图，请缩小搜索范围后重试')) }))
      if (!this.closed) this.setData({ path: output.tempFilePath, count: events.length })
    } catch (error) {
      if (!this.closed) this.setData({ error: error.message || '生成失败，请检查网络后重试' })
    } finally {
      if (this.canvas) { this.canvas.width = 1; this.canvas.height = 1 }
      if (!this.closed) this.setData({ busy: false })
    }
  },
  loadImage(canvas, url) {
    return new Promise((resolve, reject) => {
      const picture = canvas.createImage()
      const timer = setTimeout(() => reject(new Error('照片加载超时，请检查网络和图片下载域名后重试')), 15000)
      picture.onload = () => { clearTimeout(timer); resolve(picture) }
      picture.onerror = () => { clearTimeout(timer); reject(new Error('有照片无法加载，为避免内容缺失，未生成长图。请检查图片地址及 downloadFile 合法域名。')) }
      picture.src = url
    })
  },
  save() {
    if (!this.data.path || this.data.saving) return
    this.setData({ saving: true })
    wx.saveImageToPhotosAlbum({
      filePath: this.data.path,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: error => {
        if (/auth deny|auth denied|authorize/i.test(error.errMsg || '')) {
          wx.showModal({ title: '需要相册权限', content: '请在设置中允许保存到相册，然后再次点击保存。', confirmText: '去设置', confirmColor: '#c97982', success: result => { if (result.confirm) wx.openSetting({}) } })
        } else wx.showToast({ title: '未能保存，可点击长图预览后重试', icon: 'none' })
      },
      complete: () => { if (!this.closed) this.setData({ saving: false }) }
    })
  }
})
