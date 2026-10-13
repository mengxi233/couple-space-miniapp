const api=require('../../services/lightboard-room')
function bytes(value){const n=Number(value)||0;return n>=1048576?(n/1048576).toFixed(2)+' MB':n>=1024?(n/1024).toFixed(1)+' KB':n+' B'}
function date(value){const d=new Date(value),pad=v=>String(v).padStart(2,'0');return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`}
Page({
 data:{rooms:[],stats:null,page:1,pages:1,loading:false,closing:false,error:''},
 onShow(){this.visible=true;this.refresh()},
 onHide(){this.visible=false;this.generation=(this.generation||0)+1;clearTimeout(this.timer);this.setData({loading:false})},
 onUnload(){this.closed=true;this.visible=false;this.generation=(this.generation||0)+1;clearTimeout(this.timer)},
 onPullDownRefresh(){this.refresh().finally(()=>wx.stopPullDownRefresh())},
 async refresh(){
  if(this.closed||!this.visible||this.data.loading)return
  clearTimeout(this.timer);const gen=this.generation=(this.generation||0)+1;this.setData({loading:true,error:''})
  try{
   const data=await api.adminList(this.data.page)
   if(this.closed||!this.visible||gen!==this.generation)return
   const pages=Math.max(1,Math.ceil(data.total/data.pageSize))
   if(this.data.page>pages){this.setData({page:pages,loading:false});return this.refresh()}
   const stats={...data.stats};for(const key of ['sprite','state','database','reusable','journal'])stats[key+'Size']=bytes(stats[key+'Bytes'])
   const rooms=data.rooms.map(r=>({...r,spriteSize:bytes(r.spriteBytes),stateSize:bytes(r.stateBytes),createdText:date(r.createdAt),activeText:date(r.lastActive),reclaimText:date(r.reclaimAt),memberNames:r.members.map(m=>m.name).join('、')}))
   this.setData({stats,rooms,pages})
  }catch(e){if(!this.closed&&gen===this.generation)this.setData({error:e.message,...([401,403].includes(e.statusCode)?{rooms:[],stats:null}:{})});if([401,403].includes(e.statusCode))return}
  finally{if(!this.closed&&gen===this.generation)this.setData({loading:false})}
  if(this.visible&&gen===this.generation)this.timer=setTimeout(()=>this.refresh(),10000)
 },
 previous(){if(this.data.page>1){this.setData({page:this.data.page-1});this.refresh()}},
 next(){if(this.data.page<this.data.pages){this.setData({page:this.data.page+1});this.refresh()}},
 copyCode(e){wx.setClipboardData({data:e.currentTarget.dataset.id})},
 observe(e){wx.navigateTo({url:'/pages/lightboard-stage/lightboard-stage?admin=1&room='+encodeURIComponent(e.currentTarget.dataset.id)})},
 join(e){wx.navigateTo({url:'/pages/lightboard-room/lightboard-room?room='+encodeURIComponent(e.currentTarget.dataset.id)})},
 closeRoom(e){const id=e.currentTarget.dataset.id;if(this.data.closing)return;wx.showModal({title:'关闭这个房间？',content:'所有参与者将无法继续访问，房间及文字图片会被删除，此操作不可恢复。房间号：'+id,confirmText:'关闭房间',confirmColor:'#b85c70',success:async result=>{if(!result.confirm||this.closed)return;this.setData({closing:true});try{await api.adminClose(id);if(!this.closed){wx.showToast({title:'房间已关闭',icon:'success'});this.generation=(this.generation||0)+1;clearTimeout(this.timer);this.setData({loading:false,rooms:this.data.rooms.filter(r=>r.id!==id)});await this.refresh()}}catch(e){if(!this.closed)this.setData({error:e.message})}finally{if(!this.closed)this.setData({closing:false})}}})}
})
