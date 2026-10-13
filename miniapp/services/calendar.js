// MySQL DATETIME values are Beijing wall time; ISO timestamps carry a zone.
function recordTimeLabel(value) {
  if (!value) return '时间未记录'
  const text = String(value).trim()
  const wallTime = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/)
  if (wallTime) return `${wallTime[1]}年${Number(wallTime[2])}月${Number(wallTime[3])}日 ${wallTime[4]}:${wallTime[5]}`
  const timestamp = Date.parse(text)
  if (Number.isNaN(timestamp) || !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)) return '时间未记录'
  const date = new Date(timestamp + 8 * 3600000)
  const pad = number => String(number).padStart(2, '0')
  return `${date.getUTCFullYear()}年${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`
}

module.exports = { recordTimeLabel }
