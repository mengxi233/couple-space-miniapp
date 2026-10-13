const app = getApp()
const { request } = require('../../services/api')

function messageOf(error, fallback) {
  return (error && (error.message || error.msg || error.detail)) || fallback
}

Page({
  data: { notifications: [], loading: false },

  onShow() {
    if (!(app.globalData.token || wx.getStorageSync('couple_token'))) {
      this.setData({ notifications: [] })
      return
    }
    this.loadNotifications()
  },

  loadNotifications() {
    this.setData({ loading: true })
    request('/notifications').then(data => {
      const notifications = ((data && data.notifications) || []).map(item => Object.assign({}, item, {
        iconName: /^question_/.test(item.type || '') ? 'chat-o'
          : item.type === 'task_created' || item.type === 'task_completed' || item.type === 'task_reopened'
          ? 'todo-list-o'
          : item.type === 'order_created' || item.type === 'order_updated' ? 'shop-o' : 'bell'
      }))
      this.setData({ notifications })
    }).catch(error => {
      wx.showToast({ title: messageOf(error, '通知加载失败'), icon: 'none' })
    }).then(() => this.setData({ loading: false }))
  },

  goBack() { wx.navigateBack({ delta: 1 }) },

  openNotification(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.notifications.find(row => Number(row.id) === id)
    if (!item) return
    if(item.type === 'anniversary') wx.navigateTo({url:'/pages/anniversaries/anniversaries'})
    if(/^question_/.test(item.type || '') && item.payload && item.payload.questionId) {
      wx.navigateTo({ url: `/package-question-board/pages/detail/detail?id=${item.payload.questionId}` })
    }
    if(item.isRead)return
    request(`/notifications/${id}/read`, { method: 'POST' }).then(() => {
      this.setData({ notifications: this.data.notifications.map(row => Number(row.id) === id ? Object.assign({}, row, { isRead: true }) : row) })
    }).catch(() => {})
  },

  markAllRead() {
    request('/notifications/read-all', { method: 'POST' }).then(() => {
      this.setData({ notifications: this.data.notifications.map(item => Object.assign({}, item, { isRead: true })) })
      wx.showToast({ title: '都读过啦', icon: 'success' })
    }).catch(error => wx.showToast({ title: messageOf(error, '操作失败'), icon: 'none' }))
  }
})
