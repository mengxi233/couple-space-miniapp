const app = getApp()
const { request, upload } = require('../../services/api')

const STATUS_TEXT = { pending: '等待对方接单', cooking: '正在准备', completed: '已经完成', cancelled: '已取消' }

function messageOf(error, fallback) { return (error && (error.message || error.msg || error.detail)) || fallback }

Page({
  data: {
    orders: [],
    filteredOrders: [],
    activeTab: 'all',
    loading: false,
    selectedOrder: null,
    showDetail: false,
    detailLoading: false,
    role: 'guest',
    reviewText: '',
    reviewImageList: [],
    reviewImageUrl: '',
    reviewUploading: false,
    reviewSubmitting: false
  },

  onLoad(options) { this.focusId = Number(options && options.id) || 0 },

  closePage() { wx.navigateBack({ delta: 1 }) },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    this.setData({ role: user.role || 'guest' })
    this.loadOrders()
  },

  loadOrders() {
    this.setData({ loading: true })
    request('/menu/orders').then(data => {
      const rows = ((data && data.orders) || []).map(order => this.decorate(order))
      this.setData({ orders: rows }, () => {
        this.filterOrders()
        if (this.focusId) {
          const target = rows.find(item => Number(item.id) === this.focusId)
          if (target) this.openDetailByOrder(target)
          this.focusId = 0
        }
      })
    }).catch(error => {
      if (!this.data.orders.length) wx.showToast({ title: messageOf(error, '订单加载失败'), icon: 'none' })
    }).then(() => this.setData({ loading: false }))
  },

  decorate(order) {
    const item = Object.assign({}, order)
    item.statusText = STATUS_TEXT[item.status] || item.status || '未知状态'
    item.dateText = item.createdAt ? String(item.createdAt).replace('T', ' ').slice(0, 16) : ''
    item.isReceiver = Number(item.receiverId) === Number((app.globalData.user || {}).id)
    item.isParticipant = item.isReceiver || Number(item.buyerId) === Number((app.globalData.user || {}).id)
    item.canCook = item.isParticipant && item.status === 'pending'
    item.canComplete = item.isParticipant && item.status === 'cooking'
    item.canCancel = item.isParticipant && ['pending', 'cooking'].includes(item.status)
    item.canReview = item.isReceiver && item.status === 'completed'
    item.hasReview = Boolean(item.review && (item.review.content || item.review.imageUrl))
    return item
  },

  switchTab(event) { this.setData({ activeTab: event.currentTarget.dataset.tab || 'all' }, () => this.filterOrders()) },

  filterOrders() {
    const tab = this.data.activeTab
    const rows = this.data.orders || []
    this.setData({ filteredOrders: rows.filter(order => tab === 'all' || (tab === 'active' ? ['pending', 'cooking'].includes(order.status) : order.status === 'completed')) })
  },

  openDetail(event) {
    const id = Number(event.currentTarget.dataset.id)
    const order = this.data.orders.find(item => Number(item.id) === id)
    if (order) this.openDetailByOrder(order)
  },

  openDetailByOrder(order) {
    this.setData({
      showDetail: true,
      detailLoading: true,
      selectedOrder: order,
      reviewText: '',
      reviewImageList: [],
      reviewImageUrl: '',
      reviewUploading: false,
      reviewSubmitting: false
    })
    request(`/menu/orders/${order.id}`).then(data => {
      const review = data && data.review ? data.review : null
      const detail = this.decorate(Object.assign({}, order, data && data.order, { items: (data && data.items) || [], review }))
      detail.hasReview = Boolean(review && (review.content || review.imageUrl))
      this.setData({
        selectedOrder: detail,
        detailLoading: false,
        reviewText: review && review.content ? review.content : '',
        reviewImageUrl: review && review.imageUrl ? review.imageUrl : '',
        reviewImageList: review && review.imageUrl ? [{ url: review.imageUrl }] : []
      })
    }).catch(() => this.setData({ detailLoading: false }))
  },

  closeDetail() { this.setData({ showDetail: false, selectedOrder: null }) },

  openMenuItem(event) {
    const itemId = Number(event.currentTarget.dataset.itemId)
    if (!itemId) return
    wx.navigateTo({ url: `/pages/menu/menu?itemId=${itemId}` })
  },

  updateStatus(event) {
    const order = this.data.selectedOrder
    const status = event.currentTarget.dataset.status
    if (!order || !status) return
    if (status === 'cooking' && !order.canCook) return wx.showToast({ title: '只有接单的一方可以开始制作', icon: 'none' })
    if (status === 'completed' && !order.canComplete) return wx.showToast({ title: '请先开始制作订单', icon: 'none' })
    if (status === 'cancelled' && !order.canCancel) return wx.showToast({ title: '当前不能取消该订单', icon: 'none' })
    if (status === 'cancelled') {
      wx.showModal({ title: '取消这份心意？', content: '取消后购物车内容不会自动恢复。', confirmText: '确认取消', success: result => { if (result.confirm) this.updateOrderStatus(order, status) } })
      return
    }
    this.updateOrderStatus(order, status)
  },

  updateOrderStatus(order, status) {
    request(`/menu/orders/${order.id}`, { method: 'PATCH', data: { status } }).then(() => {
      wx.showToast({ title: status === 'completed' ? '完成啦' : '订单状态已更新', icon: 'success' })
      this.closeDetail()
      this.loadOrders()
    }).catch(error => wx.showToast({ title: messageOf(error, '更新失败'), icon: 'none' }))
  },

  onReviewChange(event) {
    const detail = event && event.detail
    this.setData({ reviewText: typeof detail === 'string' ? detail : ((detail && detail.value) || '') })
  },

  uploadReviewImage(event) {
    const file = Array.isArray(event.detail.file) ? event.detail.file[0] : event.detail.file
    const sourcePath = file && (file.url || file.path || file.tempFilePath)
    if (!sourcePath) return
    this.setData({ reviewImageList: [{ url: sourcePath, status: 'uploading', message: '上传中' }], reviewUploading: true })
    upload('/uploads/images', sourcePath).then(data => {
      const url = data && data.url
      if (!url) throw new Error('上传响应无效')
      this.setData({ reviewImageList: [{ url, status: 'done' }], reviewImageUrl: url, reviewUploading: false })
    }).catch(error => {
      this.setData({ reviewImageList: [], reviewImageUrl: '', reviewUploading: false })
      wx.showToast({ title: messageOf(error, '图片上传失败'), icon: 'none' })
    })
  },

  deleteReviewImage() {
    this.setData({ reviewImageList: [], reviewImageUrl: '' })
  },

  submitReview() {
    const order = this.data.selectedOrder
    if (!order || !order.canReview) {
      wx.showToast({ title: '只有接单的一方可以评价', icon: 'none' })
      return
    }
    if (this.data.reviewUploading) {
      wx.showToast({ title: '图片还在上传，请稍等', icon: 'none' })
      return
    }
    const content = (this.data.reviewText || '').trim()
    const imageUrl = this.data.reviewImageUrl || ''
    if (!content && !imageUrl) {
      wx.showToast({ title: '写一点评价或上传一张照片吧', icon: 'none' })
      return
    }
    if (this.data.reviewSubmitting) return
    this.setData({ reviewSubmitting: true })
    request(`/menu/orders/${order.id}/review`, {
      method: 'POST',
      data: { content, imageUrl }
    }).then(data => {
      const review = data && data.review ? data.review : { content, imageUrl }
      const selectedOrder = Object.assign({}, order, { review, hasReview: true })
      this.setData({ selectedOrder, reviewText: review.content || content, reviewImageUrl: review.imageUrl || imageUrl, reviewImageList: (review.imageUrl || imageUrl) ? [{ url: review.imageUrl || imageUrl }] : [], reviewSubmitting: false })
      wx.showToast({ title: '完成记录已保存', icon: 'success' })
      this.loadOrders()
    }).catch(error => {
      this.setData({ reviewSubmitting: false })
      wx.showToast({ title: messageOf(error, '评价保存失败'), icon: 'none' })
    })
  }
})
