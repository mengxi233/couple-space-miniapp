const assert=require('node:assert/strict'),fs=require('node:fs')
const config=JSON.parse(fs.readFileSync('pages/lightboard-admin/lightboard-admin.json','utf8'))
assert.equal(config.navigationBarBackgroundColor,'#fff7f8')
assert.equal(config.navigationBarTextStyle,'black')
const markup=fs.readFileSync('pages/lightboard-admin/lightboard-admin.wxml','utf8')
const buttons=markup.match(/<van-button class="pagination-button"[^>]+>/g)||[]
assert.equal(buttons.length,2)
for(const button of buttons){assert(button.includes('width:auto;min-width:0;height:32px'));assert(button.includes('white-space:nowrap'))}
const css=fs.readFileSync('pages/lightboard-admin/lightboard-admin.wxss','utf8')
assert.match(css,/\.pagination-count\{[^}]*white-space:nowrap/)
assert.match(css,/\.pagination-button\{[^}]*flex:0 0 auto/)
console.log('Admin layout passed: theme navigation, compact pagination buttons, non-wrapping counter.')
