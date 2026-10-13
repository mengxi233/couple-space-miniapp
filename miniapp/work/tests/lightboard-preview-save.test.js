const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition,exported=0,saved=0,modal=0,failExport=false,deny=false
const wx={showToast(){},showModal(){modal++},canvasToTempFilePath(o){exported++;assert.equal(o.canvas.width,600);if(failExport)o.fail();else o.success({tempFilePath:'preview.png'})},saveImageToPhotosAlbum(o){saved++;assert.equal(o.filePath,'preview.png');if(deny)o.fail({errMsg:'auth deny'});else o.success()}}
vm.runInNewContext(fs.readFileSync('pages/lightboard/lightboard.js','utf8'),{Page:d=>definition=d,wx,require:p=>p.includes('little-apps')?require('../../services/little-apps'):{}})
async function main(){
 const p={...definition,data:{},previewVisible:true,setData(d){Object.assign(this.data,d)}}
 await p.savePreview();assert.equal(exported,0)
 p.previewRenderer={canvas:{width:600,height:280},stop(){},start(){}}
 p.previewRenderer.fontLoading=true;await p.savePreview();assert.equal(exported,0)
 p.previewRenderer.fontLoading=false;await p.savePreview();assert.equal(saved,1);assert.equal(p.data.savingPreview,false)
 p.data.savingPreview=true;await p.savePreview();assert.equal(saved,1);p.data.savingPreview=false
 deny=true;await p.savePreview();assert.equal(modal,1)
 failExport=true;await p.savePreview();assert.equal(saved,2);assert.equal(p.data.savingPreview,false)
 console.log('Preview save passed: canvas export, resource readiness, album permission, busy lock, failures.')
}
main().catch(e=>{console.error(e);process.exitCode=1})
