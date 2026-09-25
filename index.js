/**
 * Host half of the T3 new-session-screen bundle.
 *
 * The screen itself is browser-side (`./client`), but two things it needs are
 * only reachable from the Node process:
 *
 *   - **git facts.** DSH has no git service and no branch metadata, so the
 *     branch picker would have nothing to show. This half runs `git` through
 *     `node:child_process` and answers over a fenced HTTP route.
 *   - **the plugin's own configuration.** A browser bundle is a static file and
 *     never sees the Loader row's `config:`, so this half republishes the
 *     resolved, client-facing subset on the same route.
 *
 * The route is registered at the `/api` gateway's trust level: Host-header
 * loopback (or a configured trusted authority), same-origin browser markers
 * only. See `isTrustedApiRequest` below — it is behaviorally the same fence the
 * shipped gateway uses, copied rather than imported because that helper is not
 * part of any package's public surface.
 *
 * Every method answers `{ok:true, value}` or `{ok:false, error:{code,message}}`.
 */

import { spawn } from 'node:child_process'
import { statSync } from 'node:fs'

/** Loader entry name; must match the package name and the client bundle id. */
export const name = 'dsh-t3-new-session-screen'

/** The HTTP carrier and the deployment's trusted authorities. */
export const inject = ['webServer', 'webRuntime']

/** Path prefix of this plugin's JSON API. */
const API_PREFIX = '/t3-new-session/api'

/** Body size bound of one request (a cwd and a ref name — never large). */
const MAX_BODY_BYTES = 1 << 16

/** Untracked cap on branches returned in one response. */
const MAX_BRANCHES = 500

/**
 * Every tunable, with its default and its accepted shape. The schema below is
 * built from this table, and `apply` reads the same table, so a field can never
 * exist in one and not the other.
 */
const FIELDS = {
  gitEnabled: {
    kind: 'boolean', default: true,
    about: 'Git bridge: git.status, git.branches, git.checkout, git.createBranch.',
  },
  gitTimeoutMs: {
    kind: 'number', default: 30_000, min: 1_000,
    about: 'Budget of one git child process, in milliseconds.',
  },
  branchCreateEnabled: {
    kind: 'boolean', default: true,
    about: 'Offer "Create new ref" (git checkout -b) in the branch picker.',
  },
  headlineEnabled: {
    kind: 'boolean', default: true,
    about: 'Replace the blank-session headline with the T3 sentence.',
  },
  headlineText: {
    kind: 'string', default: 'What should we build in {project}?',
    about: 'Headline template; {project} becomes the interactive project name.',
  },
  hideShippedHeadline: {
    kind: 'boolean', default: true,
    about: 'Hide the shipped "Into the Unknown" title beside the headline.',
  },
  hideWorkspaceChip: {
    kind: 'boolean', default: true,
    about: 'Hide the shipped workspace chip under the headline.',
  },
  effortEnabled: {
    kind: 'boolean', default: true,
    about: 'Reasoning-effort picker in the composer tool row.',
  },
  effortSlot: {
    kind: 'enum', values: ['left', 'right'], default: 'left',
    about: 'Composer seat the effort picker occupies.',
  },
  branchEnabled: {
    kind: 'boolean', default: true,
    about: 'Git branch strip on the new-session screen.',
  },
}

/**
 * Deployment configuration, as a Standard Schema.
 *
 * Deliberately hand-written rather than a Schemastery schema: a plugin
 * installed as a directory link resolves its imports from its own real path,
 * where exactly none of DSH's `@deepseek-ai/*` packages are reachable — only
 * `node:*` builtins are. Cordis needs nothing more than a synchronous
 * `~standard.validate`, so this covers validation, defaults, and clamping with
 * no dependency at all.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-t3-new-session-screen',
    /**
     * Validate and normalize one Loader row's `config:`.
     * @param value - the raw configuration.
     * @returns `{ value }` with every default filled, or `{ issues }`.
     */
    validate(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const issues = []
      const out = {}
      for (const [key, field] of Object.entries(FIELDS)) {
        const raw = source[key]
        if (raw === undefined) {
          out[key] = field.default
          continue
        }
        if (field.kind === 'boolean') {
          if (typeof raw !== 'boolean') {
            issues.push({ message: `"${key}" must be a boolean`, path: [key] })
            continue
          }
          out[key] = raw
          continue
        }
        if (field.kind === 'number') {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) {
            issues.push({ message: `"${key}" must be a finite number`, path: [key] })
            continue
          }
          out[key] = field.min === undefined ? raw : Math.max(field.min, raw)
          continue
        }
        if (field.kind === 'enum') {
          if (typeof raw !== 'string' || !field.values.includes(raw)) {
            issues.push({
              message: `"${key}" must be one of ${field.values.map(v => `"${v}"`).join(', ')}`,
              path: [key],
            })
            continue
          }
          out[key] = raw
          continue
        }
        if (typeof raw !== 'string') {
          issues.push({ message: `"${key}" must be a string`, path: [key] })
          continue
        }
        out[key] = raw
      }
      // Unknown keys are ignored, not rejected: a key left over from an older
      // version must not be able to fail the whole profile's boot.
      return issues.length > 0 ? { issues } : { value: out }
    },
  },
}

/**
 * Re-apply the defaults for callers that bypass the Loader (a direct
 * `apply()` call, a test), so `config` is total either way.
 * @param config - the resolved config, possibly partial or undefined.
 * @returns a total configuration record.
 */
function resolveConfig(config) {
  const source = config ?? {}
  const out = {}
  for (const [key, field] of Object.entries(FIELDS)) {
    const raw = source[key]
    if (field.kind === 'boolean') out[key] = typeof raw === 'boolean' ? raw : field.default
    else if (field.kind === 'number') {
      out[key] = typeof raw === 'number' && Number.isFinite(raw)
        ? (field.min === undefined ? raw : Math.max(field.min, raw))
        : field.default
    } else if (field.kind === 'enum') {
      out[key] = field.values.includes(raw) ? raw : field.default
    } else {
      out[key] = typeof raw === 'string' ? raw : field.default
    }
  }
  if (out.headlineText === '') out.headlineText = FIELDS.headlineText.default
  return out
}

/** The client-facing subset of the configuration — exactly what the screen reads. */
function clientConfig(config) {
  return {
    headlineEnabled: config.headlineEnabled,
    headlineText: config.headlineText,
    hideShippedHeadline: config.hideShippedHeadline,
    hideWorkspaceChip: config.hideWorkspaceChip,
    effortEnabled: config.effortEnabled,
    effortSlot: config.effortSlot === 'right' ? 'right' : 'left',
    branchEnabled: config.branchEnabled,
    branchCreateEnabled: config.branchCreateEnabled,
    gitEnabled: config.gitEnabled,
  }
}

// ---------------------------------------------------------------------- wire

/** HTTP status of each error code. */
const STATUS = {
  'bad-request': 400,
  forbidden: 403,
  'not-found': 404,
  'method-error': 405,
  'git-error': 500,
  internal: 500,
}

/** One API failure carrying its wire code. */
class ApiError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function writeOk(res, value) {
  writeJson(res, 200, { ok: true, value })
}

function writeError(res, error) {
  if (error instanceof ApiError) {
    writeJson(res, STATUS[error.code] ?? 400, {
      ok: false,
      error: { code: error.code, message: error.message },
    })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  writeJson(res, 500, { ok: false, error: { code: 'internal', message } })
}

async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new ApiError('bad-request', 'request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError('bad-request', 'request body is not valid JSON')
  }
}

function requireString(payload, key) {
  const record = payload !== null && typeof payload === 'object' ? payload : {}
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new ApiError('bad-request', `missing or invalid "${key}"`)
  }
  return value
}

// --------------------------------------------------------------- trust fence

/** Headers the fence reads; a structural subset of `IncomingMessage`. */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  )
}

function canonicalAuthority(entry, entryUrl) {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

function isTrustedAuthority(hostUrl, trustedHosts) {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Whether one request may reach this plugin's route: the Host must be ours
 * (loopback or a configured trusted authority) and browser markers must be
 * same-origin. A DNS-rebinding / cross-site defense, not authentication.
 * @param req - node HTTP request.
 * @param trustedHosts - non-loopback authorities this deployment serves.
 * @returns true when the request is trusted.
 */
function isTrustedApiRequest(req, trustedHosts) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) {
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin !== 'string') return true
  try {
    return new URL(origin).hostname === hostUrl.hostname
  } catch {
    return false
  }
}

// ----------------------------------------------------------------------- git

/**
 * Run one `git` command in `cwd`.
 * @param cwd - absolute working directory.
 * @param args - git arguments; never shell-interpreted.
 * @param timeoutMs - budget before SIGKILL.
 * @returns stdout on a zero exit.
 * @throws {ApiError} `git-error` on a nonzero exit, a missing binary, or expiry.
 */
function runGit(cwd, args, timeoutMs) {
  const argv = ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args]
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      })
    } catch (error) {
      reject(new ApiError('git-error', `cannot run git: ${error.message}`))
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new ApiError('git-error', `git ${args[0] ?? ''} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new ApiError('git-error', `cannot run git: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(stdout)
      else reject(new ApiError('git-error', stderr.trim() || `git exited with ${String(code)}`))
    })
  })
}

/** Resolve and validate the caller's working directory. */
function requireCwd(payload) {
  const cwd = requireString(payload, 'cwd')
  let info
  try {
    info = statSync(cwd)
  } catch {
    throw new ApiError('bad-request', `working directory does not exist: ${cwd}`)
  }
  if (!info.isDirectory()) {
    throw new ApiError('bad-request', `working directory is not a directory: ${cwd}`)
  }
  if (!cwd.startsWith('/')) {
    throw new ApiError('bad-request', `working directory must be absolute: ${cwd}`)
  }
  return cwd
}

/** Reject anything that is not a plain ref name (no revisions, no options). */
function requireRefName(payload) {
  const name = requireString(payload, 'name')
  if (name.startsWith('-') || /[\s~^:?*[\\]/.test(name) || name.includes('..')) {
    throw new ApiError('bad-request', `invalid ref name: ${name}`)
  }
  return name
}

/** `{ isRepo, root, branch, detached }` for one directory. */
async function gitStatus(cwd, timeoutMs) {
  let root
  try {
    root = (await runGit(cwd, ['rev-parse', '--show-toplevel'], timeoutMs)).trim()
  } catch {
    return { isRepo: false, root: null, branch: null, detached: false }
  }
  let branch = null
  let detached = false
  try {
    const out = (await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], timeoutMs)).trim()
    detached = out === 'HEAD' || out === ''
    branch = detached ? null : out
  } catch {
    branch = null
  }
  return { isRepo: true, root, branch, detached }
}

/** Local + remote refs, the current branch, and the repo default branch. */
async function gitBranches(cwd, timeoutMs) {
  const status = await gitStatus(cwd, timeoutMs)
  if (!status.isRepo) return { isRepo: false, current: null, branches: [], defaultBranch: null }

  const root = status.root
  const out = await runGit(
    root,
    ['for-each-ref', '--format=%(refname:short)%09%(refname)', 'refs/heads', 'refs/remotes'],
    timeoutMs,
  )
  const local = []
  const remote = []
  for (const line of out.split('\n')) {
    if (line.trim() === '') continue
    const [shortName, fullName] = line.split('\t')
    if (shortName === undefined || fullName === undefined) continue
    if (fullName.startsWith('refs/heads/')) {
      local.push(shortName)
      continue
    }
    // `origin/HEAD` is a symbolic pointer, not a branch.
    if (shortName.endsWith('/HEAD')) continue
    remote.push(shortName)
    if (local.length + remote.length >= MAX_BRANCHES) break
  }

  let defaultBranch = null
  try {
    defaultBranch = (
      await runGit(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], timeoutMs)
    ).trim()
    if (defaultBranch === '') defaultBranch = null
  } catch {
    defaultBranch = null
  }

  const branches = [
    ...local.map((branchName) => ({
      name: branchName,
      isRemote: false,
      isCurrent: branchName === status.branch,
      isDefault: branchName === defaultBranch,
    })),
    ...remote.map((branchName) => ({
      name: branchName,
      isRemote: true,
      isCurrent: branchName === status.branch,
      isDefault: branchName === defaultBranch,
    })),
  ]
  return {
    isRepo: true,
    root,
    current: status.branch,
    defaultBranch,
    branches,
  }
}

// --------------------------------------------------------------------- apply

/**
 * Register the fenced JSON API the browser half calls.
 * @param ctx - the plugin's host context.
 * @param config - the resolved Loader config (defaults applied defensively).
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)
  const webRuntime = ctx.get('webRuntime')
  const trustedHosts = Array.isArray(webRuntime?.trustedHosts) ? webRuntime.trustedHosts : []

  const methods = {
    /** The client-facing configuration. */
    config: () => clientConfig(resolved),

    'git.status': async (payload) => {
      if (!resolved.gitEnabled) throw new ApiError('forbidden', 'the git bridge is disabled')
      return gitStatus(requireCwd(payload), resolved.gitTimeoutMs)
    },

    'git.branches': async (payload) => {
      if (!resolved.gitEnabled) throw new ApiError('forbidden', 'the git bridge is disabled')
      return gitBranches(requireCwd(payload), resolved.gitTimeoutMs)
    },

    'git.checkout': async (payload) => {
      if (!resolved.gitEnabled) throw new ApiError('forbidden', 'the git bridge is disabled')
      const cwd = requireCwd(payload)
      const name = requireRefName(payload)
      const status = await gitStatus(cwd, resolved.gitTimeoutMs)
      if (!status.isRepo) throw new ApiError('git-error', 'not a git repository')
      await runGit(status.root, ['checkout', name], resolved.gitTimeoutMs)
      const branch = (await runGit(status.root, ['rev-parse', '--abbrev-ref', 'HEAD'], resolved.gitTimeoutMs)).trim()
      return { name: branch, requested: name }
    },

    'git.createBranch': async (payload) => {
      if (!resolved.gitEnabled) throw new ApiError('forbidden', 'the git bridge is disabled')
      if (!resolved.branchCreateEnabled) {
        throw new ApiError('forbidden', 'creating branches is disabled')
      }
      const cwd = requireCwd(payload)
      const name = requireRefName(payload)
      const status = await gitStatus(cwd, resolved.gitTimeoutMs)
      if (!status.isRepo) throw new ApiError('git-error', 'not a git repository')
      await runGit(status.root, ['checkout', '-b', name], resolved.gitTimeoutMs)
      return { name }
    },
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          if (!isTrustedApiRequest(req, trustedHosts)) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
            return
          }
          if (req.method !== 'POST') {
            writeJson(res, 405, {
              ok: false,
              error: { code: 'method-error', message: 'method not allowed' },
            })
            return
          }
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith(`${API_PREFIX}/`)
            ? pathname.slice(API_PREFIX.length + 1)
            : undefined
          const handler = method !== undefined && !method.includes('/') ? methods[method] : undefined
          if (handler === undefined) {
            writeJson(res, 404, {
              ok: false,
              error: { code: 'not-found', message: `unknown method "${method ?? ''}"` },
            })
            return
          }
          try {
            writeOk(res, await handler(await readJsonBody(req)))
          } catch (error) {
            writeError(res, error)
          }
        },
      }),
    't3-new-session-screen: /t3-new-session/api route',
  )
}
