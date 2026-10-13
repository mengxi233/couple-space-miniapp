const assert = require('node:assert/strict')
const fs = require('node:fs'), vm = require('node:vm')
const helpers = require('../../services/decision-share')
const draft = '吃饭 & 喝茶\n散步😊\n看电影'
const share = helpers.makeShare(draft, '散步😊', true)
const snapshot = helpers.readShare(share.path.split('?s=')[1])
assert.deepEqual(snapshot, { draft, result: '散步😊', unique: true })
assert.equal(helpers.readShare(helpers.makeShare(draft,'',false).path.split('?s=')[1]).result,'')
assert.throws(()=>helpers.readShare('%bad'))
assert.throws(()=>helpers.readShare(encodeURIComponent(JSON.stringify({v:1,o:['甲','乙'],r:5}))))
assert.throws(()=>helpers.makeShare(Array.from({length:20},(_,i)=>'很长的选项'.repeat(4)+i).join('\n'),' ',false),/较长/)
let definition, writes = 0
vm.runInNewContext(fs.readFileSync('pages/decision/decision.js','utf8'), {
 Page:value=>definition=value,
 require:path=>path.endsWith('decision-share')?helpers:path.endsWith('app-access')?{identity:()=>({activated:true})}:require('../../services/little-apps'),
 wx:{getStorageSync:()=>({draft:'本机一\n本机二',history:[]}),setStorageSync(){writes++},showToast(){}}
})
const page={...definition,data:structuredClone(definition.data),setData(value){Object.assign(this.data,value)}}
page.onLoad({s:share.path.split('?s=')[1]})
assert.equal(page.data.result,'散步😊');assert.equal(page.data.shared,true);assert.equal(writes,0)
assert.equal(page.onShareAppMessage().path,share.path)
page.editOption({currentTarget:{dataset:{id:page.data.optionCards[0].id}},detail:{value:'新的选择'}})
assert.equal(page.data.selectedResult,'')
assert.equal(helpers.readShare(page.onShareAppMessage().path.split('?s=')[1]).result,'')
console.log('Decision sharing passed: round trip, result, Unicode, invalid/oversized links, local isolation, edit clears result.')
