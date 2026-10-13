const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let exported
vm.runInNewContext(fs.readFileSync('services/lightboard-room.js','utf8'),{module:{set exports(value){exported=value}},require:()=>({}),getApp:()=>({globalData:{apiBaseUrl:'https://example.com'}})})
const {elapsed,geometry,draw}=exported
const play={state:'playing',at:3000,position:0,previous:{state:'paused',position:0,at:0}}
assert.equal(elapsed(play,2999),0);assert.equal(elapsed(play,5000),2)
const pause={state:'paused',at:6000,position:3,previous:play}
assert.equal(elapsed(pause,5500),2.5);assert.equal(elapsed(pause,8000),3)
const resume={state:'playing',at:10000,position:3,previous:pause}
assert.equal(elapsed(resume,11000),4)
const room={mode:'extend',config:{size:50,speed:100,direction:0,bg:'#000000'},spriteWidth:400,spriteHeight:96,timeline:play,members:Array.from({length:6},(_,i)=>({uid:i+1,width:600,scale:1,offset:0,gap:10}))}
assert.equal(geometry(room,6,600,300).left,3050);assert.equal(geometry(room,1,600,300).total,3650)
let x=[];const ctx={fillRect(){},save(){},restore(){},translate(){},scale(){},drawImage(img,left){x.push(left)}}
draw(ctx,{},room,1,600,300,8000);draw(ctx,{},room,2,600,300,8000);assert.equal(x[0]-x[1],610)
room.mode='sync';x=[];draw(ctx,{},room,1,600,300,8000);draw(ctx,{},room,6,900,400,8000);assert.equal(x[0],x[1])
assert.throws(()=>geometry(room,99,600,300))
console.log('Room sync passed: common phase, future commands, pause/resume, six-screen offsets, device-independent sync.')
