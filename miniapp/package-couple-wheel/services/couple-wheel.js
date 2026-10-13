const { request } = require('../../services/api')
const base = '/wheel'
const guestKey = 'mengyu_couple_wheel_guest'
let guestToken = ''
let guestPending

async function guestHeader() {
  if (guestToken) return { 'X-Couple-Wheel-Guest': guestToken }
  if (!guestPending) guestPending = (async () => {
    let stored = ''
    try { stored = wx.getStorageSync(guestKey) || '' } catch (_) {}
    if (!/^[a-f0-9]{64}$/.test(stored)) {
      const result = await request(base + '/session', { method: 'POST' })
      stored = result.token
      if (!/^[a-f0-9]{64}$/.test(stored || '')) throw new Error('联机身份初始化失败')
      wx.setStorageSync(guestKey, stored)
    }
    guestToken = stored
    return stored
  })()
  try { return { 'X-Couple-Wheel-Guest': await guestPending } } finally { guestPending = null }
}

async function headers() { return guestHeader() }

module.exports = {
  access: () => request(base + '/access'),
  list: level => request(`${base}/questions`, { data: { level } }),
  create: async (level, name) => request(`${base}/rooms`, { method: 'POST', header: await headers(), data: { level, name } }),
  join: async (id, name) => request(`${base}/rooms/${encodeURIComponent(id)}/join`, { method: 'POST', header: await headers(), data: { name } }),
  room: async id => request(`${base}/rooms/${encodeURIComponent(id)}`, { header: await headers(), timeout: 7000 }),
  action: async (id, action, data = {}) => request(`${base}/rooms/${encodeURIComponent(id)}`, { method: 'POST', header: await headers(), data: { action, ...data } })
}
