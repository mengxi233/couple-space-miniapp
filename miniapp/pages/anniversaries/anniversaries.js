const { request } = require('../../services/api')
const { elapsed, remaining } = require('../../services/anniversary-time')
const fresh = () => ({ title: '', eventKind: 'anniversary', calendarType: 'solar', startYear: null, month: 1, day: 1,
  leapMonth: false, enabled: true, reminderTime: '10:00', reminderDays: [7,3,1,0] })
const statusNames = { pending: '等待发送 / 重试', sending: '发送中', sent: '已交给邮件服务器',
  disabled: '邮件未开启', cancelled: '已取消', expired: '已过提醒时效', failed: '发送失败' }
Page({
  data: { items: [], loading: false, saving: false, canEdit: false, error: '', editing: false,
    form: fresh(), years: '', months: Array.from({length:12},(_,i)=>i+1),
    days: Array.from({length:31},(_,i)=>i+1), kindIndex: 0, calendarNames: ['公历','农历'],
    mail: {email:'', emailEnabled:false, smtpConfigured:false, deliveries:[]},
    settingsLoaded: false, savingMail: false, subscribing:false, wechatStatus:'', clocks: {}, eventKindNames:['纪念日','生日'],eventKindIndex:0,selectedDays: {'7':true,'3':true,'1':true,'0':true} },
  onShow() { this.closed=false; this.visible=true; this.load() },
  onHide() { this.visible=false; this.stopClock() },
  onUnload() { this.closed=true; this.visible=false; this.stopClock(); this.generation=(this.generation||0)+1 },
  stopClock() { if(this.clockTimer)clearInterval(this.clockTimer);this.clockTimer=null },
  startClock() {
    this.stopClock()
    if(!this.visible||this.closed||this.data.editing||!this.data.items.length)return
    const beijingDay=stamp=>Math.floor((stamp+8*3600000)/86400000)
    const initialDay=beijingDay(Date.now())
    const update=()=>{
      const stamp=Date.now(),clocks={}
      if(beijingDay(stamp)!==initialDay){this.load();return}
      this.data.items.forEach(item=>{clocks[item.id]={
        ...(item.eventKind!=='birthday'?elapsed(item,stamp):{}),remaining:remaining(item,stamp)
      }})
      this.setData({clocks})
    }
    update();this.clockTimer=setInterval(update,100)
  },
  async load() {
    this.stopClock()
    const generation=this.generation=(this.generation||0)+1
    this.setData({loading:true,error:'',canEdit:false})
    try {
      const [data,mail]=await Promise.all([request('/anniversaries'),request('/anniversaries/settings')])
      if(this.closed||generation!==this.generation)return
      mail.deliveries=(mail.deliveries||[]).map(item=>({...item,statusLabel:statusNames[item.status]||item.status}))
      const wxStatuses={sent:'最近一条已交给微信发送',no_subscription:'订阅次数不足或已取消，请重新订阅',
        pending:'提醒等待发送',sending:'正在发送',unknown:'发送结果未确认，为避免重复不自动重发',
        failed:'最近一次发送失败',cancelled:'最近一条提醒已取消',expired:'最近一条提醒已过期'}
      this.setData({items:data.items,canEdit:!!data.canEdit,mail,settingsLoaded:true,
        wechatStatus:wxStatuses[mail.wechat&&mail.wechat.lastStatus]||''})
      this.startClock()
    } catch(error) {
      if(!this.closed&&generation===this.generation)this.setData({error:error.message,items:[],settingsLoaded:false})
    } finally { if(!this.closed&&generation===this.generation)this.setData({loading:false}) }
  },
  back() {
    if (this.data.saving || this.data.savingMail || this.data.subscribing) return
    if (this.data.editing) {
      this.setData({ editing: false })
      this.startClock()
      return
    }
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/apps/apps' })
    })
  },
  login() { wx.navigateTo({url:'/pages/login/login'}) },
  notifications() { wx.navigateTo({url:'/pages/notifications/notifications'}) },
  add() { if(this.data.canEdit)this.open(fresh()) },
  edit(e) { const item=this.data.items.find(i=>i.id===Number(e.currentTarget.dataset.id)); if(item&&this.data.canEdit)this.open({...item}) },
  open(form) {
    this.stopClock()
    const selectedDays={}
    form.reminderDays.forEach(day=>{selectedDays[day]=true})
    this.setData({form,selectedDays,years:form.startYear?String(form.startYear):'',editing:true,eventKindIndex:form.eventKind==='birthday'?1:0,
      kindIndex:form.calendarType==='lunar'?1:0,days:Array.from({length:form.calendarType==='lunar'?30:31},(_,i)=>i+1)})
  },
  cancel() { if(!this.data.saving){this.setData({editing:false});this.startClock()} },
  title(e) { this.setData({'form.title':e.detail.value}) },
  eventKind(e) { const value=Number(e.detail.value);this.setData({eventKindIndex:value,'form.eventKind':value?'birthday':'anniversary'}) },
  year(e) { this.setData({years:e.detail.value}) },
  kind(e) {
    const lunar=Number(e.detail.value)===1
    this.setData({kindIndex:lunar?1:0,'form.calendarType':lunar?'lunar':'solar',
      'form.leapMonth':false,'form.day':Math.min(this.data.form.day,lunar?30:31),
      days:Array.from({length:lunar?30:31},(_,i)=>i+1)})
  },
  month(e) { this.setData({'form.month':Number(e.detail.value)+1}) },
  day(e) { this.setData({'form.day':Number(e.detail.value)+1}) },
  time(e) { this.setData({'form.reminderTime':e.detail.value}) },
  leap(e) { this.setData({'form.leapMonth':e.detail.value}) },
  enabled(e) { this.setData({'form.enabled':e.detail.value}) },
  reminderDays(e) {
    const days=e.detail.value.map(Number),selectedDays={}
    days.forEach(day=>{selectedDays[day]=true})
    this.setData({'form.reminderDays':days,selectedDays})
  },
  async save() {
    if(this.data.saving||!this.data.canEdit)return
    const year=this.data.years.trim(),form={...this.data.form,startYear:year?Number(year):null}
    if(!form.title.trim())return wx.showToast({title:'请填写纪念日名称',icon:'none'})
    if(year&&(!/^\d{4}$/.test(year)||Number(year)<1901||Number(year)>2099))return wx.showToast({title:'年份需在1901～2099之间',icon:'none'})
    if(!form.reminderDays.length)return wx.showToast({title:'请至少选择一个提醒时间点',icon:'none'})
    this.setData({saving:true})
    try {
      await request(form.id?'/anniversaries/'+form.id:'/anniversaries',{method:form.id?'PUT':'POST',data:form})
      if(!this.closed){this.setData({editing:false});await this.load();wx.showToast({title:'已保存',icon:'success'})}
    } catch(error) { if(!this.closed)wx.showToast({title:error.message,icon:'none'}) }
    finally { if(!this.closed)this.setData({saving:false}) }
  },
  remove() {
    if(this.data.saving||!this.data.form.id)return
    wx.showModal({title:'删除这个纪念日？',content:'后续提醒将停止，已经发出的邮件无法撤回。',confirmColor:'#c97982',success:async result=>{
      if(!result.confirm||this.closed)return
      this.setData({saving:true})
      try {
        await request('/anniversaries/'+this.data.form.id,{method:'DELETE',data:{version:this.data.form.version}})
        if(!this.closed){this.setData({editing:false});await this.load()}
      } catch(error) { if(!this.closed)wx.showToast({title:error.message,icon:'none'}) }
      finally { if(!this.closed)this.setData({saving:false}) }
    }})
  },
  email(e) { this.setData({'mail.email':e.detail.value}) },
  subscribeWechat() {
    const config=this.data.mail.wechat
    if(this.data.subscribing||!config||!config.configured)return
    if(typeof wx.requestSubscribeMessage!=='function')return wx.showToast({title:'当前微信版本不支持订阅，请升级微信',icon:'none'})
    this.setData({subscribing:true})
    // Invoke directly from the user's tap, before any asynchronous request.
    wx.requestSubscribeMessage({tmplIds:[config.templateId],success:async result=>{
      if(this.closed)return
      if(result[config.templateId]!=='accept'){
        this.setData({subscribing:false})
        wx.showToast({title:'未开启订阅，邮件提醒不受影响',icon:'none'});return
      }
      try {
        const versions={develop:'developer',trial:'trial',release:'formal'}
        const version=wx.getAccountInfoSync().miniProgram.envVersion
        const receiptId=Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2)
        const data={enabled:true,templateId:config.templateId,result:'accept',receiptId,state:versions[version]||'formal'}
        // Same receipt makes a transport retry idempotent.
        try {await request('/anniversaries/wechat-subscription',{method:'POST',data})}
        catch(error){if(error.statusCode)throw error;await request('/anniversaries/wechat-subscription',{method:'POST',data})}
        if(!this.closed){await this.load();wx.showToast({title:'已记录本次订阅',icon:'success'})}
      } catch(error){if(!this.closed)wx.showToast({title:'微信已同意，但订阅登记失败，请重试',icon:'none'})}
      finally {if(!this.closed)this.setData({subscribing:false})}
    },fail:()=>{if(!this.closed){this.setData({subscribing:false});wx.showToast({title:'订阅未完成，请检查微信订阅设置',icon:'none'})}}})
  },
  async disableWechat() {
    if(this.data.subscribing)return
    this.setData({subscribing:true})
    try {await request('/anniversaries/wechat-subscription',{method:'POST',data:{enabled:false}});if(!this.closed)await this.load()}
    catch(error){if(!this.closed)wx.showToast({title:error.message,icon:'none'})}
    finally {if(!this.closed)this.setData({subscribing:false})}
  },
  emailEnabled(e) { this.setData({'mail.emailEnabled':e.detail.value}) },
  async saveMail() {
    if(this.data.savingMail||!this.data.settingsLoaded)return
    this.setData({savingMail:true})
    try {
      await request('/anniversaries/settings',{method:'PUT',data:{email:this.data.mail.email.trim(),emailEnabled:this.data.mail.emailEnabled}})
      if(!this.closed){await this.load();wx.showToast({title:'邮箱设置已保存',icon:'success'})}
    } catch(error) { if(!this.closed)wx.showToast({title:error.message,icon:'none'}) }
    finally { if(!this.closed)this.setData({savingMail:false}) }
  }
})
