const { board, fonts } = require('./little-apps')
const FONT_URL = require('../config').apiBaseUrl + '/media/fusion-pixel-12px-zh_hans.woff2'
// One renderer for the live preview, fullscreen display and saved canvas image.
class LightboardRenderer {
  constructor(canvas, width, height, notice = () => {}) {
    this.canvas=canvas;this.w=width;this.h=height;this.notice=notice;this.travel=0;this.config=board();this.backgroundPath='';this.background=null;this.paused=false
    const dpr=Math.min(2,(wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : 1)||1)
    canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr)
    this.ctx=canvas.getContext('2d');this.ctx.scale(dpr,dpr)
  }
  configure(value) {
    const next=board(value)
    if(!this.configured || next.text!==this.config.text || next.direction!==this.config.direction)this.resetPosition=true
    const retryFont=!this.configured || next.font!==this.config.font
    this.configured=true
    this.config=next
    if(retryFont&&next.font!==4)this.notice('')
    if(next.font===4&&!this.fontReady&&!this.fontLoading&&retryFont)this.loadFont()
    if(next.backgroundImage!==this.backgroundPath){
      this.backgroundPath=next.backgroundImage;this.background=null;this.backgroundLoading=!!this.backgroundPath
      clearTimeout(this.imageTimer)
      if(this.backgroundPath){
        const path=this.backgroundPath,image=this.canvas.createImage()
        const failed=()=>{if(this.destroyed||path!==this.backgroundPath)return;clearTimeout(this.imageTimer);this.backgroundLoading=false;this.notice('背景图片无法加载，已使用纯色背景')}
        image.onload=()=>{if(this.destroyed||path!==this.backgroundPath)return;clearTimeout(this.imageTimer);this.background=image;this.backgroundLoading=false;this.draw()}
        image.onerror=failed;this.imageTimer=setTimeout(failed,15000);image.src=path
      }
    }
    this.draw()
  }
  loadFont(){
    const attempt=this.fontAttempt=(this.fontAttempt||0)+1
    this.fontLoading=true;this.notice('正在加载开源像素字体…')
    const complete=(success)=>{
      if(this.destroyed||!this.fontLoading||attempt!==this.fontAttempt)return
      clearTimeout(this.fontTimer);this.fontLoading=false;this.fontReady=success
      if(this.config.font===4)this.notice(success?'':'像素字体加载失败，暂用默认字体；重新选择像素字体可重试')
      this.draw()
    }
    this.fontTimer=setTimeout(()=>complete(false),20000)
    if(!wx.loadFontFace)return complete(false)
    wx.loadFontFace({family:'FusionPixel',source:`url("${FONT_URL}")`,scopes:['webview','native'],success:()=>complete(true),fail:()=>complete(false)})
  }
  draw(){
    if(this.destroyed)return
    const c=this.ctx,f=this.config,w=this.w,h=this.h
    c.fillStyle=f.bg;c.fillRect(0,0,w,h)
    if(this.background){const image=this.background,ratio=Math.max(w/image.width,h/image.height);c.drawImage(image,(w-image.width*ratio)/2,(h-image.height*ratio)/2,image.width*ratio,image.height*ratio)}
    const font=f.font===4&&!this.fontReady?fonts[0]:fonts[f.font]
    let size=h*f.size/100
    c.save();if(f.mirror){c.translate(w,0);c.scale(-1,1)}
    c.font=`${font.weight} ${size}px ${font.family}`
    let width=c.measureText(f.text).width
    if(f.direction===2){const ratio=Math.min(1,(w-24)/Math.max(1,width));size*=ratio;width*=ratio;c.font=`${font.weight} ${size}px ${font.family}`}
    if(this.resetPosition){this.travel=f.direction===0?w-12:width+12;this.resetPosition=false}
    const pos=this.travel%(w+width+40)
    const x=f.direction===2?(w-width)/2:f.direction===0?w-pos:-width+pos
    if(f.glow){c.shadowColor=f.fg;c.shadowBlur=Math.max(3,h*.04)}
    c.fillStyle=f.fg;c.textBaseline='middle';c.fillText(f.text,x,h/2);c.restore()
  }
  start(){
    this.stop();this.last=Date.now();this.running=true
    const tick=()=>{if(!this.running||this.destroyed)return;const now=Date.now(),dt=Math.min(.1,(now-this.last)/1000);this.last=now
      if(!this.paused)this.travel+=dt*this.config.speed*(this.w/750)
      this.draw();this.frame=this.canvas.requestAnimationFrame(tick)
    };this.frame=this.canvas.requestAnimationFrame(tick)
  }
  stop(){this.running=false;if(this.frame)this.canvas.cancelAnimationFrame(this.frame);this.frame=null}
  destroy(){this.stop();this.destroyed=true;clearTimeout(this.imageTimer);clearTimeout(this.fontTimer);this.background=null}
}
module.exports = { LightboardRenderer, FONT_URL }
