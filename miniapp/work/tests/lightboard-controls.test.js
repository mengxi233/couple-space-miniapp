const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm')
let definition
vm.runInNewContext(fs.readFileSync('pages/lightboard-show/lightboard-show.js','utf8'),{
 Page:d=>definition=d,require:p=>p.includes('little-apps')?require('../../services/little-apps'):{}
})
const page={...definition,data:{...definition.data},setData(d){Object.assign(this.data,d)}}
assert.equal(page.data.controlsVisible,false)
page.toggleControls();assert.equal(page.data.controlsVisible,true)
page.pause();assert.equal(page.data.controlsVisible,true)
page.toggleControls();assert.equal(page.data.controlsVisible,false)
const markup=fs.readFileSync('pages/lightboard-show/lightboard-show.wxml','utf8')
assert.match(markup,/<canvas[^>]*bindtap="toggleControls"/)
assert.match(markup,/<view wx:if="\{\{controlsVisible\}\}" class="controls">/)
assert.match(markup,/wx:if="\{\{form.direction !== 2\}\}"/)
assert.equal((markup.match(/bindtap="toggleControls"/g)||[]).length,1)
console.log('Fullscreen controls passed: hidden by default, canvas toggle, buttons preserve visibility, static playback hidden.')
