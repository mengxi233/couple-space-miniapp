const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
let responder, definition
const wx = { showToast() {}, navigateTo() {} }
function loadPage(path) {
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), {
    Page: value => { definition = value }, wx,
    require: () => ({ request: (...args) => responder(...args) })
  })
  const page = { ...definition, data: structuredClone(definition.data) }
  page.setData = patch => Object.assign(page.data, patch)
  return page
}
const flush = () => new Promise(resolve => setImmediate(resolve))
async function main() {
  const list = loadPage('pages/timeline/timeline.js')
  let first
  responder = () => new Promise(resolve => { first = resolve })
  list.load()
  responder = () => Promise.resolve({ events: [{ id: 2 }], canEdit: true, hasMore: false })
  list.load()
  await flush()
  first({ events: [{ id: 1 }], canEdit: true })
  await flush()
  assert.equal(list.data.events[0].id, 2, 'stale responses must not replace new search')
  responder = () => Promise.reject(Object.assign(new Error('请先登录'), { statusCode: 401 }))
  list.load()
  await flush()
  assert.equal(list.data.events.length, 0)
  assert.equal(list.data.canEdit, false)
  assert.equal(list.data.blocked, true)

  const editor = loadPage('pages/timeline-event/timeline-event.js')
  editor.data.canEdit = true
  editor.data.editing = true
  editor.data.form.title = '未保存的事件'
  responder = () => Promise.reject(new Error('timeout'))
  editor.save()
  await flush()
  assert.equal(editor.data.editing, true)
  assert.equal(editor.data.form.title, '未保存的事件')
  assert.equal(editor.data.saving, false)
  responder = () => Promise.resolve({ event: { id: 3, title: '已保存' } })
  editor.save()
  await flush()
  assert.equal(editor.data.id, 3)
  assert.equal(editor.data.editing, false)
  const manifest = JSON.parse(fs.readFileSync('app.json', 'utf8'))
  for (const route of manifest.pages) {
    for (const extension of ['js','json','wxml','wxss']) assert.ok(fs.existsSync(`${route}.${extension}`), `${route}.${extension}`)
  }
  console.log('Timeline frontend tests passed: request races, permissions, save recovery, routes.')
}
main().catch(error => { console.error(error); process.exitCode=1 })
