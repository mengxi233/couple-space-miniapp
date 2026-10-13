function headerLayout(info = {}, capsule = {}) {
  const status = Number(info.statusBarHeight) || 24, width = Number(info.windowWidth) || 375
  const valid = capsule.top >= status && capsule.height > 0 && capsule.left > 0 && capsule.left < width
  const top = valid ? capsule.top : status + 8, height = valid ? capsule.height : 32
  return { top, height, right: valid ? width - capsule.left + 12 : 106 }
}
module.exports = { headerLayout }
