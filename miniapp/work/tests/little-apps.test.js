const assert=require('node:assert/strict')
const fs=require('node:fs')
const vm=require('node:vm')
const {options,pick,board,fonts,themes}=require('../../services/little-apps')
assert.deepEqual(options('吃饭\n 散步\n吃饭\n'),['吃饭','散步'])
assert.throws(()=>options('唯一'))
assert.throws(()=>options('长'.repeat(25)+'\n短'))
assert.throws(()=>options(Array.from({length:21},(_,i)=>'选项'+i).join('\n')))
for(let i=0;i<20;i++)assert.equal(pick(20,()=> (i+.5)/20),i)
assert.throws(()=>pick(0))
assert.equal(board({font:0,direction:0}).font,0)
assert.equal(board({speed:999}).speed,240)
assert.equal(board({fg:'not-color'}).fg,'#ffffff')
assert.equal(Array.from(board({text:'好'.repeat(80)}).text).length,40)
assert.equal(fonts.length,5);assert.ok(themes.length>=3)
// Wheel segment midpoint at the final angle must meet the top pointer.
for(let count=2;count<=20;count++)for(let index=0;index<count;index++){
 const step=2*Math.PI/count,target=10*Math.PI+2*Math.PI-(index+.5)*step
 const angle=(target+(index+.5)*step)%(2*Math.PI)
 assert.ok(Math.min(angle,Math.abs(angle-2*Math.PI))<1e-10)
}
const manifest=JSON.parse(fs.readFileSync('app.json'))
for(const route of manifest.pages){for(const ext of ['js','json','wxml','wxss'])assert.ok(fs.existsSync(route+'.'+ext));new vm.Script(fs.readFileSync(route+'.js','utf8'));JSON.parse(fs.readFileSync(route+'.json'))}
let definition;const calls=[]
vm.runInNewContext(fs.readFileSync('pages/lightboard-show/lightboard-show.js','utf8'),{Page:value=>definition=value,require:()=>({board,fonts}),wx:{setKeepScreenOn:value=>calls.push(value.keepScreenOn)}})
const page={...definition,data:{paused:false},setData(value){Object.assign(this.data,value)}}
page.onShow();page.onHide();page.onUnload();assert.deepEqual(calls,[true,false,false])
console.log('Little apps tests passed: choices, random boundaries, wheel alignment, configuration, routes, screen-on cleanup.')
let decisionDefinition
vm.runInNewContext(fs.readFileSync('pages/decision/decision.js','utf8'),{Page:value=>decisionDefinition=value,require:path=>path.endsWith('app-access')?{identity:()=>({activated:true})}:({options,pick}),wx:{getStorageSync:()=>null,setStorageSync(){}}})
const decision={...decisionDefinition,data:structuredClone(decisionDefinition.data),setData(value){Object.assign(this.data,value)}}
decision.onLoad()
const firstId=decision.data.optionCards[0].id,secondId=decision.data.optionCards[1].id
decision.moveOption({currentTarget:{dataset:{id:firstId,direction:1}}})
assert.equal(decision.data.optionCards[0].id,secondId)
decision.editOption({currentTarget:{dataset:{id:firstId}},detail:{value:'新的选择'}})
assert.equal(decision.data.optionCards[1].value,'新的选择')
decision.addOption();assert.equal(decision.data.optionCards.length,7)
decision.removeOption({currentTarget:{dataset:{id:decision.data.optionCards[6].id}}})
assert.equal(decision.data.optionCards.length,6)
decision.setData({spinning:true});decision.addOption();assert.equal(decision.data.optionCards.length,6)
console.log('Decision cards passed: add, edit, reorder, delete, spin lock.')
decision.setData({spinning:false})
const draggedId=decision.data.optionCards[0].id
decision.dragSession={id:draggedId,y:20,rects:decision.data.optionCards.map((_,i)=>({top:i*60,height:50}))}
decision.dragMove({touches:[{clientY:145}]});assert.equal(decision.data.dropIndex,2)
decision.dragEnd();assert.equal(decision.data.optionCards[2].id,draggedId);assert.equal(decision.data.dragId,0)
const before=decision.data.draft;decision.dragSession={id:draggedId,y:20};decision.cancelDrag();decision.dragEnd();assert.equal(decision.data.draft,before)
console.log('Drag sort passed: drop reorder and cancellation.')
