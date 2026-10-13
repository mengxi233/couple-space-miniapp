const { request, uploadImages } = require('../../services/question-board')

function files(urls) { return (urls || []).map(url => ({ url: typeof url === 'string' ? url : url.url })).filter(item => item.url) }
function urls(items) { return (items || []).map(item => typeof item === 'string' ? item : item.url).filter(Boolean) }
function valueOf(event) {
  const detail = event && event.detail
  return detail && typeof detail === 'object' && Object.prototype.hasOwnProperty.call(detail, 'value') ? detail.value : detail
}
function timeText(value) {
  if (!value) return ''
  const date = new Date(String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 16).replace('T', ' ')
  const now = new Date(); const diff = now.getTime() - date.getTime()
  if (diff >= 0 && diff < 60000) return '刚刚'
  if (diff >= 0 && diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
  const pad = number => String(number).padStart(2, '0')
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

Page({
  data: {
    id: 0, loading: true, question: null, answer: null, comments: [],
    answerDraft: { body: '', images: [] }, commentDraft: { body: '', images: [] },
    showAnswerEditor: false,
    replyTo: null, savingAnswer: false, savingComment: false, uploadingAnswer: false, uploadingComment: false,
    score: 0, statusLabels: { pending: '等待回答', answered: '已回答', closed: '已结束' }
  },
  onLoad(query) { this.setData({ id: Number(query.id || query.questionId || 0) }) },
  onShow() { if (this.data.id) this.load() },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()) },
  load() {
    this.setData({ loading: true })
    return request(`/questions/${this.data.id}`).then(result => {
      const question = Object.assign({}, result.question, { timeText: timeText(result.question.createdAt) })
      const answer = result.answer ? Object.assign({}, result.answer, { timeText: timeText(result.answer.createdAt) }) : null
      const byId = {}
      ;(result.comments || []).forEach(item => { byId[item.id] = item })
      const comments = (result.comments || []).map(item => Object.assign({}, item, {
        timeText: timeText(item.createdAt), replyName: item.parentId && byId[item.parentId] ? byId[item.parentId].authorName : '',
        avatarLetter: String(item.authorName || '对').slice(0, 1)
      }))
      this.setData({ question, answer, comments, score: answer && answer.rating !== null ? answer.rating : 0,
        showAnswerEditor: Boolean(!answer && question.isRecipient && question.status !== 'closed'),
        answerDraft: answer && answer.isAuthor ? { body: answer.body, images: files(answer.images) } : { body: '', images: [] } })
    }).catch(error => {
      wx.showToast({ title: error.message || '问题加载失败', icon: 'none' })
      if (error.statusCode === 403 || error.statusCode === 404) setTimeout(() => wx.navigateBack(), 900)
    }).finally(() => this.setData({ loading: false }))
  },
  navigateBack() { wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/apps/apps' }) }) },
  preview(event) {
    const source = event.currentTarget.dataset.source
    const index = Number(event.currentTarget.dataset.index || 0)
    let list = []
    if (source === 'question') list = this.data.question.images || []
    if (source === 'answer') list = this.data.answer.images || []
    if (source === 'comment') {
      const comment = this.data.comments.find(item => Number(item.id) === Number(event.currentTarget.dataset.id))
      list = comment ? comment.images : []
    }
    if (list.length) wx.previewImage({ current: list[index], urls: list })
  },
  react(event) {
    const targetType = event.currentTarget.dataset.type
    const targetId = Number(event.currentTarget.dataset.id)
    const desired = Number(event.currentTarget.dataset.value)
    let current = 0
    if (targetType === 'question') current = this.data.question.myReaction
    if (targetType === 'answer') current = this.data.answer.myReaction
    if (targetType === 'comment') current = (this.data.comments.find(item => Number(item.id) === targetId) || {}).myReaction || 0
    request('/question-reactions', { method: 'PUT', data: { targetType, targetId, value: current === desired ? 0 : desired } })
      .then(result => {
        const reaction = result.reaction || {}
        if (targetType === 'question') this.setData({ question: Object.assign({}, this.data.question, reaction) })
        if (targetType === 'answer') this.setData({ answer: Object.assign({}, this.data.answer, reaction) })
        if (targetType === 'comment') this.setData({ comments: this.data.comments.map(item => Number(item.id) === targetId ? Object.assign({}, item, reaction) : item) })
      }).catch(error => wx.showToast({ title: error.message || '操作失败', icon: 'none' }))
  },
  inputAnswer(event) { this.setData({ 'answerDraft.body': valueOf(event) || '' }) },
  openAnswerEditor() {
    if (!this.data.answer || !this.data.answer.isAuthor || this.data.question.status === 'closed') return
    this.setData({ showAnswerEditor: true, answerDraft: { body: this.data.answer.body || '', images: files(this.data.answer.images) } })
  },
  closeAnswerEditor() {
    if (this.data.savingAnswer || this.data.uploadingAnswer) return
    this.setData({ showAnswerEditor: false, answerDraft: this.data.answer ? { body: this.data.answer.body || '', images: files(this.data.answer.images) } : { body: '', images: [] } })
  },
  addAnswerImages(event) { this.uploadDraftImages('answer', event.detail.file) },
  removeAnswerImage(event) { this.setData({ 'answerDraft.images': this.data.answerDraft.images.filter((_, index) => index !== event.detail.index) }) },
  inputComment(event) { this.setData({ 'commentDraft.body': valueOf(event) || '' }) },
  addCommentImages(event) { this.uploadDraftImages('comment', event.detail.file) },
  removeCommentImage(event) { this.setData({ 'commentDraft.images': this.data.commentDraft.images.filter((_, index) => index !== event.detail.index) }) },
  uploadDraftImages(kind, file) {
    const key = kind === 'answer' ? 'uploadingAnswer' : 'uploadingComment'
    if (this.data[key]) return
    const source = Array.isArray(file) ? file : [file]
    this.setData({ [key]: true })
    uploadImages(source).then(uploaded => {
      const path = kind === 'answer' ? 'answerDraft.images' : 'commentDraft.images'
      const current = kind === 'answer' ? this.data.answerDraft.images : this.data.commentDraft.images
      this.setData({ [path]: current.concat(files(uploaded)).slice(0, 9) })
    }).catch(error => wx.showToast({ title: error.message || '图片上传失败', icon: 'none' }))
      .finally(() => this.setData({ [key]: false }))
  },
  saveAnswer() {
    if (this.data.savingAnswer || this.data.uploadingAnswer) return
    const draft = this.data.answerDraft
    if (!draft.body.trim() && !draft.images.length) return wx.showToast({ title: '写点回答或加张图片吧', icon: 'none' })
    this.setData({ savingAnswer: true })
    request(`/questions/${this.data.id}/answer`, { method: 'PUT', data: { body: draft.body.trim(), images: urls(draft.images) } })
      .then(() => { wx.showToast({ title: '回答已保存', icon: 'success' }); return this.load() })
      .catch(error => wx.showToast({ title: error.message || '回答保存失败', icon: 'none' }))
      .finally(() => this.setData({ savingAnswer: false }))
  },
  replyComment(event) {
    const item = this.data.comments.find(comment => Number(comment.id) === Number(event.currentTarget.dataset.id))
    if (item) this.setData({ replyTo: { id: item.id, name: item.authorName } })
  },
  cancelReply() { this.setData({ replyTo: null }) },
  saveComment() {
    if (this.data.savingComment || this.data.uploadingComment) return
    const draft = this.data.commentDraft
    if (!draft.body.trim() && !draft.images.length) return wx.showToast({ title: '写点留言或加张图片吧', icon: 'none' })
    this.setData({ savingComment: true })
    request(`/questions/${this.data.id}/comments`, { method: 'POST', data: { body: draft.body.trim(), images: urls(draft.images), parentId: this.data.replyTo ? this.data.replyTo.id : null } })
      .then(() => { this.setData({ commentDraft: { body: '', images: [] }, replyTo: null }); wx.showToast({ title: '留言已发送', icon: 'success' }); return this.load() })
      .catch(error => wx.showToast({ title: error.message || '留言失败', icon: 'none' }))
      .finally(() => this.setData({ savingComment: false }))
  },
  deleteComment(event) {
    const id = Number(event.currentTarget.dataset.id)
    wx.showModal({ title: '删除留言', content: '确定删除这条留言吗？', success: result => {
      if (!result.confirm) return
      request(`/questions/${this.data.id}/comments/${id}`, { method: 'DELETE' }).then(() => this.load())
        .catch(error => wx.showToast({ title: error.message || '删除失败', icon: 'none' }))
    } })
  },
  changeScore(event) {
    const score = Number(valueOf(event))
    this.setData({ score })
    request(`/questions/${this.data.id}/rating`, { method: 'PUT', data: { score } })
      .then(() => { wx.showToast({ title: `已评分 ${score}/10`, icon: 'success' }); return this.load() })
      .catch(error => { wx.showToast({ title: error.message || '评分失败', icon: 'none' }); this.load() })
  },
  toggleClosed() {
    const status = this.data.question.status === 'closed' ? (this.data.answer ? 'answered' : 'pending') : 'closed'
    const label = status === 'closed' ? '结束问题' : '重新打开'
    wx.showModal({ title: label, content: status === 'closed' ? '结束后将不能继续回答和留言。' : '重新打开后可以继续交流。', success: result => {
      if (!result.confirm) return
      request(`/questions/${this.data.id}`, { method: 'PATCH', data: { status } }).then(() => this.load())
        .catch(error => wx.showToast({ title: error.message || '操作失败', icon: 'none' }))
    } })
  },
  deleteQuestion() {
    wx.showModal({ title: '删除问题', content: '问题、回答和全部留言都会一起删除，且无法恢复。', confirmColor: '#c27480', success: result => {
      if (!result.confirm) return
      request(`/questions/${this.data.id}`, { method: 'DELETE' }).then(() => { wx.showToast({ title: '已删除', icon: 'success' }); setTimeout(() => wx.navigateBack(), 500) })
        .catch(error => wx.showToast({ title: error.message || '删除失败', icon: 'none' }))
    } })
  }
})
