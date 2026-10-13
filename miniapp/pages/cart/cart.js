const app = getApp()
const { request } = require('../../services/api')

function messageOf(error, fallback) {
  return (error && (error.message || error.msg || error.detail)) || fallback
}

function valueOf(event) {
  const detail = event && event.detail
  return typeof detail === 'string' ? detail : ((detail && detail.value) || '')
}

Page({
  data: {
    items: [],
    totalPoints: 0,
    loading: false,
    loggedIn: false,
    canOrder: false,
    showNote: false,
    note: '',
    submitting: false
  },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    const loggedIn = !!(app.globalData.token || wx.getStorageSync('couple_token'))
    const canOrder = ['owner', 'member'].includes(user.role)
    this.setData({ loggedIn, canOrder })
    if (loggedIn && canOrder) this.loadCart()
    else this.setData({ items: [], totalPoints: 0 })
  },

  loadCart() {
    this.setData({ loading: true })
    request('/menu/cart').then(data => {
      this.setData({ items: (data && data.items) || [], totalPoints: Number((data && data.totalPoints) || 0) })
    }).catch(error => wx.showToast({ title: messageOf(error, '购物车加载失败'), icon: 'none' })).then(() => this.setData({ loading: false }))
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/login' })
  },

  goBack() { wx.navigateBack({ delta: 1 }) },

  changeQuantity(event) {
    const itemId = Number(event.currentTarget.dataset.id)
    const quantity = Math.max(1, Number(event.detail || 1))
    request(`/menu/cart/${itemId}`, { method: 'PATCH', data: { quantity } }).then(data => {
      this.setData({ items: (data && data.items) || [], totalPoints: Number((data && data.totalPoints) || 0) })
    }).catch(error => {
      wx.showToast({ title: messageOf(error, '数量更新失败'), icon: 'none' })
      this.loadCart()
    })
  },

  removeItem(event) {
    const itemId = Number(event.currentTarget.dataset.id)
    request(`/menu/cart/${itemId}`, { method: 'DELETE' }).then(data => {
      this.setData({ items: (data && data.items) || [], totalPoints: Number((data && data.totalPoints) || 0) })
      wx.showToast({ title: '已移出购物车', icon: 'none' })
    }).catch(error => wx.showToast({ title: messageOf(error, '移除失败'), icon: 'none' }))
  },

  openCheckout() {
    if (!this.data.items.length) return wx.showToast({ title: '购物车还是空的', icon: 'none' })
    this.setData({ showNote: true, note: '' })
  },

  closeCheckout() {
    if (!this.data.submitting) this.setData({ showNote: false })
  },

  onNoteChange(event) { this.setData({ note: valueOf(event) }) },

  submitOrder() {
    if (this.data.submitting) return
    this.setData({ submitting: true })
    request('/menu/orders', { method: 'POST', data: { note: (this.data.note || '').trim() } }).then(data => {
      this.setData({ submitting: false, showNote: false, items: [], totalPoints: 0 })
      wx.showToast({ title: '订单已送达', icon: 'success' })
      setTimeout(() => wx.redirectTo({ url: `/pages/orders/orders?id=${data && data.id ? data.id : ''}` }), 500)
    }).catch(error => {
      this.setData({ submitting: false })
      wx.showToast({ title: messageOf(error, '下单失败'), icon: 'none' })
    })
  }
})
