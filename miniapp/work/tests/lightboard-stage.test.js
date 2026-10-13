const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition,next=0,timers=new Map(),frames=new Map(),actions=[]
const room={id:'abc',seq:1,owner:1,mode:'sync',version:2,spriteVersion:2,spriteWidth:200,spriteHeight:96,config:{bg:'#000000'},timeline:{state:'paused',at:0,position:0},members:[{uid:1,name:'我',width:750,scale:1,offset:0,gap:0,ready:false}]}
const context={scale(){},fillRect(){},beginPath(){},moveTo(){},lineTo(){},stroke(){},fillText(){}}
const canvas={getContext:()=>context,requestAnimationFrame(fn){frames.set(++next,fn);return next},cancelAnimationFrame(id){frames.delete(id)},createImage(){const image={};Object.defineProperty(image,'src',{set(){image.onload()}});return image}}
const api={synchronize:async()=>({uncertainty:5,now:()=>1000}),draw(){},spriteURL:()=>'',action:async(id,action)=>{actions.push(action);return {room:JSON.parse(JSON.stringify(room)),uid:1}},adminRoom:async()=>({room:JSON.parse(JSON.stringify(room)),uid:11,observing:true})}
const wx={getWindowInfo:()=>({windowWidth:800,windowHeight:390,pixelRatio:1}),setKeepScreenOn(){}}
vm.runInNewContext(fs.readFileSync('pages/lightboard-stage/lightboard-stage.js','utf8'),{Page:d=>definition=d,wx,require:()=>api,Date,console,setTimeout:fn=>{timers.set(++next,fn);return next},clearTimeout:id=>timers.delete(id)})
async function main(){
 const p={...definition,data:{...definition.data},setData(data,cb){Object.assign(this.data,data);if(cb)cb()},createSelectorQuery(){return {select(){return this},fields(){return this},exec(cb){cb([{node:canvas,width:800,height:390}])}}}}
 p.onLoad({room:'abc'});p.onShow();p.onReady();await new Promise(setImmediate)
 assert.equal(p.data.clockReady,true);assert.equal(p.data.imageReady,true);assert.equal(p.data.screenIndex,1);assert(timers.size>0);assert(frames.size>0)
 await p.saveCalibration();assert(actions.includes('calibrate'))
 p.togglePanel();assert.equal(p.data.panel,false)
 p.onHide();assert.equal(timers.size,0);assert.equal(frames.size,0)
 p.onUnload();assert.equal(p.canvas,null);assert.equal(p.image,null)
 p.accept({room,uid:1});assert.equal(p.image,null)
 const observer={...p,data:{...definition.data},closed:false,pageReady:false,visible:false,calibrationLoaded:false,frame:null}
 const before=actions.length
 observer.onLoad({room:'abc',admin:'1'});observer.onShow();observer.onReady();await new Promise(setImmediate)
 assert.equal(observer.data.observing,true);assert.equal(observer.uid,1);assert.equal(observer.data.isOwner,false);assert.equal(actions.length,before)
 await assert.rejects(observer.saveCalibration(),/旁观/);observer.command('play');assert.equal(actions.length,before)
 observer.watchScreen({detail:{value:0}});assert.equal(observer.data.screenIndex,1)
 observer.onUnload();assert.equal(timers.size,0);assert.equal(frames.size,0)
 console.log('Multiplayer stage passed: initialization, image readiness, calibration, controls, timer/frame cleanup, late callback guard.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
