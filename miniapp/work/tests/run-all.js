const { readdirSync } = require('node:fs')
const { join } = require('node:path')
const { execFileSync } = require('node:child_process')

const directory = __dirname
const files = readdirSync(directory).filter(name => name.endsWith('.test.js')).sort()
for (const file of files) {
  process.stdout.write(`test ${file}\n`)
  execFileSync(process.execPath, [join(directory, file)], {
    cwd: join(directory, '..', '..'),
    stdio: 'inherit'
  })
}
process.stdout.write(`passed ${files.length} test files\n`)
