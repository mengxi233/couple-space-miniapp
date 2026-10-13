const { board } = require('../../services/little-apps')
const { LightboardRenderer } = require('../../services/lightboard-renderer')
Page({
  data:{form:board(),paused:false,error:'',saving:false,controlsVisible:false},
  onLoad(options){try{this.setData({form:board(JSON.parse(decodeURIComponent(options.config || '{}')))})}catch(_){this.setData({error:'配置无效，请返回重新设置'})}this.syncBackground()},
  syncBackground(){if(wx.setBackgroundColor)wx.setBackgroundColor({backgroundColor:this.data.form.bg,backgroundColorTop:this.data.form.bg,backgroundColorBottom:this.data.form.bg,fail:()=>{}})},
  onReady(){this.pageReady=true;this.setup()},
  onShow(){this.visible=true;wx.setKeepScreenOn({keepScreenOn:true,fail:()=>this.setData({error:'无法保持常亮，请在手机设置中调整熄屏时间'})});if(this.pageReady)this.setup()},
  onHide(){this.visible=false;this.cancelSetup();this.stop();wx.setKeepScreenOn({keepScreenOn:false})},
  onUnload(){this.closed=true;this.visible=false;this.cancelSetup();this.stop();wx.setKeepScreenOn({keepScreenOn:false});this.destroyBoardRenderer()},
  onResize(){if(this.pageReady&&this.visible)this.setup()},
  back(){wx.navigateBack()},
  toggleControls(){this.setData({controlsVisible:!this.data.controlsVisible})},
  pause(){if(this.data.form.direction!==2){this.setData({paused:!this.data.paused});if(this._lightboardRenderer)this._lightboardRenderer.paused=this.data.paused}},
  async saveImage(){
    if(this.data.saving)return
    if(this._lightboardRenderer&&(this._lightboardRenderer.backgroundLoading||this._lightboardRenderer.fontLoading))return wx.showToast({title:'资源正在加载，请稍后保存',icon:'none'})
    if(!this.canvas||!this.ctx)return wx.showToast({title:'灯牌尚未就绪，请稍后重试',icon:'none'})
    this.setData({saving:true});this.stop()
    try{
      const canvas=this.canvas
      const output=await new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas,fileType:'png',x:0,y:0,width:canvas.width,height:canvas.height,destWidth:canvas.width,destHeight:canvas.height,success:resolve,fail:()=>reject(new Error('图片生成失败，请稍后重试'))}))
      if(this.closed)return
      // Resume after the snapshot; saving or permission dialogs must not change pause state.
      if(this.visible)this.start()
      await new Promise((resolve,reject)=>wx.saveImageToPhotosAlbum({filePath:output.tempFilePath,success:resolve,fail:reject}))
      if(!this.closed)wx.showToast({title:'已保存到相册',icon:'success'})
    }catch(error){
      if(this.closed)return
      if(/auth deny|auth denied|authorize/i.test(error.errMsg||'')){
        wx.showModal({title:'需要相册权限',content:'请允许保存到相册，返回后再次点击保存图片。',confirmText:'去设置',confirmColor:'#c97982',success:result=>{if(result.confirm&&!this.closed)wx.openSetting({})}})
      }else wx.showToast({title:error.message||'未能保存图片，请检查相册权限和空间后重试',icon:'none'})
    }finally{
      if(!this.closed){this.setData({saving:false});if(this.visible)this.start()}
    }
  },
  // Do not use Page.renderer: the runtime may already expose that property.
  stop(){const renderer=this._lightboardRenderer;if(renderer&&typeof renderer.stop==='function')renderer.stop()},
  destroyBoardRenderer(){
    const renderer=this._lightboardRenderer
    this._lightboardRenderer=null
    if(renderer&&typeof renderer.destroy==='function')renderer.destroy()
  },
  cancelSetup(){
    this.generation=(this.generation||0)+1
    if(this.setupTimer){clearTimeout(this.setupTimer);this.setupTimer=null}
  },
  setup(){
    if(this.closed||!this.visible)return
    this.cancelSetup();this.stop()
    const generation=this.generation
    const active=()=>!this.closed&&this.visible&&generation===this.generation
    this.setData({ready:false,error:''})
    let attempts=0
    const retry=()=>{
      if(!active())return
      if(++attempts>=12){this.setData({error:'灯牌加载失败，点击这里重试',ready:false});return}
      this.setupTimer=setTimeout(attempt,150)
    }
    const attempt=()=>{
      if(!active())return
      this.setupTimer=null
      try{
        const info=wx.getWindowInfo?wx.getWindowInfo():wx.getSystemInfoSync()
        const width=info.windowWidth,height=info.windowHeight
        // Rotation can briefly report portrait/zero dimensions. Never initialize that frame.
        if(!(width>0&&height>0)||width<height)return retry()
        this.setData({canvasWidth:width,canvasHeight:height},()=>{
          if(!active())return
          this.createSelectorQuery().select('#board').fields({node:true,size:true}).exec(rows=>{
            if(!active())return
            const item=rows&&rows[0]
            if(!item||!item.node||!(item.width>0&&item.height>0)||Math.abs(item.width-width)>2||Math.abs(item.height-height)>2)return retry()
            try{
              this.destroyBoardRenderer()
              this.canvas=null;this.ctx=null
              const renderer=new LightboardRenderer(item.node,item.width,item.height,message=>{if(active())this.setData({error:message})})
              this._lightboardRenderer=renderer;renderer.paused=this.data.paused;renderer.configure(this.data.form)
              this.canvas=item.node;this.ctx=renderer.ctx
              this.start();this.setData({ready:true})
            }catch(error){console.warn('Lightboard initialization failed',error);retry()}
          })
        })
      }catch(error){console.warn('Lightboard layout unavailable',error);retry()}
    }
    attempt()
  },
  start(){const renderer=this._lightboardRenderer;if(renderer&&typeof renderer.start==='function'){renderer.paused=this.data.paused;renderer.start()}}
})
