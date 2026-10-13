const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { recordTimeLabel } = require('../../services/calendar')

assert.equal(recordTimeLabel('2026-09-07 12:34:56'), '2026年9月7日 12:34')
assert.equal(recordTimeLabel('2026-09-07T04:34:56Z'), '2026年9月7日 12:34')
assert.equal(recordTimeLabel('2026-09-06T18:34:56Z'), '2026年9月7日 02:34')
assert.equal(recordTimeLabel('2026-09-07T12:34:56+08:00'), '2026年9月7日 12:34')
assert.equal(recordTimeLabel(''), '时间未记录')
assert.equal(recordTimeLabel('invalid'), '时间未记录')

let definition, response, requested, toast
const storage = {}
vm.runInNewContext(fs.readFileSync('pages/index/index.js', 'utf8'), {
  getApp: () => ({ globalData: {} }),
  Page: value => { definition = value },
  require: name => name.endsWith('/calendar') ? { recordTimeLabel } : name.endsWith('/config') ? require('../../config') : {
    request: (path, options) => { requested = { path, options }; return response() }
  },
  wx: {
    getStorageSync: key => storage[key],
    setStorageSync: (key, value) => { storage[key] = value },
    showToast: value => { toast = value.title }
  }
})
function page() {
  const instance = { ...definition, data: structuredClone(definition.data) }
  instance.setData = (value, callback) => { Object.assign(instance.data, value); if (callback) callback() }
  instance.buildCalendar = () => {}
  instance.data.canEdit = true
  instance.data.selectedDate = '2026-09-07'
  return instance
}
const flush = () => new Promise(resolve => setImmediate(resolve))

async function main() {
  const editor = page()
  editor.openAddEvent()
  editor.selectCustomMood()
  editor.onCustomMoodInput({ detail: ' 想一起看日落 🌅 ' })
  editor.data.eventFormTitle = '今天'
  response = () => Promise.resolve({ event: { id: 7, ...requested.options.data, createdAt: '2026-09-07 12:34:56', updatedBy: 1, updatedByName: '伴侣 A', updatedAt: '2026-09-07 12:34:56' } })
  editor.saveEvent()
  await flush()
  assert.equal(requested.options.data.mood, '想一起看日落 🌅')
  assert.equal(editor.data.events[0].recordTimeLabel, '2026年9月7日 12:34')
  assert.equal(editor.data.events[0].editorLabel, '最后编辑：伴侣 A')
  assert.equal(editor.data.events[0].updatedTimeLabel, '2026年9月7日 12:34')
  editor.openEditEvent({ currentTarget: { dataset: { id: 7 } } })
  assert.equal(editor.data.customMoodSelected, true)
  assert.equal(editor.data.customMood, '想一起看日落 🌅')
  editor.selectMood({ currentTarget: { dataset: { mood: '😊' } } })
  assert.equal(editor.data.customMoodSelected, false)
  response = () => Promise.resolve({ event: { id: 7, ...requested.options.data, updatedBy: 2, updatedByName: '伴侣 B', updatedAt: '2026-09-07 13:00:00' } })
  editor.saveEvent()
  await flush()
  assert.equal(editor.data.events[0].createdAt, '2026-09-07 12:34:56')
  assert.equal(editor.data.events[0].editorLabel, '最后编辑：伴侣 B')
  assert.equal(editor.data.events[0].updatedTimeLabel, '2026年9月7日 13:00')
  assert.equal(requested.options.data.updatedBy, undefined)

  editor.openAddEvent()
  editor.selectCustomMood()
  editor.saveEvent()
  assert.equal(toast, '请输入自定义心情')
  editor.data.customMood = '心'.repeat(17)
  editor.saveEvent()
  assert.equal(toast, '心情最多16个字符')

  storage.couple_space_calendar_events = [
    { id: 7, eventDate: '2026-09-07', mood: '旧缓存', createdAt: '' },
    { id: 'local-1', eventDate: '2026-09-07', mood: '未同步', localOnly: true }
  ]
  response = () => Promise.resolve({ events: [{ id: 7, eventDate: '2026-09-07', mood: '新心情', createdAt: '2026-09-07 12:34:56' }] })
  editor.loadEvents()
  await flush()
  assert.equal(editor.data.events.find(item => item.id === '7').mood, '新心情')
  assert.equal(editor.data.events.length, 2)
  assert.equal(editor.data.events.find(item => item.id === '7').editorLabel, '历史编辑者未记录')

  editor.openAddEvent()
  editor.data.eventFormTitle = '离线日记'
  response = () => Promise.reject(new Error('timeout'))
  editor.saveEvent()
  await flush()
  const offline = editor.data.events.find(item => item.title === '离线日记')
  assert.equal(offline.localOnly, true)
  assert.ok(offline.createdAt)
  assert.notEqual(offline.recordTimeLabel, '时间未记录')
  console.log('Calendar tests passed: time zones, custom moods, edit timestamps, cache refresh, offline records.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
