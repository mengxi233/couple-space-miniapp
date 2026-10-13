const { fonts, themes, defaultBoard, board } = require('../../services/little-apps')
const { LightboardRenderer } = require('../../services/lightboard-renderer')
const { channels, hex } = require('../../services/color-picker')
Page({
  data:{fonts,themes,form:defaultBoard,directions:['向左滚动','向右滚动','静止居中'],colors:['#ffffff','#000000','#1456b8','#ff9fba','#ffe26a','#77ffdd','#ff4444','#25151c']},
  onLoad(){try{this.updateData({form:board(wx.getStorageSync('mengyu_lightboard') || {})})}catch(_){}},
  updateData(patch){this.setData(patch);this.refreshPreview()},
  onReady(){this.setupPreview()},
  onShow(){this.previewVisible=true;if(this.previewRenderer)this.previewRenderer.start()},
  onHide(){this.previewVisible=false;if(this.previewRenderer)this.previewRenderer.stop()},
  onUnload(){this.closed=true;if(this.previewRenderer)this.previewRenderer.destroy()},
  onResize(){this.setupPreview()},
  setupPreview(){
    const generation=this.previewGeneration=(this.previewGeneration||0)+1
    this.createSelectorQuery().select('#livePreview').fields({node:true,size:true}).exec(rows=>{
      if(this.closed||generation!==this.previewGeneration||!rows[0]||!rows[0].node||!rows[0].width)return
      if(this.previewRenderer)this.previewRenderer.destroy()
      const item=rows[0]
      this.previewRenderer=new LightboardRenderer(item.node,item.width,item.height,message=>{if(!this.closed)this.setData({previewNotice:message})})
      this.refreshPreview();if(this.previewVisible)this.previewRenderer.start()
    })
  },
  refreshPreview(){
    if(!this.previewRenderer)return
    const config={...this.data.form}
    if(this.data.showColor)config[this.data.colorField]=this.data.pickedColor
    this.previewRenderer.configure(config)
  },
  async savePreview(){
    if(this.data.savingPreview)return
    const renderer=this.previewRenderer
    if(!renderer||renderer.destroyed)return wx.showToast({title:'预览尚未就绪，请稍后重试',icon:'none'})
    if(renderer.fontLoading||renderer.backgroundLoading)return wx.showToast({title:'资源正在加载，请稍后保存',icon:'none'})
    this.setData({savingPreview:true});renderer.stop()
    try{
      const canvas=renderer.canvas
      const output=await new Promise((resolve,reject)=>wx.canvasToTempFilePath({canvas,fileType:'png',destWidth:canvas.width,destHeight:canvas.height,success:resolve,fail:()=>reject(new Error('图片生成失败，请稍后重试'))}))
      if(this.closed)return
      if(this.previewVisible&&this.previewRenderer===renderer)renderer.start()
      await new Promise((resolve,reject)=>wx.saveImageToPhotosAlbum({filePath:output.tempFilePath,success:resolve,fail:reject}))
      if(!this.closed)wx.showToast({title:'已保存到相册',icon:'success'})
    }catch(error){
      if(this.closed)return
      if(/auth deny|auth denied|authorize/i.test(error.errMsg||'')){
        wx.showModal({title:'需要相册权限',content:'请允许保存到相册，返回后再次点击保存预览图片。',confirmText:'去设置',confirmColor:'#c97982',success:result=>{if(result.confirm&&!this.closed)wx.openSetting({})}})
      }else wx.showToast({title:error.message||'保存失败，请检查相册权限和空间',icon:'none'})
    }finally{
      if(!this.closed){this.setData({savingPreview:false});if(this.previewVisible&&this.previewRenderer===renderer)renderer.start()}
    }
  },
  openColor(e){const field=e.currentTarget.dataset.field;this.updateData({colorField:field,showColor:true,rgb:channels(this.data.form[field]),pickedColor:this.data.form[field]})},
  pickChannel(e){const rgb=this.data.rgb.slice();rgb[Number(e.currentTarget.dataset.index)]=Number(e.detail.value);this.updateData({rgb,pickedColor:hex(rgb)})},
  confirmColor(){this.updateData({['form.'+this.data.colorField]:this.data.pickedColor,showColor:false})},
  closeColor(){this.updateData({showColor:false})},
  chooseBackground(){
    if(this.data.choosingBackground)return
    this.updateData({choosingBackground:true})
    wx.chooseMedia({count:1,mediaType:['image'],sourceType:['album'],sizeType:['compressed'],success:result=>{
      const file=result.tempFiles[0]
      if(!file||file.size>10*1024*1024){this.updateData({choosingBackground:false});return wx.showToast({title:'请选择 10MB 以内图片',icon:'none'})}
      wx.saveFile({tempFilePath:file.tempFilePath,success:saved=>{
        const previous=this.data.form.backgroundImage
        this.updateData({'form.backgroundImage':saved.savedFilePath})
        try{wx.setStorageSync('mengyu_lightboard',board(this.data.form));if(previous&&previous!==saved.savedFilePath)wx.removeSavedFile({filePath:previous,fail:()=>{}})}catch(_){}
      },fail:()=>wx.showToast({title:'图片保存失败，请检查本机空间',icon:'none'}),complete:()=>this.updateData({choosingBackground:false})})
    },fail:error=>{this.updateData({choosingBackground:false});if(!/cancel/i.test(error.errMsg||''))wx.showToast({title:'无法打开相册，请检查授权',icon:'none'})}})
  },
  clearBackground(){this.updateData({'form.backgroundImage':''});try{wx.setStorageSync('mengyu_lightboard',board(this.data.form))}catch(_){}},
  backgroundError(){this.clearBackground();wx.showToast({title:'背景图片已失效，请重新选择',icon:'none'})},
  back(){wx.navigateBack()},
  multiplayer(){try{wx.setStorageSync('mengyu_lightboard',board(this.data.form))}catch(_){}wx.navigateTo({url:'/pages/lightboard-room/lightboard-room'})},
  text(e){this.updateData({'form.text':e.detail.value})},
  change(e){this.updateData({['form.'+e.currentTarget.dataset.field]:e.detail.value})},
  theme(e){const theme=themes[e.currentTarget.dataset.index];this.updateData({'form.fg':theme.fg,'form.bg':theme.bg})},
  color(e){this.updateData({['form.'+e.currentTarget.dataset.field]:e.currentTarget.dataset.color})},
  start(){
    if(!['fg','bg'].every(key=>/^#[0-9a-f]{6}$/i.test(this.data.form[key])))return wx.showToast({title:'颜色请填写 # 加 6 位十六进制数',icon:'none'})
    const form=board(this.data.form)
    if(!form.text.trim())return wx.showToast({title:'先写一句想展示的话',icon:'none'})
    if(!form.backgroundImage&&form.bg.toLowerCase()===form.fg.toLowerCase())return wx.showToast({title:'文字与背景请使用不同颜色',icon:'none'})
    try{wx.setStorageSync('mengyu_lightboard',form)}catch(_){wx.showToast({title:'设置未保存，本次仍可展示',icon:'none'})}
    wx.navigateTo({url:'/pages/lightboard-show/lightboard-show?config='+encodeURIComponent(JSON.stringify(form))})
  }
})
