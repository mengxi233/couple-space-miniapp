const api=require('../../services/lightboard-room')
Page({
 data:{room:null,panel:true,busy:false,status:'正在准备多人灯牌…',scale:100,offset:0,gap:0,imageReady:false,clockReady:false,error:'',observing:false,watchIndex:0,screenOptions:[]},
 onLoad(options){this.roomId=options.room;this.adminMode=options.admin==='1';this.setData({observing:this.adminMode})},
 onReady(){this.pageReady=true;this.connect()},
 onShow(){this.visible=true;wx.setKeepScreenOn({keepScreenOn:true,fail:()=>{}});if(this.pageReady)this.connect()},
 onHide(){this.visible=false;this.stop();wx.setKeepScreenOn({keepScreenOn:false})},
 onUnload(){this.closed=true;this.visible=false;this.stop();this.image=null;this.canvas=null;this.ctx=null;wx.setKeepScreenOn({keepScreenOn:false})},
 onResize(e){if(e&&e.size&&e.size.windowWidth===this.data.width&&e.size.windowHeight===this.data.height)return;if(this.visible&&this.pageReady)this.connect()},
 stop(){this.generation=(this.generation||0)+1;clearTimeout(this.pollTimer);clearTimeout(this.layoutTimer);clearTimeout(this.imageTimer);clearTimeout(this.watchdog);if(this.canvas&&this.frame)this.canvas.cancelAnimationFrame(this.frame);this.frame=null},
 retry(){this.connect()},togglePanel(){this.setData({panel:!this.data.panel})},
 async connect(){
  this.stop();const gen=this.generation;this.setData({status:'正在校准时间并连接房间…',error:'',clockReady:false,imageReady:false});this.spriteKey='';this.image=null;this.imageAttempts=0;this.attemptVersion=0
  const active=()=>this.visible&&!this.closed&&gen===this.generation
  this.watchdog=setTimeout(()=>{if(active()){this.stop();this.setData({status:'连接或画布初始化超时，请重新连接',panel:true})}},35000)
  try{
   const clock=await api.synchronize(active);if(!active())return;this.clock=clock;this.setData({clockReady:true,uncertainty:Math.ceil(clock.uncertainty)})
   const started=Date.now()
   const layout=()=>{
    if(!active())return
    if(Date.now()-started>6000){this.setData({status:'画布加载失败，请点重新连接',panel:true});return}
    const info=wx.getWindowInfo();if(info.windowWidth<info.windowHeight){this.layoutTimer=setTimeout(layout,150);return}
    this.setData({width:info.windowWidth,height:info.windowHeight},()=>{
     if(!active())return
     this.createSelectorQuery().select('#joinedBoard').fields({node:true,size:true}).exec(rows=>{
      if(!active())return;const item=rows&&rows[0]
      if(!item||!item.node||!item.width||!item.height){this.layoutTimer=setTimeout(layout,150);return}
      this.canvas=item.node;const dpr=Math.min(info.pixelRatio||1,2);this.canvas.width=Math.round(item.width*dpr);this.canvas.height=Math.round(item.height*dpr);this.ctx=this.canvas.getContext('2d');this.ctx.scale(dpr,dpr)
      clearTimeout(this.watchdog);this.tick(gen);this.poll(gen)
     })
    })
   };layout()
  }catch(e){if(active()){clearTimeout(this.watchdog);this.setData({error:e.message,status:'连接失败，请重新连接',panel:true})}}
 },
 accept(result){
  if(this.closed||!this.visible)return
  const room=result.room
  const watchIndex=Math.min(this.data.watchIndex||0,Math.max(0,room.members.length-1))
  const me=this.adminMode?room.members[watchIndex]:room.members.find(m=>m.uid===result.uid)
  if(this.data.room&&room.seq<this.data.room.seq)return
  if(!me&&!this.adminMode)throw new Error('你已不在房间中，请返回重新加入')
  this.uid=me?me.uid:null
  this.setData({room,isOwner:!this.adminMode&&room.owner===result.uid,selfReady:!!(me&&me.ready),screenIndex:me?room.members.indexOf(me)+1:0,watchIndex,screenOptions:room.members.map((m,i)=>`${i+1} 号 · ${m.name}`)})
  if(me&&(!this.calibrationLoaded||this.adminMode)){this.calibrationLoaded=true;this.setData({scale:me.scale*100,offset:me.offset,gap:me.gap})}
  if(this.attemptVersion!==room.spriteVersion){this.attemptVersion=room.spriteVersion;this.imageAttempts=0}
  if(room.spriteVersion&&this.spriteKey!==room.spriteVersion&&this.imageAttempts<3){
   this.imageAttempts++
   this.spriteKey=room.spriteVersion;this.image=null;this.setData({imageReady:false});clearTimeout(this.imageTimer)
   const key=this.spriteKey,gen=this.generation,image=this.canvas.createImage()
   const fail=()=>{if(gen!==this.generation||key!==this.spriteKey)return;this.spriteKey='';this.setData({error:'文字图片加载失败，请检查网络',imageReady:false,panel:true})}
   this.imageTimer=setTimeout(fail,15000)
   image.onload=()=>{if(gen!==this.generation||key!==this.spriteKey)return;clearTimeout(this.imageTimer);this.image=image;this.setData({imageReady:true,error:''})}
   image.onerror=()=>{clearTimeout(this.imageTimer);fail()};image.src=api.spriteURL(room)
  }
  if(!room.spriteVersion){this.image=null;this.spriteKey='';this.setData({imageReady:false})}
 },
 async poll(gen){
  if(!this.visible||gen!==this.generation)return
  try{
   const result=await (this.adminMode?api.adminRoom(this.roomId):api.action(this.roomId,'poll',{stage:true}));if(!this.visible||gen!==this.generation)return;this.accept(result)
   const remain=Math.ceil((result.room.timeline.at-this.clock.now())/1000)
   const status=!result.room.spriteVersion?'等待房主生成文字图片':remain>0?`${remain} 秒后${result.room.timeline.state==='playing'?'播放':'暂停'}`:result.room.timeline.state==='playing'?'':this.adminMode?'管理员旁观 · 已暂停':'已暂停 · 点击画布设置和准备'
   this.setData({status})
   if(!this.lastSync||Date.now()-this.lastSync>30000){this.lastSync=Date.now();api.synchronize(()=>this.visible&&gen===this.generation).then(clock=>{if(this.visible&&gen===this.generation){this.clock=clock;this.setData({uncertainty:Math.ceil(clock.uncertainty)})}}).catch(()=>{})}
  }catch(e){if(gen!==this.generation)return;this.setData({status:'连接中断：画面按上次指令继续',error:e.message,panel:true});if([401,403,404].includes(e.statusCode)){this.stop();this.image=null;this.ctx.fillStyle='#000000';this.ctx.fillRect(0,0,this.data.width,this.data.height);this.setData({room:null,status:'房间已关闭或无权访问'});return}}
  if(this.visible&&gen===this.generation)this.pollTimer=setTimeout(()=>this.poll(gen),1000)
 },
 tick(gen){
  if(!this.visible||gen!==this.generation)return
  const room=this.data.room,c=this.ctx,w=this.data.width,h=this.data.height
  c.fillStyle=room?room.config.bg:'#000000';c.fillRect(0,0,w,h)
  if(room&&this.image&&this.clock&&this.uid!==null){
   if(this.adminMode&&room.mode==='extend'){
    const member=room.members.find(m=>m.uid===this.uid),vw=member.width,vh=300/member.scale,fit=Math.min(w/vw,h/vh)
    c.save();c.translate((w-vw*fit)/2,(h-vh*fit)/2);c.scale(fit,fit);api.draw(c,this.image,room,this.uid,vw,vh,this.clock.now());c.restore()
   }else api.draw(c,this.image,room,this.uid,w,h,this.clock.now())
  }
  if(room&&!this.adminMode&&room.timeline.state==='paused'&&this.data.panel){const y=h/2+this.data.offset*h/300*this.data.scale/100;c.strokeStyle='#c97982';c.lineWidth=1;c.beginPath();c.moveTo(0,y);c.lineTo(w,y);c.stroke();c.fillStyle='#c97982';c.font='16px sans-serif';c.fillText('屏幕 '+this.data.screenIndex+' · 对齐这条线',w/2,y-12)}
  this.frame=this.canvas.requestAnimationFrame(()=>this.tick(gen))
 },
 async run(fn){if(this.data.busy)return;this.setData({busy:true,error:''});try{await fn()}catch(e){if(!this.closed)this.setData({error:e.message,panel:true})}finally{if(!this.closed)this.setData({busy:false})}},
 async saveCalibration(){
  if(this.adminMode)throw new Error('旁观模式不能修改参与者参数')
  const sync=this.data.room.mode==='sync',scale=sync?1:this.data.scale/100,width=sync?750:this.data.width/(this.data.height/300*scale)
  const result=await api.action(this.roomId,'calibrate',{version:this.data.room.version,width,scale,offset:sync?0:this.data.offset,gap:sync?0:this.data.gap});this.accept(result)
 },
 calibration(e){if(this.data.room.timeline.state==='playing')return this.setData({error:'请房主先暂停，再调整校准'});this.setData({[e.currentTarget.dataset.key]:Number(e.detail.value)});this.run(()=>this.saveCalibration())},
 ready(){this.run(async()=>{if(!this.image||!this.clock)throw new Error('资源或时间尚未就绪');if(this.clock.uncertainty>250)throw new Error('网络延迟过大，请重新连接后再准备');await this.saveCalibration();if(!this.visible||this.closed)return;const result=await api.action(this.roomId,'ready',{version:this.data.room.version,spriteVersion:this.data.room.spriteVersion});this.accept(result)})},
 play(){this.command('play')},pause(){this.command('pause')},
 watchScreen(e){this.setData({watchIndex:Number(e.detail.value)});if(this.data.room)this.accept({room:this.data.room})},
 command(action){if(this.adminMode)return;this.run(async()=>{this.accept(await api.action(this.roomId,action,{version:this.data.room.version}));if(action==='play')this.setData({panel:false})})}
})
