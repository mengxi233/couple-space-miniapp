const { request, upload } = require('../../services/api')

function uploadImages(files, onProgress) {
  const list = Array.isArray(files) ? files : [files]
  return list.reduce((chain, file, index) => chain.then(async urls => {
    const path = file && (file.url || file.path || file.tempFilePath)
    if (!path) return urls
    const result = await upload('/uploads/images', path)
    if (onProgress) onProgress(index + 1, list.length)
    return urls.concat(result.url || result.imageUrl)
  }), Promise.resolve([]))
}

module.exports = { request, uploadImages }
