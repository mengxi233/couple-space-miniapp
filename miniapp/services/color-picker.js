function channels(hex) { return /^#[0-9a-f]{6}$/i.test(hex) ? [1,3,5].map(start=>parseInt(hex.slice(start,start+2),16)) : [255,255,255] }
function hex(values) { return '#' + values.map(value=>Math.max(0,Math.min(255,Math.round(Number(value)||0))).toString(16).padStart(2,'0')).join('') }
module.exports = { channels, hex }
