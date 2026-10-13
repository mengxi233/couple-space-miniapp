const base = require('../../config').apiBaseUrl + '/media/'
const defaults = {
  '/assets/previews/banner-1.jpg': ['banner-1.jpg', '0_1f34529efaa7aa3cce010454264570aa.png'],
  '/assets/previews/banner-2.jpg': ['banner-2.jpg', '0_eef319a5dcc4996508ee6ccf7efc5b19.jpg'],
  '/assets/previews/avatar-yu.jpg': ['avatar-yu.jpg', '0_0110e5e303dad5f2459e993c83b46e2d.jpg'],
  '/assets/previews/avatar-meng.jpg': ['avatar-meng.jpg', '0_28abad043a54cf7c09f624cc7acb973c.jpg']
}
Component({
  properties: { src: String, fallback: { type: String, value: '/assets/previews/avatar-yu.jpg' }, mode: { type: String, value: 'aspectFill' } },
  data: { preview: '', resources: [], ready: false },
  observers: {
    'src, fallback': function(src, fallback) {
      // Existing profiles may still contain the former bundled avatar paths.
      const normalized = (src || '').replace('/assets/avatars/', '/assets/previews/')
      const preset = defaults[normalized]
      const preview = preset ? '/assets/previews/' + preset[0] : fallback
      const full = preset ? base + preset[1] : src
      // A new keyed image prevents an old request's load/error from revealing a new source.
      const id = this.generation = (this.generation || 0) + 1
      this.setData({ preview, ready: false, resources: full ? [{ id, url: full }] : [] })
    }
  },
  methods: {
    loaded(e) { if (Number(e.currentTarget.dataset.id) === this.generation) this.setData({ ready: true }) },
    failed(e) { if (Number(e.currentTarget.dataset.id) === this.generation) this.setData({ ready: false }) }
  }
})
