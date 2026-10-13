const app = getApp()

function toRequestError(error, fallback) {
  if (error instanceof Error) return error
  let message = typeof error === 'string'
    ? error
    : (error && (error.message || error.errMsg))
  if (/<(?:!doctype|html|head|body)\b/i.test(message || '')) message = fallback || '服务器暂时异常，请稍后重试'
  if (/timeout/i.test(message || '')) message = '服务器响应超时，请稍后重试'
  else if (/request:fail/i.test(message || '')) message = '网络连接失败，请检查网络后重试'
  const normalized = new Error(message || fallback)
  if (error && error.statusCode) normalized.statusCode = error.statusCode
  return normalized
}

function request(path, options = {}) {
  const token = app.globalData.token || wx.getStorageSync('couple_token')
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.apiBaseUrl}${path}`,
      method: options.method || 'GET',
      data: options.data || {},
      timeout: options.timeout || 12000,
      header: { ...(options.header || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success: res => res.statusCode >= 200 && res.statusCode < 300
        ? resolve(res.data)
        : reject(toRequestError({ ...(res.data || {}), statusCode: res.statusCode }, `请求失败（${res.statusCode}）`)),
      fail: error => reject(toRequestError(error, '网络请求失败，请稍后重试'))
    })
  })
}

function upload(path, filePath, options = {}) {
  const token = app.globalData.token || wx.getStorageSync('couple_token')
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${app.globalData.apiBaseUrl}${path}`,
      filePath,
      name: options.name || 'file',
      timeout: options.timeout || 30000,
      formData: options.formData || {},
      header: { ...(options.header || {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      success: response => {
        let data = response.data
        try { data = JSON.parse(response.data) } catch (error) {}
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(data)
        else reject(toRequestError(typeof data === 'object' && data ? { ...data, statusCode: response.statusCode } : { message: data, statusCode: response.statusCode }, `上传失败（${response.statusCode}），请稍后重试`))
      },
      fail: error => reject(toRequestError(error, '上传失败，请检查网络后重试'))
    })
  })
}

module.exports = { request, upload }
