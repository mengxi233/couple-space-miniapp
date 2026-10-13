const assert = require('assert')

let pageDefinition
let played = 0
let paused = 0
let stopped = 0
let destroyed = 0
let stored = ''
let seeked = -1

const player = {
  src: '', duration: 100, currentTime: 25,
  onCanplay(callback) { this.canplay = callback },
  onPlay(callback) { this.didPlay = callback },
  onPause(callback) { this.didPause = callback },
  onStop(callback) { this.didStop = callback },
  onTimeUpdate(callback) { this.updated = callback },
  onEnded(callback) { this.ended = callback },
  onError(callback) { this.failed = callback },
  play() { played += 1 },
  pause() { paused += 1 },
  stop() { stopped += 1 },
  seek(value) { seeked = value },
  destroy() { destroyed += 1 }
}

global.Page = definition => { pageDefinition = definition }
global.getCurrentPages = () => [{}, {}]
global.wx = {
  getStorageSync: () => stored,
  setStorageSync: (_key, value) => { stored = value },
  createInnerAudioContext: () => player,
  vibrateShort() {}, showToast() {}, navigateBack() {}, reLaunch() {}
}

const helpers = require('../../package-soundboard/pages/soundboard/soundboard')
const page = Object.assign({}, pageDefinition, {
  data: JSON.parse(JSON.stringify(pageDefinition.data)),
  setData(update) { Object.assign(this.data, update) }
})

page.onLoad({ theme: 'female' })
assert.equal(page.data.themeKey, 'female')
assert.equal(page.data.tracks.length, 6)
assert.equal(helpers.TRACKS[0].audio, require('../../config').apiBaseUrl + '/media/soundboard-1.mp3?v=2026-09-30-2')
assert.equal(helpers.formatTime(164), '2:44')

page.cachedAudio = { 'track-3': 'wxfile://soundboard-3-cache.mp3' }
page.playTrack({ currentTarget: { dataset: { index: 2 } } })
assert.equal(played, 1)
assert.equal(page.data.currentIndex, 2)
assert.equal(player.src, 'wxfile://soundboard-3-cache.mp3')

player.didPlay()
assert.equal(page.data.playing, true)
player.updated()
assert.equal(page.data.progress, 25)
assert.equal(page.data.currentTimeText, '0:25')

page.seek({ detail: { value: 50 } })
assert.equal(seeked, 50)
page.togglePlayback()
assert.equal(paused, 1)

page.nextTrack()
assert.equal(page.data.currentIndex, 3)
page.previousTrack()
assert.equal(page.data.currentIndex, 2)

page.switchTheme({ currentTarget: { dataset: { theme: 'male' } } })
assert.equal(page.data.themeKey, 'male')
assert.equal(stored, 'male')
assert.match(page.onShareAppMessage().path, /theme=male/)

page.onUnload()
assert.equal(destroyed, 1)
assert.ok(stopped >= 3)
console.log('Soundboard tests passed: remote tracks, player progress, seeking, controls, themes and cleanup.')
