const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const moduleMock = { exports: {} }
vm.runInNewContext(fs.readFileSync('services/api.js', 'utf8'), {
  module: moduleMock,
  getApp: () => ({ globalData: { apiBaseUrl: 'https://example.com', token: '' } }),
  wx: { getStorageSync: () => '', uploadFile: options => options.success({ statusCode: 500, data: '<!doctype html><html>Internal server error</html>' }) }
})
moduleMock.exports.upload('/uploads/avatars','test.jpg').then(() => { throw new Error('Expected rejection') }).catch(error => {
  assert.equal(error.statusCode, 500)
  assert.ok(!error.message.includes('<html>'))
  assert.ok(error.message.includes('500'))
  console.log('API error test passed: HTML suppressed, status retained.')
}).catch(error => { console.error(error); process.exitCode = 1 })
