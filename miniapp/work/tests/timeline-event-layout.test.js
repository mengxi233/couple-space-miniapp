const assert = require('node:assert/strict')
const fs = require('node:fs')
const wxml = fs.readFileSync('pages/timeline-event/timeline-event.wxml', 'utf8')
const css = fs.readFileSync('pages/timeline-event/timeline-event.wxss', 'utf8')

// Explicit inner-button sizing avoids native button defaults; native view
// wrappers own flex sizing instead of styling a custom-component tag.
for (const action of ['cancel', 'save', 'remove', 'edit', 'addVideo', 'clearVideo', 'playVideo']) {
  const tag = wxml.match(new RegExp('<van-button\\b[^>]*bindtap="' + action + '"[^>]*>'))
  assert.ok(tag, action)
  assert.doesNotMatch(tag[0], /\sblock(?:\s|=|>)/)
  for (const rule of ['width:auto;', 'min-width:0;', 'max-width:100%;', 'height:36px;', 'margin:0;', 'white-space:nowrap;']) {
    assert.ok(tag[0].includes(rule), action + ': ' + rule)
  }
}
assert.equal((wxml.match(/class="action-item"/g) || []).length, 4)
assert.match(css, /\.actions\s*\{[^}]*flex-wrap:\s*wrap/)
assert.match(css, /\.action-item\s*\{[^}]*flex:\s*0 0 auto/)
assert.doesNotMatch(css, /\.actions van-button/)
assert.ok(wxml.includes('单个视频不超过10MB'))
assert.match(wxml, /bindtap="save" loading="{{saving}}" disabled="{{uploading}}"/)
assert.match(wxml, /bindtap="edit" disabled="{{saving}}"/)
console.log('Timeline event layout checks passed: compact buttons, wrapping, and action guards.')
