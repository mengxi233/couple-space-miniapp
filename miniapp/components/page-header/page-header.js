const { headerLayout } = require('../../services/header-layout')
Component({
  options: { multipleSlots: true },
  properties: { title: String, eyebrow: String, subtitle: String, backLabel: String },
  data: headerLayout(),
  lifetimes: { attached() { this.measure() } },
  pageLifetimes: { resize() { this.measure() } },
  methods: {
    measure() { let info = {}, capsule = {}; try { info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); capsule = wx.getMenuButtonBoundingClientRect() } catch (_) {} this.setData(headerLayout(info, capsule)) },
    back() { this.triggerEvent('back') }
  }
})
