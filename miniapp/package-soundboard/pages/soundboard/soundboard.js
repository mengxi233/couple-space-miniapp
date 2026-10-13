const STORAGE_KEY = 'mengyu_soundboard_theme'
const AUDIO_CACHE_KEY = 'mengyu_soundboard_audio_cache_v1'
const AUDIO_CACHE_VERSION = '2026-09-30-2'
const MEDIA_BASE = require('../../../config').apiBaseUrl + '/media'

const PORTRAITS = [
  `${MEDIA_BASE}/soundboard-avatar-1.png`,
  `${MEDIA_BASE}/soundboard-avatar-2.png`,
  `${MEDIA_BASE}/soundboard-avatar-3.png`,
  `${MEDIA_BASE}/soundboard-avatar-4.png`
]

const TRACKS = Array.from({ length: 6 }, (_, index) => ({
  key: `track-${index + 1}`,
  title: `曲目 ${index + 1}`,
  audio: `${MEDIA_BASE}/soundboard-${index + 1}.mp3?v=${AUDIO_CACHE_VERSION}`
}))

const THEMES = {
  male: {
    key: 'male', name: '重生之我是男主', badge: 'BGM 音乐挂件',
    portraits: PORTRAITS.slice(0, 2)
  },
  female: {
    key: 'female', name: '重生之我是女主', badge: 'BGM 音乐挂件',
    portraits: PORTRAITS.slice(2, 4)
  }
}

function buildTheme(key) {
  return THEMES[key] || THEMES.male
}

function formatTime(seconds) {
  const value = Number.isFinite(Number(seconds)) ? Math.max(0, Math.floor(Number(seconds))) : 0
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}

Page({
  data: {
    themeKey: 'male', theme: buildTheme('male'), tracks: TRACKS,
    currentIndex: -1, currentTrack: { title: '选择一首音乐' },
    playing: false, loading: false, progress: 0, currentTime: 0, duration: 0,
    currentTimeText: '0:00', durationText: '0:00', cacheText: '正在准备音乐 0/6'
  },

  onLoad(query = {}) {
    let stored = ''
    try { stored = wx.getStorageSync(STORAGE_KEY) } catch (_) {}
    const themeKey = THEMES[query.theme] ? query.theme : (THEMES[stored] ? stored : 'male')
    this.setData({ themeKey, theme: buildTheme(themeKey) })
    this.pageActive = true
    this.createPlayer()
    this.initAudioCache()
  },

  initAudioCache() {
    if (typeof wx.getFileSystemManager !== 'function' || typeof wx.downloadFile !== 'function') {
      this.setData({ cacheText: '点击圆键在线播放' })
      return
    }
    this.fileSystem = wx.getFileSystemManager()
    this.cachedAudio = {}
    let manifest = {}
    try { manifest = wx.getStorageSync(AUDIO_CACHE_KEY) || {} } catch (_) {}
    if (manifest.version !== AUDIO_CACHE_VERSION || !manifest.files) {
      this.removeStaleCache(manifest.files)
      manifest = { version: AUDIO_CACHE_VERSION, files: {} }
    }
    this.cacheManifest = manifest

    Promise.all(TRACKS.map(track => this.restoreCachedTrack(track))).then(results => {
      const missing = []
      results.forEach((cachedPath, index) => {
        const track = TRACKS[index]
        if (cachedPath) this.cachedAudio[track.key] = cachedPath
        else missing.push(track)
      })
      this.updateCacheText()
      if (missing.length) this.startCacheWorkers(missing)
    })
  },

  removeStaleCache(files) {
    if (!files || !this.fileSystem) return
    Object.keys(files).forEach(key => {
      const path = files[key] && files[key].path
      if (path) this.fileSystem.unlink({ filePath: path, fail: () => {} })
    })
  },

  restoreCachedTrack(track) {
    const entry = this.cacheManifest.files[track.key]
    if (!entry || entry.url !== track.audio || !entry.path) return Promise.resolve('')
    return new Promise(resolve => {
      this.fileSystem.access({ path: entry.path, success: () => resolve(entry.path), fail: () => resolve('') })
    })
  },

  startCacheWorkers(tracks) {
    const queue = tracks.slice()
    const worker = () => {
      const track = queue.shift()
      if (!track) return Promise.resolve()
      return this.cacheTrack(track).catch(() => {}).then(worker)
    }
    worker().then(() => this.updateCacheText())
  },

  cacheTrack(track) {
    return new Promise((resolve, reject) => {
      wx.downloadFile({
        url: track.audio,
        timeout: 120000,
        success: response => {
          if (response.statusCode !== 200 || !response.tempFilePath) return reject(new Error('download failed'))
          this.fileSystem.saveFile({
            tempFilePath: response.tempFilePath,
            success: saved => {
              this.cachedAudio[track.key] = saved.savedFilePath
              this.cacheManifest.files[track.key] = { url: track.audio, path: saved.savedFilePath }
              try { wx.setStorageSync(AUDIO_CACHE_KEY, this.cacheManifest) } catch (_) {}
              this.updateCacheText()
              resolve(saved.savedFilePath)
            },
            fail: reject
          })
        },
        fail: reject
      })
    })
  },

  updateCacheText() {
    const count = Object.keys(this.cachedAudio || {}).length
    const cacheText = count >= TRACKS.length ? '音乐已缓存，点击圆键播放' : `后台缓存音乐 ${count}/${TRACKS.length}`
    if (this.pageActive) this.setData({ cacheText })
  },

  createPlayer() {
    if (this.player || typeof wx.createInnerAudioContext !== 'function') return
    const player = wx.createInnerAudioContext()
    player.autoplay = false
    player.loop = false
    player.obeyMuteSwitch = false
    player.onCanplay(() => this.syncDuration())
    player.onPlay(() => this.setData({ playing: true, loading: false }))
    player.onPause(() => this.setData({ playing: false, loading: false }))
    player.onStop(() => this.setData({ playing: false, loading: false }))
    player.onTimeUpdate(() => this.syncProgress())
    player.onEnded(() => this.nextTrack())
    player.onError(() => {
      this.setData({ playing: false, loading: false })
      wx.showToast({ title: '音乐加载失败，请稍后重试', icon: 'none' })
    })
    this.player = player
  },

  syncDuration() {
    if (!this.player) return
    const duration = Number(this.player.duration) || this.data.duration || 0
    this.setData({ duration, durationText: formatTime(duration), loading: false })
  },

  syncProgress() {
    if (!this.player) return
    const currentTime = Number(this.player.currentTime) || 0
    const duration = Number(this.player.duration) || this.data.duration || 0
    this.setData({
      currentTime, duration,
      progress: duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0,
      currentTimeText: formatTime(currentTime), durationText: formatTime(duration)
    })
  },

  switchTheme(event) {
    const themeKey = event.currentTarget.dataset.theme
    if (!THEMES[themeKey] || themeKey === this.data.themeKey) return
    try { wx.setStorageSync(STORAGE_KEY, themeKey) } catch (_) {}
    this.setData({ themeKey, theme: buildTheme(themeKey) })
  },

  playTrack(event) {
    this.selectTrack(Number(event.currentTarget.dataset.index), true)
  },

  selectTrack(index, autoplay) {
    const normalized = (index + TRACKS.length) % TRACKS.length
    const track = TRACKS[normalized]
    this.createPlayer()
    if (!this.player) return wx.showToast({ title: '当前微信版本暂不支持音频播放', icon: 'none' })
    try { this.player.stop() } catch (_) {}
    this.player.src = (this.cachedAudio && this.cachedAudio[track.key]) || track.audio
    this.setData({
      currentIndex: normalized, currentTrack: track, playing: false, loading: Boolean(autoplay),
      progress: 0, currentTime: 0, duration: 0, currentTimeText: '0:00', durationText: '0:00'
    })
    if (autoplay) {
      try { wx.vibrateShort({ type: 'light' }) } catch (_) {}
      this.player.play()
    }
  },

  togglePlayback() {
    if (this.data.currentIndex < 0) return this.selectTrack(0, true)
    if (!this.player) return
    if (this.data.playing) this.player.pause()
    else {
      this.setData({ loading: true })
      this.player.play()
    }
  },

  previousTrack() {
    this.selectTrack(this.data.currentIndex < 0 ? TRACKS.length - 1 : this.data.currentIndex - 1, true)
  },

  nextTrack() {
    this.selectTrack(this.data.currentIndex < 0 ? 0 : this.data.currentIndex + 1, true)
  },

  seek(event) {
    if (!this.player || this.data.currentIndex < 0 || !this.data.duration) return
    const progress = Number(event.detail.value) || 0
    this.player.seek(this.data.duration * progress / 100)
    this.setData({ progress })
  },

  back() {
    if (getCurrentPages().length > 1) wx.navigateBack()
    else wx.reLaunch({ url: '/pages/apps/apps' })
  },

  onShareAppMessage() {
    return {
      title: `${this.data.theme.name}｜六键音乐挂件`,
      path: `/package-soundboard/pages/soundboard/soundboard?theme=${this.data.themeKey}`,
      imageUrl: this.data.theme.portraits[0]
    }
  },

  onHide() {
    if (this.player) {
      try { this.player.pause() } catch (_) {}
    }
  },

  onUnload() {
    this.pageActive = false
    if (this.player) {
      try { this.player.destroy() } catch (_) {}
      this.player = null
    }
  }
})

module.exports = { buildTheme, formatTime, THEMES, TRACKS }
