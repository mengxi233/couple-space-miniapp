const api=require('../../services/lightboard-room')
const {fonts,board}=require('../../services/little-apps')
const {FONT_URL}=require('../../services/lightboard-renderer')
Page({
 data:{room:null,roomCode:'',form:board(),fonts,modes:['同步播放','拼接延长'],directions:['向左滚动','向右滚动'],modeIndex:0,busy:false,error:''},
 onLoad(options){this.pendingRoom=options.room||'';try{const form=board(wx.getStorageSync('mengyu_lightboard')||{});form.direction=Math.min(1,form.direction);this.setData({form,roomCode:this.pendingRoom})}catch(_){}},
 onShow(){this.visible=true;if(this.data.room)this.poll();else if(this.pendingRoom){this.joinRoom()}},
 onHide(){this.visible=false;clearTimeout(this.timer)},onUnload(){this.closed=true;this.visible=false;clearTimeout(this.timer);if(this.cancelSprite)this.cancelSprite()},
 setRoom(result,edit=false){const r=result.room;if(this.closed)return;if(this.data.room&&r.id===this.data.room.id&&r.seq<this.data.room.seq)return;this.setData({room:r,uid:result.uid||this.data.uid,isOwner:r.owner===(result.uid||this.data.uid),...(edit?{form:r.config,modeIndex:r.mode==='sync'?0:1}:{})})},
 async poll(){clearTimeout(this.timer);if(!this.visible||!this.data.room)return;const id=this.data.room.id;try{const result=await api.action(id,'poll',{stage:false});if(this.visible&&!this.closed&&this.data.room&&this.data.room.id===id)this.setRoom(result)}catch(e){if(!this.closed)this.setData({error:e.message});if(e.statusCode===404)return}if(this.visible&&this.data.room)this.timer=setTimeout(()=>this.poll(),2000)},
 async run(fn){if(this.data.busy)return;this.setData({busy:true,error:''});try{await fn()}catch(e){if(!this.closed)this.setData({error:e.message})}finally{if(!this.closed)this.setData({busy:false})}},
 createRoom(){this.run(async()=>{const result=await api.create(this.data.modeIndex?'extend':'sync',this.data.form);this.setData({roomCode:result.room.id});const joined=await api.action(result.room.id,'join',{name:this.name()});this.setRoom(joined,true);await this.generate();this.poll()})},
 joinRoom(){this.run(async()=>{const id=this.data.roomCode.trim();if(!/^[A-Za-z0-9_-]{24}$/.test(id))throw new Error('房间码应为24位，请复制完整房间码');const joined=await api.action(id,'join',{name:this.name()});this.pendingRoom='';this.setRoom(joined,true);this.poll()})},
 name(){const u=getApp().globalData.user||{};return u.nickname||'参与者'},
 codeInput(e){this.setData({roomCode:e.detail.value})},textChange(e){this.setData({'form.text':e.detail.value})},modeChange(e){this.setData({modeIndex:Number(e.detail.value)})},
 change(e){this.setData({['form.'+e.currentTarget.dataset.key]:Number(e.detail.value)})},colorChange(e){this.setData({['form.'+e.currentTarget.dataset.key]:e.detail.value})},
 applyConfig(){this.run(async()=>{const result=await api.action(this.data.room.id,'config',{version:this.data.room.version,mode:this.data.modeIndex?'extend':'sync',config:this.data.form});this.setRoom(result);await this.generate()})},
 waitSprite(register,timeout,message){return new Promise((resolve,reject)=>{
  let done=false
  const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);this.cancelSprite=null;if(error)reject(error);else resolve(value)}
  const timer=setTimeout(()=>finish(new Error(message)),timeout)
  this.cancelSprite=()=>finish(new Error('页面已退出'))
  try{register(value=>finish(null,value),()=>finish(new Error(message)))}catch(error){finish(error)}
 })},
 async generate(){
  if(this.closed)return
  const room=this.data.room,f=room.config
  if(f.font===4)await this.waitSprite((success,fail)=>wx.loadFontFace({family:'FusionPixel',source:`url("${FONT_URL}")`,scopes:['native','webview'],success,fail}),20000,'像素字体加载失败或超时，请重试')
  if(this.closed)return
  const canvas=await this.waitSprite((resolve,reject)=>this.createSelectorQuery().select('#roomSprite').fields({node:true,size:true}).exec(rows=>{if(rows&&rows[0]&&rows[0].node)resolve(rows[0].node);else reject()}),5000,'文字画布未就绪，请重试')
  const ctx=canvas.getContext('2d'),font=fonts[f.font];canvas.width=4096;canvas.height=96;ctx.font=`${font.weight} 48px ${font.family}`
  const width=Math.ceil(ctx.measureText(f.text).width)+16;if(width>4096)throw new Error('文字过宽，请减少字数')
  canvas.width=width;ctx.font=`${font.weight} 48px ${font.family}`;ctx.clearRect(0,0,width,96);ctx.fillStyle=f.fg;ctx.textBaseline='middle';ctx.fillText(f.text,8,48)
  const output=await new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas,fileType:'png',destWidth:width,destHeight:96,success:resolve,fail:()=>reject(new Error('生成文字图片失败'))}))
  try{if(!this.closed){const result=await api.uploadSprite(room,output.tempFilePath);if(!this.closed)this.setRoom(result)}}finally{
   canvas.width=1;canvas.height=1
   if(wx.getFileSystemManager)wx.getFileSystemManager().unlink({filePath:output.tempFilePath,fail:()=>{}})
  }
 },
 moveUp(e){this.run(async()=>{const order=this.data.room.members.map(m=>m.uid),i=Number(e.currentTarget.dataset.index);[order[i-1],order[i]]=[order[i],order[i-1]];this.setRoom(await api.action(this.data.room.id,'order',{version:this.data.room.version,order}))})},
 enterStage(){wx.navigateTo({url:'/pages/lightboard-stage/lightboard-stage?room='+this.data.room.id})},
 removeMember(e){const raw=e.currentTarget.dataset.uid,uid=String(raw).startsWith('guest:')?raw:Number(raw);wx.showModal({title:'移除该屏幕？',content:'成员顺序改变后，所有人需要重新准备。请先暂停播放。',confirmColor:'#c97982',success:r=>{if(r.confirm)this.run(async()=>this.setRoom(await api.action(this.data.room.id,'remove',{version:this.data.room.version,uid})))}})},
 leave(){wx.showModal({title:this.data.isOwner?'关闭房间？':'退出房间？',content:'播放中请先在横屏界面暂停。',confirmColor:'#c97982',success:r=>{if(r.confirm)this.run(async()=>{await api.action(this.data.room.id,this.data.isOwner?'close':'leave');clearTimeout(this.timer);this.setData({room:null})})}})},
 onShareAppMessage(){return {title:'一起拼出更长的灯牌',path:'/pages/lightboard-room/lightboard-room?room='+(this.data.room?this.data.room.id:'')}}
})
