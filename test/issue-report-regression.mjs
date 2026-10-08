import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ISSUE_REPOSITORY,
  createIssuePreview,
  submitIssueReport,
  validateIssueReport,
} from '../bridge/report-issue.mjs'

const report = {
  title: '器件移动后位置读取不一致',
  pluginVersion: '0.10.87',
  edaVersion: '未知',
  os: 'Windows 11',
  steps: '1. 打开工程\n2. 移动器件',
  expected: '返回新位置',
  actual: '仍返回旧位置',
}

assert.equal(validateIssueReport(report), report)

const preview = createIssuePreview(report)
assert.deepEqual(Object.keys(preview), ['repository', 'title', 'body'])
assert.equal(preview.repository, 'quhuii-lgtm/easyeda-aicommand')
assert.equal(preview.repository, ISSUE_REPOSITORY)
assert.equal(preview.title, report.title)
assert.match(preview.body, /^由 AI 按统一格式整理并提交的插件问题记录。/)
assert.ok(!preview.body.includes('确认内容适合公开'))
for (const heading of ['插件版本', 'EDA 版本', '操作系统', '复现步骤', '预期结果', '实际结果']) {
  assert.ok(preview.body.includes(`## ${heading}\n`), `missing heading ${heading}`)
}
assert.ok(!preview.body.includes('## 相关指令'))
assert.ok(!preview.body.includes('## 必要证据'))

const optionalPreview = createIssuePreview({
  ...report,
  command: 'schematic.move',
  evidence: '位置读回 JSON',
})
assert.ok(optionalPreview.body.includes('## 相关指令\nschematic.move'))
assert.ok(optionalPreview.body.includes('## 必要证据\n位置读回 JSON'))

const preserved = {
  ...report,
  title: ' 标题两侧空格 ',
  os: 'Windows\r\n自定义版本',
  steps: '首行\n第二行',
}
const preservedPreview = createIssuePreview(preserved)
assert.equal(preservedPreview.title, preserved.title)
assert.ok(preservedPreview.body.includes(`## 操作系统\n${preserved.os}`))
assert.ok(preservedPreview.body.includes(`## 复现步骤\n${preserved.steps}`))

assert.throws(() => validateIssueReport(null), /必须是 JSON 对象/)
assert.throws(() => validateIssueReport([]), /必须是 JSON 对象/)
assert.throws(() => validateIssueReport({ ...report, actual: ' \n\t' }), /actual 必须是非空字符串/)
assert.throws(() => validateIssueReport({ ...report, evidence: 42 }), /evidence 必须是字符串/)
assert.throws(() => validateIssueReport({ ...report, command: null }), /command 必须是字符串/)
assert.throws(() => validateIssueReport({ ...report, 'ghp_secret_unknown_key': 'ignored?' }), (error) => {
  assert.match(error.message, /不支持的字段/)
  assert.ok(!error.message.includes('ghp_secret_unknown_key'))
  assert.ok(!error.message.includes('ghp_secret'))
  return true
})
const missingTitle = { ...report }
delete missingTitle.title
assert.throws(() => validateIssueReport(missingTitle), /title 必须是非空字符串/)

const issueNumber = 417
const issueUrl = `https://github.com/${ISSUE_REPOSITORY}/issues/${issueNumber}`
const issueResponse = {
  number: issueNumber,
  title: preview.title,
  body: preview.body,
  html_url: issueUrl,
  repository_url: `https://api.github.com/repos/${ISSUE_REPOSITORY}`,
}

function fakeRunner(responses, calls = []) {
  return (args, options) => {
    calls.push({ args, options })
    const response = responses.shift()
    assert.ok(response, 'unexpected gh invocation')
    return typeof response === 'function' ? response(args, options) : response
  }
}

const successfulCalls = []
const successfulResult = await submitIssueReport(report, {
  ghRunner: fakeRunner([
    { status: 0, stdout: '', stderr: '' },
    { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
    { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
  ], successfulCalls),
})
assert.deepEqual(successfulResult, {
  repository: ISSUE_REPOSITORY,
  number: issueNumber,
  url: issueUrl,
  title: report.title,
})
assert.equal(successfulCalls.length, 3)
assert.deepEqual(successfulCalls[0].args, ['auth', 'status', '--hostname', 'github.com'])
assert.equal(successfulCalls[0].options.env.GH_PROMPT_DISABLED, '1')
assert.deepEqual(successfulCalls[1].args, [
  'api', '--hostname', 'github.com', '--method', 'POST', `/repos/${ISSUE_REPOSITORY}/issues`, '--input', '-',
])
assert.deepEqual(JSON.parse(successfulCalls[1].options.input), {
  title: preview.title,
  body: preview.body,
})
assert.deepEqual(successfulCalls[2].args, [
  'api', '--hostname', 'github.com', '--method', 'GET', `/repos/${ISSUE_REPOSITORY}/issues/${issueNumber}`,
])

for (const [responses, expectedCode] of [
  [[{ status: 1, stderr: 'not logged in to github.com; token=ghp_secret_should_not_print' }], 'GH_NOT_AUTHENTICATED'],
  [[{ status: null, error: { code: 'ENOENT' } }], 'GH_NOT_INSTALLED'],
]) {
  const calls = []
  await assert.rejects(
    submitIssueReport(report, { ghRunner: fakeRunner(responses, calls) }),
    (error) => {
      assert.equal(error.code, expectedCode)
      assert.ok(!error.message.includes('ghp_secret_should_not_print'))
      return true
    },
  )
  assert.equal(calls.length, 1)
}

const invalidCalls = []
await assert.rejects(
  submitIssueReport({ ...report, actual: '  ' }, { ghRunner: fakeRunner([], invalidCalls) }),
  /actual 必须是非空字符串/,
)
assert.equal(invalidCalls.length, 0)

const refusalCalls = []
await assert.rejects(
  submitIssueReport(report, {
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: 1, stderr: 'gh: Validation Failed; private=ghp_hidden\ngh: Validation Failed (HTTP 422)' },
    ], refusalCalls),
  }),
  (error) => {
    assert.equal(error.code, 'ISSUE_REJECTED')
    assert.ok(!error.message.includes('ghp_hidden'))
    return true
  },
)
assert.equal(refusalCalls.length, 2)

const misleadingResponseCalls = []
await assert.rejects(
  submitIssueReport(report, {
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: 1, stdout: 'Report text mentioned (HTTP 403), but no structured gh error was returned.', stderr: 'gh: request failed' },
    ], misleadingResponseCalls),
  }),
  (error) => error.code === 'ISSUE_CREATE_UNKNOWN',
)
assert.equal(misleadingResponseCalls.length, 2)

const uncertainCalls = []
await assert.rejects(
  submitIssueReport(report, {
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: null, error: { code: 'ETIMEDOUT' }, stderr: 'private=ghp_hidden' },
    ], uncertainCalls),
  }),
  (error) => {
    assert.equal(error.code, 'ISSUE_CREATE_UNKNOWN')
    assert.match(error.message, /可能已经创建/)
    assert.ok(!error.message.includes('ghp_hidden'))
    return true
  },
)
assert.equal(uncertainCalls.length, 2)

const readbackCalls = []
await assert.rejects(
  submitIssueReport(report, {
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
      { status: 1, stderr: 'private=ghp_hidden' },
    ], readbackCalls),
  }),
  (error) => {
    assert.equal(error.code, 'ISSUE_CREATED_READBACK_FAILED')
    assert.ok(error.message.includes(issueUrl))
    assert.ok(!error.message.includes('ghp_hidden'))
    return true
  },
)
assert.equal(readbackCalls.length, 3)

const mismatchCalls = []
await assert.rejects(
  submitIssueReport(report, {
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
      { status: 0, stdout: JSON.stringify({ ...issueResponse, body: 'unexpected' }), stderr: '' },
    ], mismatchCalls),
  }),
  (error) => error.code === 'ISSUE_CREATED_READBACK_FAILED' && error.message.includes(issueUrl),
)
assert.equal(mismatchCalls.length, 3)

const temporaryDirectory = mkdtempSync(join(tmpdir(), 'issue-report-'))
try {
  const reportFile = join(temporaryDirectory, 'report.json')
  writeFileSync(reportFile, `\uFEFF${JSON.stringify(report)}`, 'utf8')
  const scriptPath = fileURLToPath(new URL('../bridge/report-issue.mjs', import.meta.url))
  const cliPreview = spawnSync(process.execPath, [scriptPath, 'preview', '--file', reportFile], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(cliPreview.status, 0, cliPreview.stderr)
  assert.deepEqual(JSON.parse(cliPreview.stdout), preview)

  const cliInvalid = spawnSync(process.execPath, [scriptPath, 'submit', '--file', reportFile, '--confirmed-sha256', 'x'], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(cliInvalid.status, 1)
  assert.equal(cliInvalid.stdout, '')
  assert.deepEqual(JSON.parse(cliInvalid.stderr), {
    error: { code: 'CLI_USAGE', message: '用法：node bridge/report-issue.mjs preview|submit --file report.json' },
  })

  writeFileSync(reportFile, JSON.stringify({ ...report, 'ghp_secret_unknown_key': 'private content' }), 'utf8')
  const cliInvalidReport = spawnSync(process.execPath, [scriptPath, 'preview', '--file', reportFile], {
    encoding: 'utf8',
    shell: false,
  })
  assert.equal(cliInvalidReport.status, 1)
  const cliInvalidResult = JSON.parse(cliInvalidReport.stderr)
  assert.equal(cliInvalidResult.error.code, 'REPORT_INVALID')
  assert.ok(!cliInvalidReport.stderr.includes('ghp_secret'))

  writeFileSync(reportFile, `\uFEFF${JSON.stringify(report)}`, 'utf8')

  const cliOutput = { value: '' }
  const cliErrors = { value: '' }
  const cliCalls = []
  const write = (target) => ({ write(value) { target.value += value } })
  const { main } = await import('../bridge/report-issue.mjs')
  const cliStatus = await main(['submit', '--file', reportFile], {
    stdout: write(cliOutput),
    stderr: write(cliErrors),
    ghRunner: fakeRunner([
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
      { status: 0, stdout: JSON.stringify(issueResponse), stderr: '' },
    ], cliCalls),
  })
  assert.equal(cliStatus, 0)
  assert.equal(cliErrors.value, '')
  assert.equal(JSON.parse(cliOutput.value).url, issueUrl)
  assert.equal(cliCalls.length, 3)
}
finally {
  rmSync(temporaryDirectory, { recursive: true, force: true })
}

console.log('issue-report-regression: passed')
