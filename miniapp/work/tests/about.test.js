const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const releaseInfo = require('../../services/release-notes')

const { currentVersion, releases, appInfo } = releaseInfo
assert.equal(currentVersion, JSON.parse(fs.readFileSync('package.json')).version, 'update package.json and release notes together')
const lock = JSON.parse(fs.readFileSync('package-lock.json'))
assert.equal(currentVersion, lock.version)
assert.equal(currentVersion, lock.packages[''].version)
assert.equal(currentVersion, releases[0].version)
assert.equal(new Set(releases.map(item => item.version)).size, releases.length)
assert.ok(fs.existsSync('.'+appInfo.icon), 'reuse a bundled app icon, no network dependency')
assert.ok(!appInfo.icon.includes('/avatars/'), 'app icon must not be a user avatar')
for (let i = 0; i < releases.length; i++) {
  const item = releases[i]
  assert.match(item.version, /^\d+\.\d+\.\d+$/)
  assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/)
  assert.ok(item.title && item.summary && Array.isArray(item.added) && Array.isArray(item.fixed))
  assert.ok(item.added.every(text => typeof text === 'string' && text.trim()))
  if (i) assert.ok(releases[i-1].version.localeCompare(item.version, undefined, { numeric: true }) > 0)
}

let navigation, calls = [], definition
const app = { globalData: {} }
const wx = { getStorageSync: () => '', navigateTo: value => { navigation = value.url }, showToast() {}, removeStorageSync() {} }
function loadPage(path) {
  vm.runInNewContext(fs.readFileSync(path,'utf8'), {
    Page: value => { definition = value }, getApp: () => app, wx,
    require: name => name.endsWith('/release-notes') ? releaseInfo
      : name.endsWith('/config') ? require('../../config')
      : { request: path => { calls.push(path); return Promise.resolve({}) } }
  })
  return { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data,value) } }
}
const profile = loadPage('pages/profile/profile.js')
profile.onShow()
assert.equal(profile.data.loggedIn, false)
assert.equal(profile.data.currentVersion, currentVersion)
profile.openAbout()
assert.equal(navigation, '/pages/about/about', 'about is available to guests')
app.globalData = { token: 'test-session', user: { role: 'member' } }
profile.onShow()
assert.equal(profile.data.loggedIn, true)
assert.ok(!calls.includes('/points'))
assert.equal(profile.loadPoints, undefined)
const about = loadPage('pages/about/about.js')
assert.equal(about.data.currentVersion, profile.data.currentVersion)
about.openFeatures()
assert.equal(navigation, '/pages/releases/releases')
const history = loadPage('pages/releases/releases.js')
assert.equal(history.data.releases.length, releases.length)
assert.equal(history.data.currentVersion, currentVersion)
assert.equal(calls.filter(path => path.includes('releases')).length, 0, 'history must work offline')

const pages = JSON.parse(fs.readFileSync('app.json')).pages
assert.ok(pages.includes('pages/about/about'))
assert.ok(pages.includes('pages/releases/releases'))
const filingHosts = []
for (const page of pages) {
  for (const ext of ['.wxml','.wxss','.js','.json']) assert.ok(fs.existsSync(page+ext), page+ext)
  const template = fs.readFileSync(page+'.wxml','utf8')
  if (template.includes('<legal-footer')) filingHosts.push(page)
  if (page !== 'pages/about/about') assert.ok(!/鄂ICP备|beian\.miit\.gov\.cn/.test(template), 'filing only belongs on about')
}
assert.deepEqual(filingHosts, ['pages/about/about'])
for (const name of ['about','releases']) {
  const config = JSON.parse(fs.readFileSync(`pages/${name}/${name}.json`))
  assert.equal(config.navigationStyle,'default', 'native back and capsule safe area')
}
for (const ext of ['js','wxml','wxss']) assert.ok(!/points|积分/.test(fs.readFileSync('pages/profile/profile.'+ext,'utf8')))
assert.ok(fs.readFileSync('pages/releases/releases.wxml','utf8').includes('wx:key="version"'))
const aboutTemplate = fs.readFileSync('pages/about/about.wxml','utf8')
const aboutStyle = fs.readFileSync('pages/about/about.wxss','utf8')
assert.ok(!/<button\b/.test(aboutTemplate), 'navigation row must not inherit the v2 native button width/weight')
assert.ok(aboutTemplate.includes('class="row-trailing"'))
assert.ok(aboutTemplate.includes('>更新记录</text>'))
assert.match(aboutStyle, /\.row-detail\{[^}]*white-space:nowrap/)
assert.match(aboutStyle, /\.row-detail\{[^}]*text-overflow:ellipsis/)
assert.match(aboutStyle, /\.row-label\{[^}]*font-weight:400/)
console.log('About tests passed: version consistency, offline history, guest access, no profile points, filing only on About, page packaging.')
