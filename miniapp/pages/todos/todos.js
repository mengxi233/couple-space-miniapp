const app = getApp()
const { request, upload } = require('../../services/api')
const { renderMarkdown, htmlToMarkdown } = require('../../services/markdown')

function messageOf(error, fallback) {
  return (error && (error.message || error.msg || error.detail)) || fallback
}

// Vant Field emits a primitive string for change/input by default, while
// native input and textarea components emit { value }. Keep both forms
// working so the title is not lost when the save button is tapped directly.
function fieldValue(event) {
  const detail = event && event.detail
  return detail && typeof detail === 'object' && Object.prototype.hasOwnProperty.call(detail, 'value')
    ? detail.value
    : detail
}

function today() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function blankEditor() {
  return {
    title: '', markdown: '', priority: 'normal', tagsText: '',
    dueDate: '', dueTime: '', assigneeId: '', isPublic: true,
    attachments: []
  }
}

function normaliseAttachments(items) {
  if (!Array.isArray(items)) return []
  return items.map(item => {
    if (typeof item === 'string') return { url: item }
    return item && typeof item === 'object' ? Object.assign({}, item) : null
  }).filter(item => item && item.url).slice(0, 9)
}

function summaryOf(markdown) {
  return String(markdown || '').replace(/```[\s\S]*?```/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[\#>*_`~-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 90)
}

function decorateTodo(item) {
  return Object.assign({}, item, {
    dueText: item.dueDate ? `${item.dueDate}${item.dueTime ? ` ${String(item.dueTime).slice(0, 5)}` : ''}` : '未安排日期',
    overdue: !item.isCompleted && item.dueDate && item.dueDate < today(),
    summary: summaryOf(item.markdown || item.detail),
    attachments: normaliseAttachments(item.attachments)
  })
}

Page({
  data: {
    todos: [], loading: false, refreshing: false, loadingMore: false,
    status: 'pending', dateScope: '', priority: '', q: '', tag: '',
    total: 0, hasMore: false, offset: 0, role: 'guest', canEdit: false,
    userId: 0, partnerId: '',
    pendingCount: 0, completedCount: 0,
    showEditor: false, showDetail: false, showActions: false, selectedTodo: null,
    selectedHtml: '', editor: blankEditor(), editorPreview: false, editorHtml: '',
    editingId: 0, saving: false, deleting: false, uploading: false,
    members: [],
    pendingTodoId: 0,
    statusTabs: [
      { value: 'pending', label: '未完成' },
      { value: 'all', label: '全部' },
      { value: 'completed', label: '已完成' }
    ],
  },

  onLoad(query = {}) {
    const todoId = Number(query.todoId || query.id || 0)
    if (todoId > 0) this.setData({ pendingTodoId: todoId })
  },

  onShow() {
    const user = app.globalData.user || wx.getStorageSync('couple_user') || {}
    this.setData({ userId: Number(user.id || 0) })
    this.loadTodos(true).then(() => this.openPendingTodo())
  },

  onPullDownRefresh() {
    if (this.data.refreshing) return
    this.setData({ refreshing: true })
    this.loadTodos(true).finally(() => {
      // scroll-view refreshers are controlled by refresher-triggered;
      // stopPullDownRefresh alone only affects the page-level refresher.
      this.setData({ refreshing: false })
      wx.stopPullDownRefresh()
    })
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loadingMore) this.loadTodos(false)
  },

  buildQuery(reset) {
    const data = this.data
    const query = [
      `status=${encodeURIComponent(data.status)}`,
      `limit=30`,
      `offset=${reset ? 0 : data.offset}`
    ]
    if (data.dateScope) query.push(`dateScope=${encodeURIComponent(data.dateScope)}`)
    if (data.priority) query.push(`priority=${encodeURIComponent(data.priority)}`)
    if (data.q) query.push(`q=${encodeURIComponent(data.q)}`)
    if (data.tag) query.push(`tag=${encodeURIComponent(data.tag)}`)
    return `/todos?${query.join('&')}`
  },

  loadTodos(reset) {
    if (reset) this.setData({ loading: true, offset: 0 })
    else this.setData({ loadingMore: true })
    return request(this.buildQuery(reset)).then(result => {
      const next = (result.todos || []).map(decorateTodo)
      this.setData({
        todos: reset ? next : this.data.todos.concat(next),
        total: Number(result.total || 0), hasMore: !!result.hasMore,
        pendingCount: Number(result.pendingCount || 0), completedCount: Number(result.completedCount || 0),
        offset: (reset ? next.length : this.data.offset + next.length),
        role: result.role || 'guest', canEdit: ['owner', 'member'].includes(result.role),
        partnerId: ((result.members || []).find(member => Number(member.id) !== Number(this.data.userId)) || {}).id || '',
        members: result.members || [],
        loading: false, loadingMore: false, refreshing: false
      })
    }).catch(error => {
      this.setData({ loading: false, loadingMore: false, refreshing: false })
      wx.showToast({ title: messageOf(error, '待办加载失败'), icon: 'none' })
    })
  },

  chooseStatus(event) {
    const value = event.currentTarget.dataset.value
    this.setData({ status: value }, () => this.loadTodos(true))
  },

  chooseDateScope(event) {
    const value = event.currentTarget.dataset.value || ''
    this.setData({ dateScope: this.data.dateScope === value ? '' : value }, () => this.loadTodos(true))
  },

  choosePriority(event) {
    const value = event.currentTarget.dataset.value || ''
    this.setData({ priority: this.data.priority === value ? '' : value }, () => this.loadTodos(true))
  },

  onSearch(event) {
    const value = event.detail && (event.detail.value || event.detail)
    this.setData({ q: String(value || '').trim() }, () => this.loadTodos(true))
  },

  openCreate() {
    if (!this.data.canEdit) return wx.showToast({ title: '登录并激活后可以新增待办', icon: 'none' })
    this.setData({ showEditor: true, editingId: 0, editor: blankEditor(), editorPreview: false, editorHtml: '' }, () => this.syncEditorContents())
  },

  openDetail(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.todos.find(todo => Number(todo.id) === id)
    if (item) this.showTodoDetail(item)
  },

  showTodoDetail(item) {
    const selected = decorateTodo(item)
    this.setData({ showDetail: true, selectedTodo: selected, selectedHtml: renderMarkdown(selected.markdown || selected.detail) })
  },

  openPendingTodo() {
    const id = Number(this.data.pendingTodoId || 0)
    if (!id) return
    this.setData({ pendingTodoId: 0 })
    const local = this.data.todos.find(todo => Number(todo.id) === id)
    if (local) return this.showTodoDetail(local)
    request(`/todos/${id}`).then(result => {
      if (result && result.todo) this.showTodoDetail(result.todo)
      else throw new Error('待办不存在或暂不可见')
    }).catch(error => wx.showToast({ title: messageOf(error, '待办不存在或暂不可见'), icon: 'none' }))
  },

  closeDetail() { this.setData({ showDetail: false, selectedTodo: null, selectedHtml: '' }) },

  editSelected() {
    const item = this.data.selectedTodo
    if (!item) return
    this.closeDetail()
    this.setData({
      showEditor: true, editingId: item.id, editorPreview: false, editorHtml: renderMarkdown(item.markdown || item.detail),
      editor: {
        title: item.title || '', markdown: item.markdown || item.detail || '', priority: item.priority || 'normal',
        tagsText: (item.tags || []).join(', '), dueDate: item.dueDate || '', dueTime: item.dueTime ? String(item.dueTime).slice(0, 5) : '',
        assigneeId: item.assigneeId || '', isPublic: item.isPublic !== false,
        attachments: normaliseAttachments(item.attachments)
      }
    }, () => this.syncEditorContents())
  },

  openLongPress(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.todos.find(todo => Number(todo.id) === id)
    if (!item) return
    this.setData({ selectedTodo: item, showActions: true })
  },

  closeActions() { this.setData({ showActions: false }) },

  actionEdit() { this.closeActions(); this.editSelected() },

  actionDelete() {
    const item = this.data.selectedTodo
    this.closeActions()
    if (!item) return
    this.confirmDelete(item)
  },

  moveSelected(event) {
    const direction = Number(event.currentTarget.dataset.direction || 0)
    const item = this.data.selectedTodo
    const index = this.data.todos.findIndex(todo => Number(todo.id) === Number(item && item.id))
    const target = index + direction
    if (index < 0 || target < 0 || target >= this.data.todos.length) {
      return wx.showToast({ title: direction < 0 ? '已经在最前面' : '已经在最后面', icon: 'none' })
    }
    const todos = this.data.todos.slice()
    const moved = todos.splice(index, 1)[0]
    todos.splice(target, 0, moved)
    this.setData({ todos, showActions: false })
    request('/todos/reorder', { method: 'POST', data: { ids: todos.map(todo => todo.id) } }).catch(() => {
      wx.showToast({ title: '顺序保存失败', icon: 'none' })
      this.loadTodos(true)
    })
  },

  confirmDelete(item) {
    wx.showModal({ title: '删除这条待办？', content: '删除后会从清单隐藏，但操作记录仍会保留。', confirmText: '删除', confirmColor: '#c27480', success: result => {
      if (!result.confirm || this.data.deleting) return
      this.setData({ deleting: true })
      request(`/todos/${item.id}`, { method: 'DELETE' }).then(() => {
        this.setData({ deleting: false, showDetail: false })
        wx.showToast({ title: '已删除', icon: 'success' })
        this.loadTodos(true)
      }).catch(error => {
        this.setData({ deleting: false })
        wx.showToast({ title: messageOf(error, '删除失败'), icon: 'none' })
      })
    } })
  },

  toggleComplete(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.todos.find(todo => Number(todo.id) === id)
    if (!item || !this.data.canEdit) return wx.showToast({ title: '当前身份只能查看', icon: 'none' })
    request(`/todos/${id}/complete`, { method: 'POST', data: { completed: !item.isCompleted } }).then(() => {
      this.loadTodos(true)
      wx.showToast({ title: item.isCompleted ? '已恢复' : '完成啦', icon: 'success' })
    }).catch(error => wx.showToast({ title: messageOf(error, '状态更新失败'), icon: 'none' }))
  },

  swipeComplete(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.todos.find(todo => Number(todo.id) === id)
    if (item) this.toggleComplete({ currentTarget: { dataset: { id } } })
  },

  swipeDelete(event) {
    const id = Number(event.currentTarget.dataset.id)
    const item = this.data.todos.find(todo => Number(todo.id) === id)
    if (item) this.confirmDelete(item)
  },

  openEditorFromDetail() { this.editSelected() },

  closeEditor() { if (!this.data.saving && !this.data.uploading) this.setData({ showEditor: false }) },

  onTitleInput(event) { this.setData({ 'editor.title': String(fieldValue(event) || '') }) },
  onEditorReady() {
    wx.createSelectorQuery().select('#todo-editor').context(result => {
      this.editorCtx = result && result.context
      this.syncEditorContents()
    }).exec()
  },
  syncEditorContents() {
    if (this.editorCtx && this.data.editor) this.editorCtx.setContents({ html: renderMarkdown(this.data.editor.markdown || '') })
  },
  onEditorInput(event) {
    const html = event.detail && event.detail.html ? event.detail.html : ''
    const markdown = htmlToMarkdown(html)
    this.setData({ 'editor.markdown': markdown, editorHtml: renderMarkdown(markdown) })
  },
  formatEditor(event) {
    const format = event.currentTarget.dataset.format
    const context = this.editorCtx
    if (!context) return wx.showToast({ title: '编辑器还在准备，请稍候', icon: 'none' })
    if (format === 'link') {
      return wx.showModal({ title: '添加链接', editable: true, placeholderText: 'https://', content: 'https://', confirmText: '插入', success: result => {
        if (result.confirm && result.content) context.format('link', result.content.trim())
      } })
    }
    if (format === 'clear') return context.removeFormat()
    const commands = {
      bold: ['bold', true], italic: ['italic', true], strike: ['strike', true],
      heading: ['header', 2], bullet: ['list', 'bullet'], checkbox: ['list', 'unchecked'], quote: ['blockquote', true]
    }
    const command = commands[format]
    if (command) context.format(command[0], command[1])
  },
  uploadTodoImages(event) {
    if (this.data.uploading || this.data.saving) return
    const files = Array.isArray(event.detail && event.detail.file) ? event.detail.file : [event.detail && event.detail.file]
    const remaining = 9 - this.data.editor.attachments.length
    if (remaining <= 0) return wx.showToast({ title: '最多添加9张图片', icon: 'none' })
    this.setData({ uploading: true })
    const selected = files.filter(Boolean).slice(0, remaining)
    ;(async () => {
      try {
        for (const file of selected) {
          const sourcePath = file.url || file.path || file.tempFilePath
          if (!sourcePath) continue
          if (file.size && file.size > 10 * 1024 * 1024) throw new Error('图片大小不能超过10MB')
          const result = await upload('/uploads/images', sourcePath)
          if (!result || !result.url) throw new Error('图片上传失败')
          const attachment = { url: result.url, name: file.name || '', type: 'image', size: file.size || 0 }
          this.setData({ 'editor.attachments': this.data.editor.attachments.concat(attachment).slice(0, 9) })
        }
        if (selected.length) wx.showToast({ title: '图片已添加', icon: 'success' })
      } catch (error) {
        wx.showToast({ title: messageOf(error, '图片上传失败'), icon: 'none' })
      } finally {
        this.setData({ uploading: false })
      }
    })()
  },
  removeTodoImage(event) {
    if (this.data.uploading || this.data.saving) return
    const index = Number(event.detail && event.detail.index)
    if (!Number.isInteger(index) || index < 0) return
    this.setData({ 'editor.attachments': this.data.editor.attachments.filter((item, itemIndex) => itemIndex !== index) })
  },
  previewTodoImage(event) {
    const attachments = normaliseAttachments(this.data.selectedTodo && this.data.selectedTodo.attachments)
    const urls = attachments.map(item => item.url)
    const index = Number(event.currentTarget.dataset.index || 0)
    if (urls.length) wx.previewImage({ urls, current: urls[index] || urls[0] })
  },

  onShareAppMessage(options = {}) {
    const targetId = Number(options.target && options.target.dataset && options.target.dataset.todoId || 0)
    const item = (targetId && this.data.todos.find(todo => Number(todo.id) === targetId)) || this.data.selectedTodo
    if (!item || !item.id) return { title: '我们的共同待办', path: '/pages/todos/todos' }
    const title = item.title || '一件共同待办'
    const summary = item.summary || summaryOf(item.markdown || item.detail)
    const firstImage = normaliseAttachments(item.attachments)[0]
    const payload = {
      title: summary ? `${title}｜${summary.slice(0, 24)}` : title,
      path: `/pages/todos/todos?todoId=${item.id}`
    }
    if (firstImage && firstImage.url) payload.imageUrl = firstImage.url
    return payload
  },
  onTagsInput(event) { this.setData({ 'editor.tagsText': String(fieldValue(event) || '') }) },
  onDateChange(event) { this.setData({ 'editor.dueDate': event.detail.value }) },
  onTimeChange(event) { this.setData({ 'editor.dueTime': event.detail.value }) },
  onPublicChange(event) { this.setData({ 'editor.isPublic': !!event.detail.value }) },
  setPriority(event) { this.setData({ 'editor.priority': event.currentTarget.dataset.value }) },
  setAssignee(event) { this.setData({ 'editor.assigneeId': event.currentTarget.dataset.id || '' }) },

  togglePreview() { this.setData({ editorPreview: !this.data.editorPreview, editorHtml: renderMarkdown(this.data.editor.markdown) }) },

  saveTodo() {
    const editor = this.data.editor
    if (this.data.saving) return
    if (this.data.uploading) return wx.showToast({ title: '图片还在上传，请稍候', icon: 'none' })
    if (!String(editor.title || '').trim()) return wx.showToast({ title: '请填写待办标题', icon: 'none' })
    const tags = String(editor.tagsText || '').split(/[,，]/).map(value => value.trim()).filter(Boolean)
    const payload = {
      title: editor.title.trim(), markdown: editor.markdown || '', priority: editor.priority,
      tags, dueDate: editor.dueDate || null, dueTime: editor.dueTime || null,
      assigneeId: editor.assigneeId || null, isPublic: !!editor.isPublic,
      attachments: normaliseAttachments(editor.attachments)
    }
    this.setData({ saving: true })
    const path = this.data.editingId ? `/todos/${this.data.editingId}` : '/todos'
    request(path, { method: this.data.editingId ? 'PATCH' : 'POST', data: payload }).then(() => {
      this.setData({ saving: false, showEditor: false })
      wx.showToast({ title: this.data.editingId ? '已保存' : '待办已创建', icon: 'success' })
      this.loadTodos(true)
    }).catch(error => {
      this.setData({ saving: false })
      wx.showToast({ title: messageOf(error, '保存失败'), icon: 'none' })
    })
  },

})
