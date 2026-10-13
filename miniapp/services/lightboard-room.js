const {request,upload}=require('./api')
const base='/lightboard'
const guestKey='mengyu_lightboard_guest'
let guestToken='',guestPending
async function guestHeader(){
  if(guestToken)return {'X-Lightboard-Guest':guestToken}
  if(!guestPending)guestPending=(async()=>{
    let stored
    try{stored=wx.getStorageSync(guestKey)}catch(_){throw new Error('无法读取本机访客身份，请检查微信存储空间')}
    if(!/^[a-f0-9]{64}$/.test(stored||'')){
      const result=await request(base+'/session',{method:'POST'})
      stored=result.token
      if(!/^[a-f0-9]{64}$/.test(stored||''))throw new Error('访客身份初始化失败，请重试')
      try{wx.setStorageSync(guestKey,stored)}catch(_){throw new Error('无法保存访客身份，请检查微信存储空间')}
    }
    guestToken=stored
    return stored
  })()
  try{return {'X-Lightboard-Guest':await guestPending}}finally{guestPending=null}
}
async function action(id,action,data={}){return request(`${base}/rooms/${encodeURIComponent(id)}`,{method:'POST',header:await guestHeader(),data:{...data,action}})}
function mono(){if(wx.getPerformance)return wx.getPerformance().now();return Date.now()}
async function synchronize(active=()=>true){
  let best
  for(let i=0;i<5;i++){
    if(!active())throw new Error('页面已退出')
    const start=mono(),result=await request(base+'/clock',{timeout:5000}),end=mono()
    const delay=end-start-(result.sent-result.received)
    if(!best||delay<best.delay)best={delay,anchor:end,server:result.sent+Math.max(0,delay)/2}
  }
  if(!active())throw new Error('页面已退出')
  return {uncertainty:Math.max(0,best.delay)/2,now:()=>best.server+mono()-best.anchor}
}
function elapsed(timeline,time){
  if(time<timeline.at&&timeline.previous)return elapsed(timeline.previous,time)
  return timeline.position+(timeline.state==='playing'?Math.max(0,time-timeline.at)/1000:0)
}
function geometry(room,uid,w,h){
  const member=room.members.find(m=>m.uid===uid)
  if(!member)throw new Error('你已不在房间中')
  if(room.mode==='sync')return {scale:Math.min(w/750,h/300),left:0,width:750,total:750,offset:0}
  let left=0,total=0
  for(const m of room.members){if(m.uid===uid)left=total;total+=m.width+m.gap}
  return {scale:h/300*member.scale,left,width:member.width,total:total-room.members[room.members.length-1].gap,offset:member.offset}
}
function draw(ctx,image,room,uid,w,h,time){
  const cfg=room.config,g=geometry(room,uid,w,h),textScale=(300*cfg.size/100)/48
  const tw=room.spriteWidth*textScale,th=room.spriteHeight*textScale
  const distance=elapsed(room.timeline,time)*cfg.speed,cycle=g.total+tw+60,pos=((distance%cycle)+cycle)%cycle
  const x=cfg.direction===0?g.total-pos:-tw+pos
  ctx.fillStyle=cfg.bg;ctx.fillRect(0,0,w,h)
  ctx.save();ctx.translate((w-g.width*g.scale)/2,h/2+g.offset*g.scale);ctx.scale(g.scale,g.scale)
  ctx.drawImage(image,x-g.left,-th/2,tw,th);ctx.restore()
}
module.exports={action,synchronize,elapsed,geometry,draw,
 adminList:(page=1)=>request(`${base}/admin/rooms`,{data:{page}}),
 adminRoom:(id)=>request(`${base}/admin/rooms/${encodeURIComponent(id)}`),
 adminClose:(id)=>request(`${base}/admin/rooms/${encodeURIComponent(id)}`,{method:'DELETE'}),
 create:async(mode,config)=>request(base+'/rooms',{method:'POST',header:await guestHeader(),data:{mode,config}}),
 spriteURL:(room)=>`${getApp().globalData.apiBaseUrl}${base}/rooms/${room.id}/sprite/${room.spriteVersion}`,
 uploadSprite:async(room,file)=>upload(`${base}/rooms/${room.id}`,file,{header:await guestHeader(),formData:{action:'sprite',version:String(room.version)}})}
