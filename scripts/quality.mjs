import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const maximumLines = 500
const maximumCrap = 30
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.css', '.html'])
const codeExtensions = new Set(['.ts', '.tsx', '.js', '.mjs'])

async function filesBelow(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...await filesBelow(path))
    else if (sourceExtensions.has(extname(entry.name))) output.push(path)
  }
  return output
}

function functionName(node, sourceFile) {
  if (node.name?.getText) return node.name.getText(sourceFile)
  if (ts.isVariableDeclaration(node.parent)) return node.parent.name.getText(sourceFile)
  if (ts.isPropertyAssignment(node.parent)) return node.parent.name.getText(sourceFile)
  return '<anonymous>'
}

function complexityOf(node) {
  let complexity = 1
  const visit = (child) => {
    if (child !== node && ts.isFunctionLike(child)) return
    if (
      ts.isIfStatement(child)
      || ts.isForStatement(child)
      || ts.isForInStatement(child)
      || ts.isForOfStatement(child)
      || ts.isWhileStatement(child)
      || ts.isDoStatement(child)
      || ts.isCatchClause(child)
      || ts.isConditionalExpression(child)
      || (ts.isCaseClause(child) && child.parent.clauses[0] !== child)
      || (ts.isBinaryExpression(child) && ['&&', '||', '??'].includes(child.operatorToken.getText()))
    ) complexity += 1
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return complexity
}

function coverageFor(node, sourceFile, coverage) {
  if (!coverage) return 0
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  const entries = Object.entries(coverage.fnMap).filter(([, item]) => item.decl.start.line === start.line + 1)
  if (!entries.length) return 0
  const covered = entries.filter(([id]) => coverage.f[id] > 0).length
  return covered / entries.length
}

function functionsIn(path, text, coverage) {
  const kind = path.endsWith('x') ? ts.ScriptKind.TSX : path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind)
  const output = []
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      const complexity = complexityOf(node)
      const covered = coverageFor(node, sourceFile, coverage)
      const crap = complexity ** 2 * (1 - covered) ** 3 + complexity
      output.push({
        name: functionName(node, sourceFile),
        line: position.line + 1,
        complexity,
        coverage: covered * 100,
        crap
      })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return output
}

const appFiles = await filesBelow(resolve(root, 'src'))
const sourceFiles = [
  ...appFiles,
  ...await filesBelow(resolve(root, 'scripts')),
  ...await filesBelow(resolve(root, 'tests'))
]
const lineCounts = await Promise.all(sourceFiles.map(async (path) => ({
  path,
  lines: (await readFile(path, 'utf8')).split(/\r?\n/).length
})))
const largest = lineCounts.toSorted((a, b) => b.lines - a.lines)[0]
const oversized = lineCounts.filter(({ lines }) => lines > maximumLines)

let coverageData = {}
try {
  coverageData = JSON.parse(await readFile(resolve(root, 'coverage/coverage-final.json'), 'utf8'))
} catch {
  // Missing coverage is deliberately treated as zero coverage below.
}

const metrics = []
for (const path of appFiles.filter((file) => codeExtensions.has(extname(file)) && !/\.(test|spec)\.[^.]+$/.test(file))) {
  const text = await readFile(path, 'utf8')
  const coverage = coverageData[resolve(path)]
  for (const metric of functionsIn(path, text, coverage)) metrics.push({ ...metric, path })
}
const worst = metrics.toSorted((a, b) => b.crap - a.crap)[0]
const excessiveCrap = metrics.filter(({ crap }) => crap > maximumCrap + Number.EPSILON)

process.stdout.write('\nMaintainability\n')
if (oversized.length) {
  process.stderr.write(`  ✖ Source files are at most ${maximumLines} lines\n`)
  for (const item of oversized) process.stderr.write(`    ${relative(root, item.path)}: ${item.lines} lines\n`)
} else {
  process.stdout.write(`  ✔ Source files are at most ${maximumLines} lines (largest: ${relative(root, largest.path)}, ${largest.lines})\n`)
}

if (excessiveCrap.length) {
  process.stderr.write(`  ✖ Every function has CRAP ≤ ${maximumCrap}\n`)
  for (const item of excessiveCrap.toSorted((a, b) => b.crap - a.crap)) {
    process.stderr.write(`    ${relative(root, item.path)}:${item.line} ${item.name}: CRAP ${item.crap.toFixed(2)}, complexity ${item.complexity}, coverage ${item.coverage.toFixed(0)}%\n`)
  }
} else {
  process.stdout.write(`  ✔ Every function has CRAP ≤ ${maximumCrap} (worst: ${worst.crap.toFixed(2)} in ${relative(root, worst.path)}:${worst.line})\n`)
}

if (oversized.length || excessiveCrap.length) process.exitCode = 1
