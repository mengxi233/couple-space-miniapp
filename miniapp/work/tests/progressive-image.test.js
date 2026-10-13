const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
let component
vm.runInNewContext(fs.readFileSync('components/progressive-image/progressive-image.js','utf8'), { Component: value => { component = value }, require: () => require('../../config') })
const instance = { data: {}, setData(patch) { Object.assign(this.data,patch) } }
const change = component.observers['src, fallback']
change.call(instance, '/assets/previews/banner-1.jpg', '/assets/previews/avatar-yu.jpg')
assert.equal(instance.data.preview, '/assets/previews/banner-1.jpg')
assert.equal(instance.data.ready, false)
const first = instance.generation
component.methods.loaded.call(instance, {currentTarget:{dataset:{id:first}}})
assert.equal(instance.data.ready,true)
change.call(instance,'https://example.com/second.jpg','/assets/previews/banner-2.jpg')
component.methods.loaded.call(instance, {currentTarget:{dataset:{id:first}}})
assert.equal(instance.data.ready,false, 'old response must not reveal new image')
component.methods.failed.call(instance, {currentTarget:{dataset:{id:instance.generation}}})
assert.equal(instance.data.preview,'/assets/previews/banner-2.jpg')
for(const file of fs.readdirSync('assets/previews')) assert.ok(fs.statSync('assets/previews/'+file).size < 200*1024)
console.log('Progressive image tests passed: preview-first, load success, failure fallback, stale responses, image sizes.')
change.call(instance, '/assets/avatars/avatar-yu.jpg', '')
assert.equal(instance.data.preview, '/assets/previews/avatar-yu.jpg', 'legacy profile avatar must resolve without bundled originals')
const path = require('node:path')
const exclusions = JSON.parse(fs.readFileSync('project.config.json')).packOptions.ignore
let mediaBytes = 0
function scan(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name).replaceAll('\\', '/')
    if (exclusions.some(rule => file === rule.value || (rule.type === 'folder' && file.startsWith(rule.value + '/')))) continue
    if (entry.isDirectory()) scan(file)
    else if (/\.(png|jpe?g|gif|webp|mp3|wav|aac|ogg|m4a)$/i.test(file)) mediaBytes += fs.statSync(file).size
  }
}
scan('.')
assert.ok(mediaBytes < 200 * 1024, 'total packaged image/audio resources must stay below 200 KB')
console.log('Total packaged image/audio: ' + mediaBytes + ' bytes')
