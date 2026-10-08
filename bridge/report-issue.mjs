import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ISSUE_REPOSITORY = 'quhuii-lgtm/easyeda-aicommand'

const API_REPOSITORY = `https://api.github.com/repos/${ISSUE_REPOSITORY}`
const REQUIRED_FIELDS = Object.freeze([
  'title',
  'pluginVersion',
  'edaVersion',
  'os',
  'steps',
  'expected',
  'actual',
])
const OPTIONAL_FIELDS = Object.freeze(['command', 'evidence'])
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])

export class IssueReportError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IssueReportError'
    this.code = code
  }
}

function requireReportObject(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new TypeError('报告必须是 JSON 对象。')
  }

  for (const key of Object.keys(report)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new TypeError('报告包含不支持的字段。')
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (typeof report[key] !== 'string' || report[key].trim().length === 0) {
      throw new TypeError(`报告字段 ${key} 必须是非空字符串。`)
    }
  }

  for (const key of OPTIONAL_FIELDS) {
    if (Object.hasOwn(report, key) && typeof report[key] !== 'string') {
      throw new TypeError(`报告字段 ${key} 必须是字符串。`)
    }
  }

  return report
}

export function validateIssueReport(report) {
  return requireReportObject(report)
}

export function renderIssueBody(report) {
  requireReportObject(report)

  const sections = [
    '由 AI 按统一格式整理并提交的插件问题记录。',
    `## 插件版本\n${report.pluginVersion}`,
    `## EDA 版本\n${report.edaVersion}`,
    `## 操作系统\n${report.os}`,
    `## 复现步骤\n${report.steps}`,
    `## 预期结果\n${report.expected}`,
    `## 实际结果\n${report.actual}`,
  ]

  if (Object.hasOwn(report, 'command')) {
    sections.push(`## 相关指令\n${report.command}`)
  }

  if (Object.hasOwn(report, 'evidence')) {
    sections.push(`## 必要证据\n${report.evidence}`)
  }

  return sections.join('\n\n')
}

export function createIssuePreview(report) {
  requireReportObject(report)
  return {
    repository: ISSUE_REPOSITORY,
    title: report.title,
    body: renderIssueBody(report),
  }
}

function runGh(args, { input, env }) {
  return spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true,
  })
}

function invokeGh(ghRunner, args, input) {
  try {
    return ghRunner(args, {
      input,
      env: { GH_PROMPT_DISABLED: '1' },
    })
  }
  catch (error) {
    return { status: null, error }
  }
}

function isGhMissing(result) {
  return result?.error?.code === 'ENOENT'
}

function authFailureMessage(result) {
  if (isGhMissing(result)) {
    return new IssueReportError('GH_NOT_INSTALLED', '未找到 GitHub CLI（gh），无法提交 issue。')
  }

  const details = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`
  if (/not logged in|no authentication token|authentication token.+(?:missing|not set)|gh auth login/i.test(details)) {
    return new IssueReportError('GH_NOT_AUTHENTICATED', '本机 gh 尚未登录 github.com，请先完成登录后再提交。')
  }

  return new IssueReportError('GH_AUTH_STATUS_FAILED', '无法确认本机 gh 的 GitHub 登录状态；没有提交 issue。')
}

function parseIssueJson(stdout) {
  try {
    return JSON.parse(stdout)
  }
  catch {
    return null
  }
}

function issueHtmlUrl(number) {
  return `https://github.com/${ISSUE_REPOSITORY}/issues/${number}`
}

function validIssueIdentity(issue, number = issue?.number) {
  return Number.isSafeInteger(number)
    && number > 0
    && issue?.number === number
    && issue?.repository_url === API_REPOSITORY
    && issue?.html_url === issueHtmlUrl(number)
}

function explicitHttpRejection(result) {
  if (result?.status === 0) {
    return false
  }
  const stderr = String(result?.stderr ?? '').trimEnd()
  const match = stderr.match(/\(HTTP\s+(400|401|403|404|409|410|422)\)\s*$/i)
  return Boolean(match)
}

function trustedIssueUrl(issue) {
  return validIssueIdentity(issue) ? issue.html_url : undefined
}

function withIssueUrl(message, url) {
  return url ? `${message} Issue 链接：${url}` : message
}

function readbackFailure(url) {
  return new IssueReportError(
    'ISSUE_CREATED_READBACK_FAILED',
    withIssueUrl('GitHub 已返回 issue 创建结果，但读回验证失败；请先检查该链接，不要重复提交。', url),
  )
}

export async function submitIssueReport(report, { ghRunner = runGh } = {}) {
  requireReportObject(report)

  const auth = invokeGh(ghRunner, ['auth', 'status', '--hostname', 'github.com'])
  if (auth?.status !== 0) {
    throw authFailureMessage(auth)
  }

  const preview = createIssuePreview(report)
  const post = invokeGh(
    ghRunner,
    ['api', '--hostname', 'github.com', '--method', 'POST', `/repos/${ISSUE_REPOSITORY}/issues`, '--input', '-'],
    JSON.stringify({ title: preview.title, body: preview.body }),
  )

  if (post?.status !== 0) {
    if (explicitHttpRejection(post)) {
      throw new IssueReportError('ISSUE_REJECTED', 'GitHub 明确拒绝了 issue 请求；没有自动重试。')
    }
    throw new IssueReportError('ISSUE_CREATE_UNKNOWN', 'issue 创建结果未知；它可能已经创建，请先在 GitHub 检查，不要重复提交。')
  }

  const created = parseIssueJson(post.stdout)
  const createdUrl = trustedIssueUrl(created)
  if (!createdUrl) {
    throw new IssueReportError('ISSUE_CREATE_UNKNOWN', 'GitHub 的创建响应不完整；issue 可能已经创建，请先检查仓库，不要重复提交。')
  }

  const get = invokeGh(
    ghRunner,
    ['api', '--hostname', 'github.com', '--method', 'GET', `/repos/${ISSUE_REPOSITORY}/issues/${created.number}`],
  )
  const issue = get?.status === 0 ? parseIssueJson(get.stdout) : null

  if (!validIssueIdentity(issue, created.number)
    || issue.title !== preview.title
    || issue.body !== preview.body) {
    throw readbackFailure(createdUrl)
  }

  return {
    repository: ISSUE_REPOSITORY,
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
  }
}

function parseArgs(argv) {
  const [command, flag, file, ...extra] = argv
  if (!['preview', 'submit'].includes(command) || flag !== '--file' || !file || extra.length > 0) {
    throw new IssueReportError('CLI_USAGE', '用法：node bridge/report-issue.mjs preview|submit --file report.json')
  }
  return { command, file }
}

function readReport(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  }
  catch {
    throw new IssueReportError('REPORT_READ_FAILED', '无法读取报告文件。')
  }

  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1)
  }

  try {
    return JSON.parse(text)
  }
  catch {
    throw new IssueReportError('REPORT_JSON_INVALID', '报告文件不是有效的 JSON。')
  }
}

export async function main(argv, { ghRunner = runGh, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const { command, file } = parseArgs(argv)
    const report = validateIssueReport(readReport(file))
    if (command === 'preview') {
      stdout.write(`${JSON.stringify(createIssuePreview(report), null, 2)}\n`)
    }
    else {
      stdout.write(`${JSON.stringify(await submitIssueReport(report, { ghRunner }), null, 2)}\n`)
    }
    return 0
  }
  catch (error) {
    const isReportValidationError = error instanceof TypeError
    const code = error instanceof IssueReportError
      ? error.code
      : isReportValidationError
        ? 'REPORT_INVALID'
        : 'UNEXPECTED_ERROR'
    const message = isReportValidationError
      ? error.message
      : error instanceof IssueReportError
        ? error.message
        : '报告处理失败。'
    stderr.write(`${JSON.stringify({ error: { code, message } })}\n`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
