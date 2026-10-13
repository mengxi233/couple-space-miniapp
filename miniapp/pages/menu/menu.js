const app = getApp()
const { request, upload } = require('../../services/api')

const MEMBER_ROLES = ['owner', 'member']
const CATEGORY_ORDER = ['荤菜', '素菜', '汤品', '其他']

function categoryIndex(category) {
  const index = CATEGORY_ORDER.indexOf(category)
  return index === -1 ? CATEGORY_ORDER.length : index
}

function sortCategories(categories) {
  return Array.from(new Set((categories || []).filter(Boolean))).sort((left, right) => {
    const orderDiff = categoryIndex(left) - categoryIndex(right)
    return orderDiff || String(left).localeCompare(String(right), 'zh-CN')
  })
}

function sortItems(items) {
  return (items || []).slice().sort((left, right) => {
    const orderDiff = categoryIndex(left.category) - categoryIndex(right.category)
    return orderDiff || String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
  })
}

function messageOf(error, fallback) {
  if (!error) return fallback
  return error.message || error.msg || error.detail || fallback
}

function eventValue(event) {
  const detail = event && event.detail
  return typeof detail === 'string' ? detail : ((detail && detail.value) || '')
}

Page({
  data: {
    items: [],
    categories: [],
    activeCategory: '全部',
    search: '',
    cartCount: 0,
    canEdit: false,
    canInteract: false,
    loading: false,
    showDetail: false,
    selectedItem: null,
    detailQuantity: 1,
    showDishForm: false,
    submitting: false,
    dishForm: {
      name: '',
      category: '荤菜',
      description: '',
      pointsPrice: '',
      imageUrl: ''
    },
    dishImageList: [],
    dishImageUploading: false,
    editingId: 0
  },

  onLoad(options) {
    this.focusItemId = Number(options && options.itemId) || 0
  },

  onShow() {
    this.syncUser()
    this.loadItems()
    this.loadCart()
  },

  syncUser() {
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    const canInteract = MEMBER_ROLES.includes(user.role)
    this.setData({
      canEdit: canInteract,
      canInteract,
      role: user.role || 'guest'
    })
  },

  loadItems() {
    this.setData({ loading: true })
    const params = {}
    if (this.data.search) params.search = this.data.search
    if (this.data.activeCategory && this.data.activeCategory !== '全部') params.category = this.data.activeCategory
    request('/menu/items', { data: params }).then(data => {
      const rows = sortItems(data && data.items ? data.items : [])
      let categories = data && data.categories ? data.categories : []
      if (!categories.length) categories = Array.from(new Set(rows.map(item => item.category).filter(Boolean)))
      categories = sortCategories(categories)
      this.setData({ items: rows, categories }, () => {
        if (this.focusItemId) {
          const target = rows.find(item => Number(item.id) === this.focusItemId)
          if (target) this.setData({ showDetail: true, selectedItem: target, detailQuantity: 1 })
          this.focusItemId = 0
        }
      })
    }).catch(error => {
      if (!this.data.items.length) wx.showToast({ title: messageOf(error, '菜单加载失败'), icon: 'none' })
    }).then(() => this.setData({ loading: false }))
  },

  loadCart() {
    if (!this.data.canInteract) {
      this.setData({ cartCount: 0 })
      return
    }
    request('/menu/cart').then(data => {
      const items = (data && data.items) || []
      this.setData({ cartCount: items.reduce((total, item) => total + Number(item.quantity || 0), 0) })
    }).catch(() => {})
  },

  onSearch(event) {
    this.setData({ search: eventValue(event) })
    clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(() => this.loadItems(), 280)
  },

  onSearchSubmit(event) {
    this.setData({ search: eventValue(event) }, () => this.loadItems())
  },

  selectCategory(event) {
    const category = event.currentTarget.dataset.category || '全部'
    this.setData({ activeCategory: category }, () => this.loadItems())
  },

  openDetail(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.items.find(row => Number(row.id) === id)
    if (item) this.setData({ showDetail: true, selectedItem: item, detailQuantity: 1 })
  },

  editDish(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.items.find(row => Number(row.id) === id)
    if (!item) return
    this.setData({ editingId: id, showDishForm: true, dishForm: { name: item.name || '', category: item.category || '其他', description: item.description || '', pointsPrice: item.pointsPrice || 0, imageUrl: item.imageUrl || '' }, dishImageList: item.imageUrl ? [{ url: item.imageUrl }] : [] })
  },

  deleteDish(event) {
    const id = Number((event.currentTarget.dataset.id) || (this.data.selectedItem && this.data.selectedItem.id))
    if (!id) return
    wx.showModal({ title: '删除这道菜？', content: '删除后菜单中将不再展示。', confirmText: '删除', success: result => {
      if (!result.confirm) return
      request(`/menu/items/${id}`, { method: 'DELETE' }).then(() => { this.closeDetail(); this.loadItems(); wx.showToast({ title: '已删除', icon: 'success' }) }).catch(error => wx.showToast({ title: messageOf(error, '删除失败'), icon: 'none' }))
    } })
  },

  closeDetail() {
    this.setData({ showDetail: false, selectedItem: null, detailQuantity: 1 })
  },

  onDetailQuantityChange(event) {
    const value = Math.max(1, Number(event.detail || 1))
    this.setData({ detailQuantity: value })
  },

  like(event) {
    if (!this.data.canInteract) {
      wx.showToast({ title: '绑定情侣后可以点赞', icon: 'none' })
      return
    }
    const id = Number(event.currentTarget.dataset.id)
    request(`/menu/items/${id}/like`, { method: 'POST' }).then(() => {
      const items = this.data.items.map(item => Number(item.id) === id ? Object.assign({}, item, { likes: Number(item.likes || 0) + 1 }) : item)
      const selectedItem = this.data.selectedItem && Number(this.data.selectedItem.id) === id
        ? Object.assign({}, this.data.selectedItem, { likes: Number(this.data.selectedItem.likes || 0) + 1 })
        : this.data.selectedItem
      this.setData({ items, selectedItem })
    }).catch(error => wx.showToast({ title: messageOf(error, '点赞失败'), icon: 'none' }))
  },

  addCart(event) {
    this.putCart(Number(event.currentTarget.dataset.id), 1)
  },

  addSelectedToCart() {
    const item = this.data.selectedItem
    if (item) this.putCart(Number(item.id), Number(this.data.detailQuantity || 1), true)
  },

  putCart(itemId, quantity, closeDetail) {
    if (!this.data.canInteract) {
      wx.showToast({ title: '登录并绑定情侣后才能点单', icon: 'none' })
      return
    }
    request('/menu/cart', { method: 'POST', data: { itemId, quantity } }).then(data => {
      const items = (data && data.items) || []
      this.setData({ cartCount: items.reduce((total, item) => total + Number(item.quantity || 0), 0) })
      if (closeDetail) this.closeDetail()
      wx.showToast({ title: '已放入购物车', icon: 'success' })
    }).catch(error => wx.showToast({ title: messageOf(error, '加入失败'), icon: 'none' }))
  },

  showCart() {
    wx.navigateTo({ url: '/pages/cart/cart' })
  },

  showOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  },

  openAddDish() {
    if (!this.data.canEdit) {
      wx.showToast({ title: '绑定情侣后可以添加菜品', icon: 'none' })
      return
    }
    this.setData({
      showDishForm: true, editingId: 0,
      dishForm: { name: '', category: '荤菜', description: '', pointsPrice: '', imageUrl: '' },
      dishImageList: [],
      dishImageUploading: false
    })
  },

  closeDishForm() {
    if (!this.data.submitting) this.setData({ showDishForm: false })
  },

  onDishNameChange(event) { this.setData({ 'dishForm.name': eventValue(event) }) },
  onDishCategoryChange(event) { this.setData({ 'dishForm.category': eventValue(event) || '其他' }) },
  onDishDescriptionChange(event) { this.setData({ 'dishForm.description': eventValue(event) }) },
  onDishPriceChange(event) { this.setData({ 'dishForm.pointsPrice': eventValue(event) }) },
  onDishImageChange(event) { this.setData({ 'dishForm.imageUrl': eventValue(event) }) },

  uploadDishImage(event) {
    const file = Array.isArray(event.detail.file) ? event.detail.file[0] : event.detail.file
    const sourcePath = file && (file.url || file.path || file.tempFilePath)
    if (!sourcePath) return
    this.setData({ dishImageList: [{ url: sourcePath, status: 'uploading', message: '上传中' }], dishImageUploading: true })
    upload('/uploads/images', sourcePath).then(data => {
      const url = data && data.url
      if (!url) throw new Error('上传响应无效')
      this.setData({ dishImageList: [{ url, status: 'done' }], 'dishForm.imageUrl': url, dishImageUploading: false })
    }).catch(error => {
      this.setData({ dishImageList: [], dishImageUploading: false })
      wx.showToast({ title: messageOf(error, '图片上传失败'), icon: 'none' })
    })
  },

  deleteDishImage() {
    this.setData({ dishImageList: [], dishImageUploading: false, 'dishForm.imageUrl': '' })
  },

  submitDish() {
    const form = this.data.dishForm
    const name = (form.name || '').trim()
    const category = (form.category || '其他').trim()
    const pointsPrice = form.pointsPrice === '' ? 0 : Number(form.pointsPrice)
    if (!name) return wx.showToast({ title: '请填写菜品名称', icon: 'none' })
    if (!Number.isInteger(pointsPrice) || pointsPrice < 0) return wx.showToast({ title: '积分请输入非负整数', icon: 'none' })
    if (this.data.dishImageUploading) return wx.showToast({ title: '图片还在上传，请稍等', icon: 'none' })
    this.setData({ submitting: true })
    const editingId = Number(this.data.editingId || 0)
    request(editingId ? `/menu/items/${editingId}` : '/menu/items', {
      method: editingId ? 'PATCH' : 'POST',
      data: {
        name,
        category,
        description: (form.description || '').trim(),
        pointsPrice,
        imageUrl: (form.imageUrl || '').trim()
      }
    }).then(() => {
      this.setData({ showDishForm: false, submitting: false, editingId: 0 })
      wx.showToast({ title: editingId ? '菜品已更新' : '菜品已添加', icon: 'success' })
      this.loadItems()
    }).catch(error => {
      this.setData({ submitting: false })
      wx.showToast({ title: messageOf(error, '添加失败'), icon: 'none' })
    })
  }
})
