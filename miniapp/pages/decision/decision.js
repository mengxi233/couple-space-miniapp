const { options, pick } = require('../../services/little-apps')
const { makeShare, readShare } = require('../../services/decision-share')
const { identity, showCoupleAccessGuide } = require('../../services/app-access')
const presets = [{ name: '吃什么', text: '家常菜\n火锅\n面条\n饺子\n轻食\n烧烤' }, { name: '约会安排', text: '看电影\n散步\n一起做饭\n逛公园\n桌游\n喝咖啡' }, { name: '要不要', text: '试试看\n再想想' }]
Page({
  data: { authorized: false, presets, draft: presets[0].text, optionCards: [], unique: false, spinning: false, result: '', history: [], dragId: 0, dragOffset: 0, dropIndex: -1, selectedResult: '', shared: false, shareError: '', pageReady: false, renderError: '' },
  onLoad(query = {}) {
    if (!identity().activated) {
      showCoupleAccessGuide({ leaveOnCancel: true })
      return
    }
    this.setData({ authorized: true })
    try { const saved = wx.getStorageSync('mengyu_decision'); if (saved) { options(saved.draft); this.setData({ draft: saved.draft, unique: !!saved.unique, history: Array.isArray(saved.history) ? saved.history.slice(0,10) : [] }) } } catch (_) {}
    if (query.s) {
      try { const snapshot = readShare(query.s); this.setData({ ...snapshot, selectedResult: snapshot.result, shared: true }) }
      catch (_) { wx.showToast({ title: '分享内容无效，请让好友重新分享', icon: 'none' }) }
    }
    this.used = []; this.makeCards(this.data.draft); this.refreshShare()
  },
  refreshShare() {
    try {
      if (this.data.optionCards.some(card => !card.value.trim())) throw new Error('填写或删除空卡片后即可分享')
      this.sharePayload = makeShare(this.data.draft, this.data.selectedResult, this.data.unique)
      this.setData({ shareError: '' })
    } catch (error) { this.sharePayload = null; this.setData({ shareError: error.message }) }
  },
  onShareAppMessage() { return this.sharePayload || { title: '做个决定，一起来转转盘', path: '/pages/decision/decision' } },
  makeCards(text) { this.cardId = this.cardId || 0; this.setData({ optionCards: options(text).map(value => ({ id: ++this.cardId, value })) }) },
  updateCards(cards) {
    this.used = []
    this.setData({ optionCards: cards, draft: cards.map(card => card.value).join('\n'), result: '', selectedResult: '', shared: false }); this.refreshShare()
    try { const list = options(this.data.draft); if (this.ctx) this.draw(list, 0); this.persist() } catch (_) {}
  },
  editOption(e) {
    if (this.data.spinning) return
    const cards = this.data.optionCards.map(card => card.id === Number(e.currentTarget.dataset.id) ? { ...card, value: e.detail.value.replace(/[\r\n]/g, '') } : card)
    this.updateCards(cards)
  },
  addOption() {
    if (this.data.spinning || this.data.optionCards.length >= 20) return
    this.updateCards(this.data.optionCards.concat({ id: ++this.cardId, value: '' }))
  },
  removeOption(e) {
    if (this.data.spinning || this.data.optionCards.length <= 2) return
    this.updateCards(this.data.optionCards.filter(card => card.id !== Number(e.currentTarget.dataset.id)))
  },
  moveOption(e) {
    if (this.data.spinning) return
    const cards = this.data.optionCards.slice(), index = cards.findIndex(card => card.id === Number(e.currentTarget.dataset.id)), target = index + Number(e.currentTarget.dataset.direction)
    if (index < 0 || target < 0 || target >= cards.length) return
    ;[cards[index], cards[target]] = [cards[target], cards[index]]
    this.updateCards(cards)
  },
  dragStart(e) {
    if (this.data.spinning || !e.touches.length) return
    const id = Number(e.currentTarget.dataset.id), y = e.touches[0].clientY
    const session = this.dragSession = { id, y, currentY: y }
    this.createSelectorQuery().selectAll('.option-card').boundingClientRect(rects => {
      if (this.dragSession !== session || !rects.length) return
      session.rects = rects
      this.setData({ dragId: id, dragOffset: session.currentY - y, dropIndex: this.data.optionCards.findIndex(card => card.id === id) })
    }).exec()
  },
  dragMove(e) {
    const session = this.dragSession
    if (!session || !e.touches.length) return
    session.currentY = e.touches[0].clientY
    if (!session.rects) return
    // Dropping at a row's center selects that row's slot, including the last slot.
    const target = session.rects.reduce((best,rect,index) => Math.abs(session.currentY - rect.top - rect.height/2) < Math.abs(session.currentY - session.rects[best].top - session.rects[best].height/2) ? index : best, 0)
    this.setData({ dragOffset: session.currentY - session.y, dropIndex: target })
  },
  dragEnd() {
    const session = this.dragSession, target = this.data.dropIndex
    this.cancelDrag()
    if (!session || !session.rects || target < 0) return
    const cards = this.data.optionCards.slice(), from = cards.findIndex(card => card.id === session.id)
    if (from < 0 || from === target) return
    const moved = cards.splice(from,1)[0]; cards.splice(target,0,moved); this.updateCards(cards)
  },
  cancelDrag() { this.dragSession = null; this.setData({ dragId: 0, dragOffset: 0, dropIndex: -1 }) },
  onReady() {
    if (!this.data.authorized) return
    // Keep the canvas measurable, but reveal it together with the page after first paint.
    wx.nextTick(() => {
      if (this.closed) return
      this.createSelectorQuery().select('#wheel').fields({node:true,size:true}).exec(rows => {
        if (this.closed) return
        try {
          if (!rows[0] || !rows[0].node || !rows[0].width) throw new Error('转盘加载失败，请返回后重试')
          this.canvas = rows[0].node; this.width = rows[0].width
          this.canvas.width = this.canvas.height = this.width * 2
          this.ctx = this.canvas.getContext('2d'); this.ctx.scale(2,2)
          const list = options(this.data.draft), winner = list.indexOf(this.data.selectedResult)
          this.draw(list,winner < 0 ? 0 : -(winner+.5)*2*Math.PI/list.length)
          this.revealFrame = this.canvas.requestAnimationFrame(() => {
            if (!this.closed) this.setData({ pageReady: true })
          })
        } catch (_) { this.setData({ pageReady: true, renderError: '转盘加载失败，请返回后重试' }) }
      })
    })
  },
  onHide() { this.cancelDrag(); this.cancelSpin() }, onUnload() { this.closed = true; if(this.revealFrame && this.canvas)this.canvas.cancelAnimationFrame(this.revealFrame); this.cancelDrag(); this.cancelSpin() },
  cancelSpin() { if (this.frame && this.canvas) this.canvas.cancelAnimationFrame(this.frame); if (this.data.spinning) this.setData({spinning:false,result:'已暂停，请重新转动'}) },
  back() { wx.navigateBack() }, input(e) { this.setData({draft:e.detail.value}); this.used=[] },
  unique(e) { this.setData({unique:e.detail.value}); this.used=[]; this.persist(); this.refreshShare() },
  preset(e) { if(this.data.spinning)return; this.setData({draft:presets[e.currentTarget.dataset.index].text,result:'',selectedResult:'',shared:false}); this.makeCards(this.data.draft); this.refreshShare(); this.used=[]; if(this.ctx)this.draw(options(this.data.draft),0); this.persist() },
  reset() { if(this.data.spinning)return; this.used=[]; this.setData({result:'新的一轮开始啦',selectedResult:'',shared:false}); this.refreshShare() },
  clear() { this.setData({history:[]}); this.persist() },
  persist() { try { wx.setStorageSync('mengyu_decision',{draft:this.data.draft,unique:this.data.unique,history:this.data.history}) } catch (_) { wx.showToast({title:'本机存储已满，本次未保存',icon:'none'}) } },
  draw(list, angle) {
    const c=this.ctx,w=this.width,r=w/2-10,step=2*Math.PI/list.length
    c.clearRect(0,0,w,w); c.save(); c.translate(w/2,w/2); c.rotate(angle)
    list.forEach((label,i)=>{ c.beginPath();c.moveTo(0,0);c.arc(0,0,r,i*step-Math.PI/2,(i+1)*step-Math.PI/2);c.closePath();c.fillStyle=['#f3c9cf','#f8dfcb','#e0d9ed','#d9e9e2'][i%4];c.fill();c.strokeStyle='#fff';c.stroke();c.save();c.rotate((i+.5)*step-Math.PI/2);c.textAlign='right';c.fillStyle='#60434c';c.font='12px sans-serif';c.fillText(Array.from(label).slice(0,8).join('')+(Array.from(label).length>8?'…':''),r-12,4);c.restore() });
    c.beginPath();c.arc(0,0,18,0,Math.PI*2);c.fillStyle='#c97982';c.fill();c.restore()
    // Draw last, outside the wheel rotation: the top pointer always covers the disk.
    c.save();c.beginPath();c.moveTo(w/2-12,1);c.lineTo(w/2+12,1);c.lineTo(w/2,28);c.closePath();c.fillStyle='#904b58';c.fill();c.strokeStyle='#fff7f8';c.lineWidth=2;c.stroke();c.restore()
  },
  spin() {
    if(this.data.spinning)return
    if(!this.ctx)return wx.showToast({title:'转盘尚未就绪，请稍后重试',icon:'none'})
    if(this.data.optionCards.some(card=>!card.value.trim()))return wx.showToast({title:'请填写所有选项，或删除空卡片',icon:'none'})
    let list; try { list=options(this.data.draft) } catch(error){ return wx.showToast({title:error.message,icon:'none'}) }
    if(this.data.unique) list=list.filter(x=>!this.used.includes(x))
    if(!list.length)return wx.showModal({title:'本轮已全部抽完',content:'点击“重新开始一轮”后即可继续。',showCancel:false,confirmColor:'#c97982'})
    const index=pick(list.length), target=10*Math.PI+2*Math.PI-(index+.5)*2*Math.PI/list.length, start=Date.now()
    this.setData({spinning:true,result:'',selectedResult:'',shared:false});this.refreshShare();this.persist()
    const tick=()=>{ const t=Math.min(1,(Date.now()-start)/2800);this.draw(list,target*(1-Math.pow(1-t,4)));if(t<1){this.frame=this.canvas.requestAnimationFrame(tick);return} const result=list[index];this.used.push(result);const now=new Date();this.setData({spinning:false,result,selectedResult:result,history:[{id:Date.now(),result,time:now.toLocaleString()}].concat(this.data.history).slice(0,10)});this.refreshShare();this.persist() }
    this.frame=this.canvas.requestAnimationFrame(tick)
  }
})
