const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition,info={windowWidth:390,windowHeight:800},timers=new Map(),id=0,queries=[],created=0
class Renderer{
 constructor(){created++;this.ctx={}}
 configure(){} start(){this.running=true} stop(){this.running=false} destroy(){this.destroyed=true}
}
const wx={getWindowInfo:()=>info,setKeepScreenOn(){}}
vm.runInNewContext(fs.readFileSync('pages/lightboard-show/lightboard-show.js','utf8'),{
 Page:d=>definition=d,wx,console,require:p=>p.includes('renderer')?{LightboardRenderer:Renderer}:require('../../services/little-apps'),
 setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key)
})
function page(){return {...definition,data:{form:{},paused:false},visible:true,setData(d,cb){Object.assign(this.data,d);if(cb)cb()},createSelectorQuery(){return {select(){return this},fields(){return this},exec(cb){queries.push(cb)}}}}}
function tick(){const [key,fn]=timers.entries().next().value;timers.delete(key);fn()}
function result(width=800,height=390){queries.shift()([{node:{},width,height}])}
const p=page();Object.defineProperty(p,'renderer',{value:'webview',writable:false});p.onReady();assert.equal(created,0);assert.equal(timers.size,1)
info={windowWidth:800,windowHeight:390};tick();assert.equal(p.data.canvasWidth,800)
result(0,0);assert.equal(created,0);tick();result();assert.equal(p.data.ready,true);assert(p._lightboardRenderer.running);assert.equal(p.renderer,'webview')
 p.pause();assert.equal(p._lightboardRenderer.paused,true);p.pause();assert.equal(p._lightboardRenderer.paused,false)
p.onResize();const stale=queries.shift();p.onResize();stale([{node:{},width:800,height:390}]);assert.equal(created,1);result();assert.equal(created,2)
p.onResize();result(0,0);p.onHide();assert.equal(timers.size,0);assert.equal(p._lightboardRenderer.running,false)
p.onShow();result();assert(p._lightboardRenderer.running)
p.onResize();const late=queries.shift();p.onUnload();late([{node:{},width:800,height:390}]);assert.equal(created,3)
const q=page();info={windowWidth:390,windowHeight:800};q.onReady();for(let i=0;i<11;i++)tick();assert.equal(timers.size,0);assert(q.data.error.includes('重试'))
const empty=page();empty.renderer={type:'webview'};empty.stop();empty.start();empty.onUnload();assert.equal(empty.renderer.type,'webview')
const invalid=page();invalid._lightboardRenderer={};invalid.stop();invalid.start();invalid.destroyBoardRenderer();assert.equal(invalid._lightboardRenderer,null)
console.log('Landscape initialization passed: runtime renderer collision, playback, portrait/zero size retry, stale queries, resize, visibility, unload, bounded failure.')
