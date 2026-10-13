const assert=require('node:assert/strict')
const fs=require('node:fs'),vm=require('node:vm')
const {board,fonts}=require('../../services/little-apps')
let definition,saveCalls=0,modal=0,responder
const wx={canvasToTempFilePath:o=>o.success({tempFilePath:'poster.png'}),saveImageToPhotosAlbum:o=>{saveCalls++;responder(o)},showToast(){},showModal(){modal++}}
vm.runInNewContext(fs.readFileSync('pages/lightboard-show/lightboard-show.js','utf8'),{Page:v=>definition=v,require:()=>({board,fonts}),wx})
function page(){return {...definition,data:{saving:false,paused:true},canvas:{width:1200,height:600},ctx:{},visible:true,start(){},stop(){},setData(v){Object.assign(this.data,v)}}}
async function main(){
 const p=page();responder=o=>{assert.equal(o.filePath,'poster.png');o.success()};await p.saveImage();assert.equal(saveCalls,1);assert.equal(p.data.saving,false);assert.equal(p.data.paused,true)
 responder=o=>o.fail({errMsg:'saveImageToPhotosAlbum:fail auth deny'});await p.saveImage();assert.equal(modal,1);assert.equal(p.data.saving,false)
 p.data.saving=true;await p.saveImage();assert.equal(saveCalls,2)
 wx.canvasToTempFilePath=o=>o.fail();p.data.saving=false;await p.saveImage();assert.equal(saveCalls,2);assert.equal(p.data.saving,false)
 console.log('Lightboard save tests passed: snapshot, album permission, busy lock, failure recovery, pause preserved.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
