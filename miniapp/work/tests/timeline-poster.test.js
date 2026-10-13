const assert = require('node:assert/strict')
const { layout, dimensions, collect } = require('../../services/timeline-poster')
async function main() {
  const content = '完整详情'.repeat(250)
  const plan = layout([{ date: '2026-09-07', time: '12:30', title: '纪念日', details: content, images: ['https://example.com/a.png'], videoUrl: 'https://example.com/a.mp4' }], (text, size) => Array.from(text).length * size)
  const text = plan.rows.filter(row => row.type === 'text').map(row => row.text).join('')
  assert.ok(text.includes(content), 'long details must not be truncated')
  assert.ok(text.includes('12:30'))
  assert.ok(text.includes('https://example.com/a.mp4'))
  assert.equal(plan.rows.filter(row => row.type === 'image').length, 1)
  assert.ok(plan.rows.every(row => row.y < plan.height))
  assert.equal(dimensions(6000).width, 750)
  assert.equal(dimensions(15000).height, 12000)
  assert.throws(() => dimensions(21000), /单张长图/)
  const calls = []
  const events = await collect(async (_, options) => {
    calls.push(options.data)
    return { events: Array.from({ length: calls.length === 1 ? 20 : 3 }, (_, i) => ({ id: options.data.offset + i })), hasMore: calls.length === 1 }
  }, '纪念', 'asc')
  assert.equal(events.length, 23)
  assert.deepEqual(calls.map(call => call.offset), [0, 20])
  assert.ok(calls.every(call => call.q === '纪念' && call.order === 'asc'))
  await assert.rejects(collect(async () => ({ events: [], hasMore: true }), '', 'desc'), /发生变化/)
  await assert.rejects(collect(async () => { throw new Error('请先登录') }, '', 'desc'), /请先登录/)
  await assert.rejects(collect(async () => ({}), '', 'desc', () => false), /已取消/)
  console.log('Timeline poster tests passed: complete text, single-image sizing, pagination, permissions and cancellation.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
