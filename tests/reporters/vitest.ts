import type { Reporter, SerializedError, TestCase, TestModule, TestSuite, Vitest } from 'vitest/node'
import { resultSummary, statusMark, suiteName, testName } from './names'

function stateIcon(test: TestCase): string {
  const state = test.result().state
  return statusMark(state === 'passed' || state === 'failed' ? state : 'skipped')
}

export default class CompactReporter implements Reporter {
  private ctx!: Vitest
  private logs = new Map<string, string[]>()

  onInit(ctx: Vitest): void {
    this.ctx = ctx
  }

  onUserConsoleLog(log: Parameters<NonNullable<Reporter['onUserConsoleLog']>>[0]): void {
    if (!log.taskId) {
      if (log.content.trim()) process.stderr.write(log.content)
      return
    }
    const entries = this.logs.get(log.taskId) ?? []
    entries.push(log.content)
    this.logs.set(log.taskId, entries)
  }

  onTestRunEnd(modules: readonly TestModule[], unhandled: readonly SerializedError[]): void {
    let passed = 0, failed = 0, skipped = 0
    const failedIds = new Set<string>()
    const printErrors = (errors: readonly unknown[]): void => {
      failed += errors.length
      for (const error of errors) this.ctx.logger.printError(error)
    }
    for (const module of modules) {
      if (module.state() === 'failed') failedIds.add(module.id)
      printErrors(module.errors())
      for (const suite of module.children.allSuites()) {
        if (suite.errors().length) failedIds.add(suite.id)
        printErrors(suite.errors())
      }
      for (const test of module.children.allTests()) {
        const result = test.result()
        if (result.state === 'passed') passed += 1
        else if (result.state === 'failed') {
          failed += 1
          failedIds.add(test.id)
          for (const error of result.errors) this.ctx.logger.printError(error)
        } else skipped += 1
      }
    }
    printErrors(unhandled)
    for (const id of failedIds) {
      for (const content of this.logs.get(id) ?? []) {
        if (content.trim()) process.stderr.write(content.endsWith('\n') ? content : `${content}\n`)
      }
    }
    this.logs.clear()
    process.stdout.write(`${resultSummary(passed, failed, skipped)}\n`)
  }

  onTestModuleEnd(module: TestModule): void {
    const lines = [suiteName(module.relativeModuleId)]
    const children = module.children.array()
    const single = children.length === 1 ? children[0] : undefined
    this.printChildren(single?.type === 'suite' && testName(single.name) === lines[0] ? single.children.array() : children, 1, lines)
    process.stdout.write(`${lines.join('\n')}\n`)
  }

  private printChildren(children: (TestCase | TestSuite)[], depth: number, lines: string[]): void {
    for (const child of children) {
      const indentation = '  '.repeat(depth)
      if (child.type === 'test') lines.push(`${indentation}${stateIcon(child)} ${testName(child.name)}`)
      else {
        lines.push(`${indentation}${testName(child.name)}`)
        this.printChildren(child.children.array(), depth + 1, lines)
      }
    }
  }
}
