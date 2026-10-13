const assert = require('node:assert/strict')
const { headerLayout } = require('../../services/header-layout')
for (const [status,top,width,left] of [[24,32,375,278],[44,52,390,293],[59,67,430,333]]) {
  const layout = headerLayout({statusBarHeight:status,windowWidth:width},{top,height:32,left})
  assert.equal(layout.top,top)
  assert.equal(layout.height,32)
  assert.ok(width-layout.right < left, 'navigation text must not overlap capsule')
  assert.ok(layout.top + layout.height < status + 60, 'no redundant 100px top spacer')
}
assert.equal(headerLayout({},{}).top,32)
console.log('Shared header tests passed: status bar, capsule clearance, compact spacing, fallback.')
