const assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm')
let definition, callbacks, calls = [], toast, respond
const app = { globalData: { token: 'account-one' } }
const templateId = 'test-template-id'
vm.runInNewContext(fs.readFileSync('pages/index/index.js', 'utf8'), {
  Page: value => { definition = value }, getApp: () => app,
  require: name => name.endsWith('/calendar') ? {} : name.endsWith('/config') ? require('../../config') : { request: (path, options) => {
    calls.push({ path, options }); return respond(path, options)
  } },
  wx: { showToast: value => { toast = value.title },
    requestSubscribeMessage: value => { callbacks = value },
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) }
})
function page() {
  const p = { ...definition, data: structuredClone(definition.data) }
  p.setData = value => Object.assign(p.data, value)
  p.data.canEdit = true
  p.data.calendarWechat = { templateId, configured: true }
  return p
}
async function main() {
  const p = page()
  p.subscribeCalendar()
  assert.equal(calls.length, 0, 'authorization must happen directly on tap')
  assert.deepEqual(Array.from(callbacks.tmplIds), [templateId])
  await callbacks.success({ [templateId]: 'reject' })
  assert.equal(calls.length, 0)
  assert.equal(p.data.subscribingCalendar, false)
  p.subscribeCalendar()
  let attempts = 0
  respond = () => ++attempts === 1 ? Promise.reject(new Error('network')) : Promise.resolve({ templateId, configured: true, enabled: true, canAttempt: true })
  await callbacks.success({ [templateId]: 'accept' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].options.data.receiptId, calls[1].options.data.receiptId)
  assert.equal(calls[0].options.data.state, 'trial')
  assert.equal(calls[0].options.data.userId, undefined)
  assert.equal(p.data.calendarWechat.canAttempt, true)
  assert.equal(p.data.subscribingCalendar, false)
  assert.equal(toast, '已订阅下次消息')
  respond = () => Promise.resolve({ enabled: false, canAttempt: false })
  await p.stopCalendarSubscription()
  assert.equal(calls.at(-1).options.data.enabled, false)
  const visitor = page(); visitor.data.canEdit = false
  const count = calls.length; visitor.subscribeCalendar(); assert.equal(calls.length, count)
  const switched = page(); switched.subscribeCalendar(); app.globalData.token = 'account-two'
  await callbacks.success({ [templateId]: 'accept' }); assert.equal(calls.length, count)
  const opened = page()
  for (const key of ['buildCalendar','loadHome','loadBanners','loadEvents','startLoveClock']) opened[key] = () => {}
  opened.onLoad({ recordDate: '2025-10-21' })
  assert.equal(opened.data.selectedDate, '2025-10-21')
  assert.equal(opened.data.calendarYear, 2025)
  assert.equal(opened.data.calendarMonth, 9)
  let footer, modal, clipboard
  vm.runInNewContext(fs.readFileSync('components/legal-footer/legal-footer.js', 'utf8'), {
    Component: value => { footer = value }, require: () => require('../../config'), wx: { showModal: value => { modal = value }, setClipboardData: value => { clipboard = value.data } }
  })
  footer.methods.showFiling(); modal.success({ confirm: false }); assert.equal(clipboard, undefined)
  modal.success({ confirm: true }); assert.equal(clipboard, 'https://beian.miit.gov.cn/')
  assert.ok(JSON.parse(fs.readFileSync('pages/about/about.json')).usingComponents['legal-footer'])
  assert.ok(fs.readFileSync('pages/about/about.wxml','utf8').includes('<legal-footer />'))
  console.log('Calendar subscription and filing footer tests passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
