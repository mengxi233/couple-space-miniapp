const assert = require('assert')
let fontRequest, frame
global.wx={getWindowInfo:()=>({pixelRatio:2}),loadFontFace:options=>{fontRequest=options}}
const {LightboardRenderer}=require('../../services/lightboard-renderer')
const calls=[]
const ctx={scale(){},save(){},restore(){},translate(){},fillRect(){},drawImage(){},measureText:()=>({width:120}),fillText(text,x,y){calls.push({text,x,y,font:this.font,color:this.fillStyle})}}
const canvas={getContext:()=>ctx,requestAnimationFrame:fn=>{frame=fn;return 1},cancelAnimationFrame(){}}
const renderer=new LightboardRenderer(canvas,300,140)
renderer.configure({text:'像素字体',font:4,direction:0})
assert(fontRequest.scopes.includes('native'))
assert.equal(calls.at(-1).x,12,'Scrolling text must be visible immediately')
fontRequest.success()
assert(calls.at(-1).font.includes('FusionPixel'))
renderer.configure({...renderer.config,text:'实时更新',fg:'#ff0000',size:80,direction:2,mirror:true,glow:true})
assert.equal(calls.at(-1).text,'实时更新')
assert.equal(calls.at(-1).color,'#ff0000')
assert(calls.at(-1).font.includes('112px'))
assert.equal(calls.at(-1).x,90)
renderer.start();assert.equal(typeof frame,'function');renderer.destroy()
assert.equal(renderer.running,false)
console.log('Live renderer passed: real font, native scope, immediate visibility, config updates, lifecycle.')
