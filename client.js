/**
 * Client half of the T3 new-session-screen bundle.
 *
 * A port of T3 Code's New Session screen
 * (https://github.com/pingdotgg/t3code), by the T3 Code authors under MIT.
 * Three things that screen has and DeepSeek Harness's blank session does not:
 *
 *   1. the `What should we build in <project>?` headline, where the project
 *      name is itself the picker (T3's DraftHeroHeadline). DSH renders its
 *      headline from a literal i18n string with no slot, so this half fills the
 *      only additive hole in that row — `conversation.hero.brand.mark` — with
 *      the whole sentence, and suppresses the shipped title beside it.
 *   2. a reasoning-effort picker (T3's TraitsPicker). DSH keeps effort behind
 *      the model seat; this surfaces it as its own composer control, reading
 *      the same `ctx.modelDirectories` face the model seat writes.
 *   3. a git branch picker (T3's BranchToolbar). DSH has no git surface at all,
 *      so the strip is fed by this bundle's Host half over
 *      `/t3-new-session/api`.
 *
 * Deliberate departures from T3, because DSH has no equivalent concept: no
 * local/worktree environment-mode switch (the strip's left label reports the
 * checkout instead) and no pull-request badge on the strip. The strip sits
 * above the composer card on the hero, because DSH renders no seat below the
 * card until a session has a first turn.
 *
 * Everything is read through the framework's own seams — `ctx.modelDirectories`
 * for the model and effort vocabulary, `ctx.sessions` for the working
 * directory, the root `useWorkspaces` hook for the project roster, and
 * `ctx.workspaces` / `ctx.uiWorkspace` for adding one.
 */

window.__ModuleLoader__.load({
  id: 'dsh-t3-new-session-screen',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')

    const h = React.createElement
    const {
      useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
    } = React

    /** Dictionary namespace owned by this plugin. */
    const NS = 't3NewSession'

    /** Path prefix of this bundle's Host route (see `./index.js`). */
    const API = '/t3-new-session/api'

    /** The two composer seats the effort control can occupy. */
    const EFFORT_SEATS = ['conversation.input.left', 'conversation.input.right']

    /**
     * Marks the hero workspace row as trailing while the headline carries the
     * project affordance: DSH ships that row as a leading pair (its workspace
     * chip + the agent-preset seat), and with the chip out of the layout the
     * seat is the only control left in it. Set on `<html>` so the rule that
     * trailers the seat can live in this plugin's own stylesheet.
     */
    const TRAILING_ROW_ATTR = 'data-t3nss-preset-trailing'

    const EN = {
      'headline.fallback': 'What should we build in {project}?',
      'headline.thisProject': 'this project',
      'headline.chooseProject': 'a project',
      'headline.chooseHint': 'Choose a project to start',
      'project.menu': 'Choose a project',
      'project.new': 'New project',
      'project.none': 'No projects yet',
      'project.picking': 'Choosing a folder…',
      'project.failed': 'Could not add the project: {message}',
      'effort.title': 'Reasoning effort',
      'effort.default': 'Default',
      'effort.aria': 'Reasoning effort: {effort}',
      'branch.title': 'Git branch',
      'branch.aria': 'Git branch: {name}',
      'branch.checkout': 'Current checkout',
      'branch.search': 'Search refs...',
      'branch.none': 'No refs found.',
      'branch.notRepo': 'Not a git repository',
      'branch.loading': 'Reading refs…',
      'branch.failed': 'git failed: {message}',
      'branch.create': 'Create new ref "{name}"',
      'branch.current': 'current',
      'branch.remote': 'remote',
      'branch.default': 'default',
    }

    const ZH = {
      'headline.fallback': '我们该在 {project} 里构建什么？',
      'headline.thisProject': '这个项目',
      'headline.chooseProject': '一个项目',
      'headline.chooseHint': '选择一个项目开始',
      'project.menu': '选择项目',
      'project.new': '新建项目',
      'project.none': '还没有项目',
      'project.picking': '正在选择文件夹…',
      'project.failed': '无法添加项目：{message}',
      'effort.title': '推理等级',
      'effort.default': '默认',
      'effort.aria': '推理等级：{effort}',
      'branch.title': 'Git 分支',
      'branch.aria': 'Git 分支：{name}',
      'branch.checkout': '当前检出',
      'branch.search': '搜索引用...',
      'branch.none': '没有匹配的引用。',
      'branch.notRepo': '不是 git 仓库',
      'branch.loading': '正在读取引用…',
      'branch.failed': 'git 失败：{message}',
      'branch.create': '创建新引用 “{name}”',
      'branch.current': '当前',
      'branch.remote': '远程',
      'branch.default': '默认',
    }

    /** Seated until the Host's resolved configuration arrives. */
    const DEFAULT_CONFIG = {
      headlineEnabled: true,
      headlineText: EN['headline.fallback'],
      hideShippedHeadline: true,
      hideWorkspaceChip: true,
      effortEnabled: true,
      effortSlot: 'left',
      branchEnabled: true,
      branchCreateEnabled: true,
      gitEnabled: true,
    }

    // ----------------------------------------------------------- snapshot store

    /**
     * A minimal external store exposing `getSnapshot`/`subscribe` for
     * `useSyncExternalStore`. Deliberately not the shipped store package: this
     * bundle needs three tiny stores, not a dependency.
     * @param initial - the first snapshot.
     * @returns the store.
     */
    function createStore(initial) {
      let snapshot = initial
      const listeners = new Set()
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        get: () => snapshot,
        set(next) {
          snapshot = next
          for (const listener of listeners) listener()
        },
      }
    }

    /**
     * Subscribe a component to one snapshot store.
     * @param store - the store.
     * @returns its current snapshot.
     */
    function useSnapshot(store) {
      const subscribe = useCallback(listener => store.subscribe(listener), [store])
      const getSnapshot = useCallback(() => store.getSnapshot(), [store])
      return useSyncExternalStore(subscribe, getSnapshot)
    }

    // ---------------------------------------------------------------- host bridge

    /** The Host's resolved, client-facing configuration. */
    const configStore = createStore(DEFAULT_CONFIG)

    /**
     * One JSON call to this bundle's Host route.
     * @param method - the method name after the prefix.
     * @param payload - the JSON body.
     * @returns the unwrapped `value`.
     * @throws {Error} with a `code` property on any failure envelope.
     */
    async function callApi(method, payload = {}) {
      let response
      try {
        response = await fetch(`${API}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      const parsed = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true) {
        const failure = new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
        failure.code = parsed?.error?.code ?? 'http'
        throw failure
      }
      return parsed.value
    }

    // ---------------------------------------------------------- hero rendezvous

    /**
     * Facts the hero's two seats share. The headline occupant owns the sentence
     * and the anchor; the picker occupant owns the roster and the commit
     * actions. Neither can see the other's props, so the pair meets here.
     */
    const heroStore = createStore({ projectId: undefined, projectTitle: undefined, open: false })

    /** The headline's project button — the menu's preferred anchor. */
    let headlineAnchor = null

    /** The shipped workspace chip, hidden while the headline carries the name. */
    let workspaceChip = null

    // ------------------------------------------------------------------- icons

    /**
     * One stroked 24-unit glyph, drawn in the icon language T3 renders.
     * @param paths - path `d` strings.
     * @param props - `size` and any pass-through attributes.
     * @returns the svg element.
     */
    function icon(paths, props) {
      const { size = 16, ...rest } = props ?? {}
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false', ...rest,
      }, paths.map((d, index) => h('path', { key: index, d })))
    }

    const FolderIcon = props => icon([
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    ], props)
    const FolderPlusIcon = props => icon([
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
      'M12 10v6', 'M9 13h6',
    ], props)
    const GitBranchIcon = props => icon([
      'M6 3v12', 'M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
      'M18 9a9 9 0 0 1-9 9',
    ], props)
    const ChevronDownIcon = props => icon(['m6 9 6 6 6-6'], props)
    const CheckIcon = props => icon(['M20 6 9 17l-5-5'], props)
    const PlusIcon = props => icon(['M12 5v14', 'M5 12h14'], props)
    const SearchIcon = props => icon(['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z', 'm21 21-4.3-4.3'], props)
    const GaugeIcon = props => icon(['m12 14 4-4', 'M3.34 19a10 10 0 1 1 17.32 0'], props)

    // ----------------------------------------------------------- shared helpers

    /**
     * Format a `{name}` template.
     * @param template - the template.
     * @param values - hole values; unknown holes stay verbatim.
     * @returns the formatted string.
     */
    function format(template, values) {
      return template.replace(/\{(\w+)\}/g, (match, key) =>
        values[key] === undefined ? match : String(values[key]))
    }

    /**
     * Split a headline template around its `{project}` hole so the project name
     * can be an interactive control inside the sentence.
     * @param template - the configured headline.
     * @returns the text before and after the hole, and whether it has one.
     */
    function splitProjectTemplate(template) {
      const at = template.indexOf('{project}')
      if (at === -1) return { before: template, after: '', hasHole: false }
      return { before: template.slice(0, at), after: template.slice(at + 9), hasHole: true }
    }

    /**
     * Dismiss a floating card on an outside press or Escape.
     * @param open - whether the card is showing.
     * @param refs - nodes that count as inside.
     * @param close - the dismiss action.
     */
    function useDismiss(open, refs, close) {
      const refsRef = useRef(refs)
      refsRef.current = refs
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          for (const ref of refsRef.current) {
            if (ref.current?.contains(event.target) === true) return
          }
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, close])
    }

    /**
     * Fixed-position a floating card against an anchor, clamped to the viewport
     * and flipped above the anchor when it would overflow the bottom.
     * @param open - whether the card is showing.
     * @param anchor - reads the anchor element.
     * @param width - the card's width in pixels.
     * @param align - which anchor edge the card aligns to.
     * @returns the resolved position (null while measuring) and the card's ref.
     */
    function useAnchoredCard(open, anchor, width, align) {
      const [position, setPosition] = useState(null)
      const ref = useRef(null)
      useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const measure = () => {
          const element = anchor()
          if (element === null || element === undefined || !element.isConnected) return
          const rect = element.getBoundingClientRect()
          const height = ref.current?.offsetHeight ?? 280
          const left = align === 'end'
            ? rect.right - width
            : align === 'start'
              ? rect.left
              : rect.left + rect.width / 2 - width / 2
          const top = rect.bottom + 8 + height > window.innerHeight - 8
            ? Math.max(8, rect.top - height - 8)
            : rect.bottom + 8
          setPosition({
            left: Math.max(8, Math.min(window.innerWidth - width - 8, left)),
            top,
            width,
          })
        }
        measure()
        // The card's own height decides the flip, so re-measure once it mounts.
        const frame = window.requestAnimationFrame(measure)
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        return () => {
          window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', measure)
          window.removeEventListener('scroll', measure, true)
        }
      }, [open, anchor, width, align])
      return [position, ref]
    }

    /** The style of a card that has not been measured yet. */
    function cardStyle(position, width) {
      return position === null
        ? { position: 'fixed', left: 0, top: 0, width, visibility: 'hidden' }
        : { position: 'fixed', left: position.left, top: position.top, width: position.width }
    }

    // ------------------------------------------------------------ hero headline

    /**
     * T3's headline: `What should we build in <project>?`, the project name
     * being the picker trigger. Rendered into `conversation.hero.brand.mark`,
     * the only additive hole DSH's headline row offers.
     * @param props - the `t` seat; other standard hooks are unused here.
     * @returns the headline element, or null when disabled.
     */
    function HeroHeadline(props) {
      const { t } = props
      const config = useSnapshot(configStore)
      const hero = useSnapshot(heroStore)
      const buttonRef = useRef(null)
      const rootRef = useRef(null)

      useLayoutEffect(() => {
        headlineAnchor = buttonRef.current
        return () => { headlineAnchor = null }
      })

      const hideShipped = config.hideShippedHeadline
      useLayoutEffect(() => {
        if (!hideShipped) return undefined
        const node = rootRef.current
        if (node === null) return undefined
        // The renderer wraps a slot occupant in a `display: contents` div, so the
        // headline row is not a fixed number of levels up: climb until an
        // ancestor actually has siblings, then keep only the branch leading here.
        // That row is `HeroShell`'s `.headline`, and the sibling it holds is the
        // shipped "Into the Unknown" title group — a literal string with no slot
        // of its own, which is why suppressing it is the only way to replace it.
        const ancestors = []
        for (let up = node; up !== null && ancestors.length < 8; up = up.parentElement) {
          ancestors.push(up)
        }
        let row = null
        let ownBranch = null
        for (let index = 0; index < ancestors.length; index += 1) {
          if (ancestors[index].children.length > 1) {
            row = ancestors[index]
            ownBranch = ancestors[index - 1] ?? node
            break
          }
        }
        if (row === null) return undefined
        const hidden = []
        for (const child of Array.from(row.children)) {
          if (child === ownBranch) continue
          hidden.push([child, child.style.display])
          child.style.display = 'none'
        }
        // A re-render of the shipped row would restore its own display value.
        const observer = new MutationObserver(() => {
          for (const [child] of hidden) {
            if (child.isConnected && child.style.display !== 'none') child.style.display = 'none'
          }
        })
        observer.observe(row, { childList: true })
        return () => {
          observer.disconnect()
          for (const [child, previous] of hidden) {
            if (child.isConnected) child.style.display = previous
          }
        }
      }, [hideShipped])

      if (!config.headlineEnabled) return null

      const template = config.headlineText !== '' ? config.headlineText : EN['headline.fallback']
      const { before, after, hasHole } = splitProjectTemplate(template)
      const named = hero.projectTitle !== undefined
      const label = named
        ? hero.projectTitle
        : (hero.projectId === undefined ? t('headline.chooseProject') : t('headline.thisProject'))

      // No hole in the template means a plain sentence, not a control.
      if (!hasHole) {
        return h('span', { ref: rootRef, className: 't3nss-headlineRoot' },
          format(template, { project: label }))
      }

      // Without a project the sentence reads as the call to action instead, so
      // the empty state never claims a project that does not exist yet.
      const leading = named ? before : before.replace(/\s+$/, '')

      return h('span', { ref: rootRef, className: 't3nss-headlineRoot' },
        leading,
        h('button', {
          ref: buttonRef,
          type: 'button',
          className: named ? 't3nss-project' : 't3nss-project t3nss-projectEmpty',
          'aria-haspopup': 'menu',
          'aria-expanded': hero.open,
          onClick: () => {
            const current = heroStore.get()
            heroStore.set({ ...current, open: !current.open })
          },
        }, named ? label : t('headline.chooseHint')),
        after,
      )
    }

    // ----------------------------------------------------------- project picker

    /**
     * T3's project menu, filling DSH's `conversation.hero.workspace` hole. DSH's
     * own picker occupies that cell at priority 0; this entry sits at -1, so it
     * is the one the hero renders while the headline carries the affordance.
     * @param props - owner share, the `t` seat, and the root `useWorkspaces` hook.
     * @returns the menu, portalled to the body.
     */
    function ProjectPicker(props) {
      const { t, open: ownerOpen, anchorRef, selectedId, onPick, onClose } = props
      const config = useSnapshot(configStore)
      const hero = useSnapshot(heroStore)
      const useWorkspaces = props.useWorkspaces

      const snapshot = useWorkspaces !== undefined
        ? useWorkspaces(state => state)
        : { items: [], phase: 'ready' }
      const items = Array.isArray(snapshot.items) ? snapshot.items : []

      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const rootRef = useRef(null)
      const cardRef = useRef(null)

      // Only this seat knows which project the owner selected; the headline
      // reads it back to name it inside the sentence.
      const selectedTitle = items.find(item => item.workspaceId === selectedId)?.title
      useEffect(() => {
        const current = heroStore.get()
        if (current.projectId !== selectedId || current.projectTitle !== selectedTitle) {
          heroStore.set({ ...current, projectId: selectedId, projectTitle: selectedTitle })
        }
      }, [selectedId, selectedTitle])

      // The headline IS the project control, which leaves the shipped chip as a
      // second affordance for the same choice. Hiding it with `visibility` kept
      // its box in the row — 226px for this repository's own name — so the
      // agent-preset seat that shares the row floated at an x that followed the
      // project's name instead of any axis on the screen. It leaves the layout
      // entirely instead, and the row is re-declared as trailing: the preset
      // seat, now the row's only control, rides the composer's shared right axis
      // (see the `data-t3nss-preset-trailing` rule in the stylesheet). The chip
      // stays in the DOM, unrendered, as the menu's fallback anchor.
      const hideChip = config.headlineEnabled && config.hideWorkspaceChip
      useLayoutEffect(() => {
        const chip = anchorRef?.current ?? null
        workspaceChip = chip
        if (chip === null || !hideChip) return undefined
        const previousDisplay = chip.style.display
        chip.style.display = 'none'
        document.documentElement.setAttribute(TRAILING_ROW_ATTR, '')
        return () => {
          chip.style.display = previousDisplay
          document.documentElement.removeAttribute(TRAILING_ROW_ATTR)
        }
      }, [anchorRef, hideChip])

      const open = hero.open || ownerOpen === true
      const close = useCallback(() => {
        heroStore.set({ ...heroStore.get(), open: false })
        onClose?.()
      }, [onClose])

      const anchor = useCallback(() => headlineAnchor ?? workspaceChip, [])
      const [position, measureRef] = useAnchoredCard(open, anchor, 320, 'center')
      useDismiss(open, [rootRef, cardRef], close)

      const addProject = useCallback(async () => {
        if (busy) return
        setError(null)
        setBusy(true)
        try {
          const path = await props.uiWorkspace.pickDirectory()
          if (path === null || path === undefined || path === '') return
          const created = await props.workspaces.create({ path })
          const createdId = created?.workspaceId
          if (createdId === undefined) throw new Error('the host returned no workspace id')
          heroStore.set({ ...heroStore.get(), open: false })
          onPick?.(createdId)
        } catch (reason) {
          setError(format(t('project.failed'), {
            message: reason instanceof Error ? reason.message : String(reason),
          }))
        } finally {
          setBusy(false)
        }
      }, [busy, onPick, props.uiWorkspace, props.workspaces, t])

      // Pick one row: the owner adopts it and moves the blank session there.
      const choose = useCallback((workspaceId) => {
        heroStore.set({ ...heroStore.get(), open: false })
        onPick?.(workspaceId)
      }, [onPick])

      if (!open) return null

      const rows = items.map(item => h('button', {
        key: item.workspaceId,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': item.workspaceId === selectedId,
        className: item.workspaceId === selectedId ? 't3nss-row t3nss-rowOn' : 't3nss-row',
        disabled: busy,
        onClick: () => { choose(item.workspaceId) },
      },
        h(FolderIcon, { size: 15, className: 't3nss-rowGlyph' }),
        h('span', { className: 't3nss-rowName' }, item.title),
        item.workspaceId === selectedId ? h(CheckIcon, { size: 15, className: 't3nss-rowCheck' }) : null,
      ))

      const card = h('div', {
        ref: (node) => { cardRef.current = node; measureRef.current = node },
        className: 't3nss-card',
        role: 'menu',
        'aria-label': t('project.menu'),
        style: cardStyle(position, 320),
      },
        h('div', { className: 't3nss-cardHead' }, t('project.menu')),
        rows.length === 0
          ? h('div', { className: 't3nss-empty' }, t('project.none'))
          : h('div', { className: 't3nss-list' }, rows),
        h('div', { className: 't3nss-sep' }),
        h('button', {
          type: 'button',
          role: 'menuitem',
          className: 't3nss-row',
          disabled: busy,
          onClick: () => { void addProject() },
        },
          h(FolderPlusIcon, { size: 15, className: 't3nss-rowGlyph' }),
          h('span', { className: 't3nss-rowName' },
            busy ? t('project.picking') : t('project.new')),
        ),
        error === null ? null : h('div', { className: 't3nss-error' }, error),
      )

      return ReactDOM.createPortal(card, document.body)
    }

    // ---------------------------------------------------------- effort picker

    /**
     * T3's effort control: the levels the current model advertises, written
     * through the same per-session model directory the model seat uses. Effort
     * stays a per-model capability — a model advertising none renders nothing.
     * @param props - the seat name, the injected directory face, and `t`.
     * @returns the control, portalled menu included.
     */
    function EffortPicker(props) {
      const { t, seat, face } = props
      const config = useSnapshot(configStore)
      const [open, setOpen] = useState(false)
      const rootRef = useRef(null)
      const cardRef = useRef(null)

      const state = useSnapshot(face.directory)
      const close = useCallback(() => { setOpen(false) }, [])
      const anchor = useCallback(() => rootRef.current, [])
      const [position, measureRef] = useAnchoredCard(open, anchor, 240, 'start')
      useDismiss(open, [rootRef, cardRef], close)

      // `inject` hands out a fresh face object each render, so the directory
      // identity — not the face — is what makes this load exactly once.
      const loadedRef = useRef(null)
      useEffect(() => {
        if (loadedRef.current === face.directory) return
        loadedRef.current = face.directory
        face.load()
      }, [face])

      const current = state.current
      const reasoning = useMemo(() => {
        if (current === null || current === undefined) return undefined
        for (const group of Array.isArray(state.groups) ? state.groups : []) {
          for (const model of Array.isArray(group.models) ? group.models : []) {
            if (group.id === current.provider && model.id === current.model) return model.reasoning
          }
        }
        return undefined
      }, [current, state.groups])

      const choose = useCallback((effort) => {
        setOpen(false)
        if (current === null || current === undefined) return
        void face.select({
          provider: current.provider,
          model: current.model,
          ...(effort === undefined ? {} : { reasoningEffort: effort }),
        })
      }, [current, face])

      // The configured seat is the only one that renders; the other registration
      // is a placeholder so switching the preference needs no reload.
      const wanted = config.effortSlot === 'right' ? 'conversation.input.right' : 'conversation.input.left'
      const efforts = reasoning?.efforts ?? []
      // Every way this control can legitimately be absent. A model that
      // advertises no effort vocabulary renders nothing at all — effort is a
      // per-model capability, not a global setting.
      const absent = !config.effortEnabled
        || seat !== wanted
        || face.available !== true
        || current === null
        || current === undefined
        || efforts.length === 0
      if (absent) return null

      const effective = current.reasoningEffort ?? reasoning?.defaultEffort
      const label = effective === undefined
        ? t('effort.default')
        : efforts.find(level => level.id === effective)?.name ?? effective

      const choices = [
        ...(reasoning.defaultEffort === undefined
          ? [{ id: undefined, name: t('effort.default'), description: undefined }]
          : []),
        ...efforts.map(level => ({ id: level.id, name: level.name, description: level.description })),
      ]

      return h('div', { ref: rootRef, className: 't3nss-effort' },
        h('button', {
          type: 'button',
          className: 't3nss-chip',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': format(t('effort.aria'), { effort: label }),
          title: `${t('effort.title')}: ${label}`,
          onClick: () => { setOpen(value => !value) },
        },
          h(GaugeIcon, { size: 13, className: 't3nss-chipGlyph' }),
          h('span', { className: 't3nss-chipLabel' }, label),
          h(ChevronDownIcon, { size: 12, className: 't3nss-chipChevron' }),
        ),
        open
          ? ReactDOM.createPortal(h('div', {
            ref: (node) => { cardRef.current = node; measureRef.current = node },
            className: 't3nss-card',
            role: 'menu',
            'aria-label': t('effort.title'),
            style: cardStyle(position, 240),
          },
            h('div', { className: 't3nss-cardHead' }, t('effort.title')),
            h('div', { className: 't3nss-list' }, choices.map(choice =>
              h('button', {
                key: choice.id ?? '__default__',
                type: 'button',
                role: 'menuitemradio',
                'aria-checked': effective === choice.id,
                className: effective === choice.id ? 't3nss-row t3nss-rowOn' : 't3nss-row',
                onClick: () => { choose(choice.id) },
              },
                h('span', { className: 't3nss-rowMain' },
                  h('span', { className: 't3nss-rowName' }, choice.name),
                  choice.description === undefined
                    ? null
                    : h('span', { className: 't3nss-rowHint' }, choice.description),
                ),
                effective === choice.id
                  ? h(CheckIcon, { size: 15, className: 't3nss-rowCheck' })
                  : null,
              ),
            )),
          ), document.body)
          : null,
      )
    }

    // ----------------------------------------------------------- branch strip

    /**
     * T3's context strip: the checkout on the left, the git ref on the right,
     * with a searchable ref menu behind it. DSH reports no branch state, so every
     * fact here comes from this bundle's Host half.
     * @param props - the injected working directory and the `t` seat.
     * @returns the strip, portalled menu included.
     */
    function BranchPicker(props) {
      const { t, cwd, session } = props
      // `conversation.input.dock` hands the owner's InputZone through, so the
      // strip can tell the hero from an active composer without a second seat.
      const phase = session?.blank === true ? 'hero' : 'active'
      const config = useSnapshot(configStore)
      const [menuOpen, setMenuOpen] = useState(false)
      const [query, setQuery] = useState('')
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState({
        phase: 'idle', isRepo: false, current: null, branches: [], error: null,
      })
      const rootRef = useRef(null)
      const cardRef = useRef(null)
      const inputRef = useRef(null)

      const close = useCallback(() => {
        setMenuOpen(false)
        setQuery('')
      }, [])
      const anchor = useCallback(() => rootRef.current, [])
      const [position, measureRef] = useAnchoredCard(menuOpen, anchor, 300, 'end')
      useDismiss(menuOpen, [rootRef, cardRef], close)

      const refresh = useCallback(async (signal) => {
        if (cwd === null || cwd === undefined || cwd === '') {
          setStatus({ phase: 'ready', isRepo: false, current: null, branches: [], error: null })
          return
        }
        setStatus(previous => ({ ...previous, phase: 'loading' }))
        try {
          const value = await callApi('git.branches', { cwd })
          if (signal?.aborted === true) return
          setStatus({
            phase: 'ready',
            isRepo: value.isRepo === true,
            current: value.current ?? null,
            branches: Array.isArray(value.branches) ? value.branches : [],
            error: null,
          })
        } catch (reason) {
          if (signal?.aborted === true) return
          setStatus({
            phase: 'error',
            isRepo: false,
            current: null,
            branches: [],
            error: reason instanceof Error ? reason.message : String(reason),
          })
        }
      }, [cwd])

      useEffect(() => {
        const controller = new AbortController()
        void refresh(controller.signal)
        return () => { controller.abort() }
      }, [refresh])

      useEffect(() => {
        if (!menuOpen) return undefined
        const frame = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
        return () => { window.cancelAnimationFrame(frame) }
      }, [menuOpen])

      const runAction = useCallback(async (method, payload) => {
        if (busy) return
        setBusy(true)
        try {
          await callApi(method, { cwd, ...payload })
          setMenuOpen(false)
          setQuery('')
          await refresh()
        } catch (reason) {
          setStatus(previous => ({
            ...previous,
            error: reason instanceof Error ? reason.message : String(reason),
          }))
        } finally {
          setBusy(false)
        }
      }, [busy, cwd, refresh])

      if (!config.branchEnabled || config.gitEnabled !== true) return null

      const normalized = query.trim().toLowerCase()
      const sanitized = query.trim().replace(/\s+/g, '-')
      const filtered = normalized === ''
        ? status.branches
        : status.branches.filter(branch => branch.name.toLowerCase().includes(normalized))
      const exists = status.branches.some(branch => branch.name === sanitized)
      const canCreate = config.branchCreateEnabled && sanitized !== '' && !exists

      const triggerLabel = status.phase === 'loading' && status.current === null
        ? t('branch.loading')
        : status.current ?? (status.isRepo ? 'HEAD' : t('branch.notRepo'))

      const rows = filtered.map(branch => h('button', {
        key: branch.name,
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': branch.isCurrent,
        className: branch.isCurrent ? 't3nss-row t3nss-rowOn' : 't3nss-row',
        disabled: busy,
        onClick: () => { void runAction('git.checkout', { name: branch.name }) },
      },
        h(GitBranchIcon, { size: 15, className: 't3nss-rowGlyph' }),
        h('span', { className: 't3nss-rowName' }, branch.name),
        h('span', { className: 't3nss-rowTag' },
          branch.isCurrent ? t('branch.current')
            : branch.isDefault ? t('branch.default')
              : branch.isRemote ? t('branch.remote')
                : ''),
        branch.isCurrent ? h(CheckIcon, { size: 15, className: 't3nss-rowCheck' }) : null,
      ))

      const card = h('div', {
        ref: (node) => { cardRef.current = node; measureRef.current = node },
        className: 't3nss-card',
        role: 'menu',
        'aria-label': t('branch.title'),
        style: cardStyle(position, 300),
      },
        h('div', { className: 't3nss-search' },
          h(SearchIcon, { size: 14, className: 't3nss-searchIcon' }),
          h('input', {
            ref: inputRef,
            className: 't3nss-searchInput',
            value: query,
            placeholder: t('branch.search'),
            'aria-label': t('branch.search'),
            onChange: event => { setQuery(event.target.value) },
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              if (canCreate) {
                void runAction('git.createBranch', { name: sanitized })
                return
              }
              if (filtered.length > 0) void runAction('git.checkout', { name: filtered[0].name })
            },
          }),
        ),
        status.isRepo !== true
          ? h('div', { className: 't3nss-empty' }, t('branch.notRepo'))
          : rows.length === 0 && !canCreate
            ? h('div', { className: 't3nss-empty' }, t('branch.none'))
            : h('div', { className: 't3nss-list' }, [
              ...rows,
              canCreate
                ? h('button', {
                  key: '__create__',
                  type: 'button',
                  role: 'menuitem',
                  className: 't3nss-row',
                  disabled: busy,
                  onClick: () => { void runAction('git.createBranch', { name: sanitized }) },
                },
                  h(PlusIcon, { size: 15, className: 't3nss-rowGlyph' }),
                  h('span', { className: 't3nss-rowName' },
                    format(t('branch.create'), { name: sanitized })),
                )
                : null,
            ]),
        status.error === null
          ? null
          : h('div', { className: 't3nss-error' },
            format(t('branch.failed'), { message: status.error })),
      )

      return h('div', {
        ref: rootRef,
        className: 't3nss-strip',
        // The hero stack gaps its rows 8px; an active composer stack gaps 6px.
        // Both want the strip 4px under the card, so the margin differs by phase.
        'data-phase': phase,
      },
        h('span', { className: 't3nss-stripLeft', title: cwd ?? '' },
          h(FolderIcon, { size: 14, className: 't3nss-stripGlyph' }),
          h('span', null, t('branch.checkout')),
        ),
        h('button', {
          type: 'button',
          className: 't3nss-stripRight',
          'aria-haspopup': 'menu',
          'aria-expanded': menuOpen,
          'aria-label': format(t('branch.aria'), { name: triggerLabel }),
          disabled: busy || status.isRepo !== true,
          onClick: () => { setMenuOpen(value => !value) },
        },
          h(GitBranchIcon, { size: 13, className: 't3nss-stripGlyph' }),
          h('span', { className: 't3nss-stripBranch' }, triggerLabel),
          h(ChevronDownIcon, { size: 12, className: 't3nss-chipChevron' }),
        ),
        menuOpen ? ReactDOM.createPortal(card, document.body) : null,
      )
    }

    // ------------------------------------------------------------------ styles

    const CSS = `
.t3nss-headlineRoot {
  display: inline; min-width: 0;
  font: inherit; color: inherit; line-height: inherit; letter-spacing: inherit;
}
.t3nss-project {
  appearance: none; margin: 0; padding: 0 1px; border: none; background: transparent;
  border-bottom: 1px dotted color-mix(in srgb, var(--dsw-alias-label-primary) 68%, transparent);
  color: inherit; font: inherit; line-height: inherit; letter-spacing: inherit; cursor: pointer;
  max-width: min(22rem, 55cqw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  transition: border-bottom-color 120ms ease;
}
.t3nss-project:hover { border-bottom-color: var(--dsw-alias-label-primary); }
.t3nss-project:focus-visible {
  outline: none; border-radius: 4px; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3);
}
.t3nss-projectEmpty { border-bottom-color: transparent; color: var(--dsw-alias-label-caption); }
.t3nss-projectEmpty:hover { border-bottom-color: var(--dsw-alias-label-caption); }

.t3nss-effort { position: relative; display: inline-flex; min-width: 0; }
.t3nss-chip {
  display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 6px;
  border: none; border-radius: 8px; background: transparent; cursor: pointer;
  color: var(--dsw-alias-label-secondary); font-family: inherit; font-size: 13px; font-weight: 500;
  transition: background-color 120ms ease;
}
.t3nss-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.t3nss-chip:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.t3nss-chipGlyph { flex: 0 0 auto; opacity: 0.7; }
.t3nss-chipLabel { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3nss-chipChevron { flex: 0 0 auto; opacity: 0.55; }

/* The hero workspace row, re-declared as trailing while the headline carries the
   project name. DSH ships that row as a LEADING pair — its workspace chip, then
   the agent-preset seat, gap 2, padding 0 16px 0 20px — and hides the row's own
   axis behind the card's side clearance. With the workspace chip removed from the
   layout (the plugin's headline is the project control), the preset seat is the
   row's only control, and leaving it in the leading slot parks it at an x that
   follows the invisible chip's width: 226px for this repository's name, 84px for
   a short one, nothing at all for the placeholder state.

   Trailing it instead puts its border box on the composer's shared right axis —
   the right edge the tool row's content box and the branch strip's border box
   both end on, flush with the send button and with the strip's own ref control.
   The trailing 8px is that axis's own dock inset, subtracted so the seat's LABEL
   ends where the strip's right control ends rather than 8px past it. An auto
   left margin, not justify-content on the row, keeps the slip correct at any row
   width: the row is the shipped box, and an auto margin is what a flex item can
   own from this side of the boundary. Both values ride the published variables,
   so a profile that retunes the composer axis retunes this with it. */
html[data-t3nss-preset-trailing] [data-slot='conversation.hero.agentPreset'] > * {
  margin-left: auto;
  margin-right: var(--dsh-composer-dock-inset, 8px);
}

/* The strip aligns on the composer's shared width axis: the card's CONTENT box,
   not the card itself. DSH publishes the three numbers that define that axis —
   the stack's side clearance, the dock inset, and the card cap — and the shipped
   QueueDock derives its width the same way. With the defaults (16 / 8 / 877px)
   the strip's border box lands on 506..1367, which is exactly the HeroShell
   stack's box and the composer tool row's content box: the attach button's left
   edge and the send button's right edge. Two details are load-bearing:

     - box-sizing. Without it the horizontal padding adds to the 100% and the
       strip overflows its stack by the padding on each side.
     - the width/max-width pair. In the hero the stack is already inset by one
       side clearance per edge, so both clearances come off; in an active session
       the stack is the full seat width and max-width does the clamping, while
       margin-inline auto centres the result on the card's axis. Either way the
       strip is 861px wide starting at 506. */
.t3nss-strip {
  box-sizing: border-box;
  flex: none;
  /* T3 keeps its context strip under the card (-mt-4 + pt-5 nets a 4px gap).
     DSH has no seat below the card on the blank-session hero, but the strip is a
     flex item of the composer stack — every wrapper the renderer puts around a
     slot occupant is a contents-only box — so ordering it after them renders it
     below the card while leaving the card first in authoring order. */
  order: 2;
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  min-width: 0;
  width: calc(
    100% -
    var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) -
    var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)
  );
  max-width: calc(
    var(--dsh-composer-card-max-width) -
    var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset)
  );
  margin: 0 auto;
  padding: 0 var(--dsh-composer-dock-inset);
  color: var(--dsw-alias-label-caption); font-size: 12px;
}
/* Both phases want the strip's text 4px under the card; the stack gap differs
   between them (8px on the hero, 6px on an active composer), so the pull-up
   differs with it. */
.t3nss-strip[data-phase='hero'] { margin-top: -4px; }
.t3nss-strip[data-phase='active'] { margin-top: -2px; }

.t3nss-stripLeft { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.t3nss-stripLeft > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3nss-stripRight {
  display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 60%;
  height: 24px; padding: 0 6px; border: none; border-radius: 7px; background: transparent;
  color: var(--dsw-alias-label-caption); font-family: inherit; font-size: 12px; cursor: pointer;
}
.t3nss-stripRight:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.t3nss-stripRight:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }
.t3nss-stripRight:disabled { cursor: default; opacity: 0.7; }
.t3nss-stripGlyph { flex: 0 0 auto; opacity: 0.7; }
.t3nss-stripBranch { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.t3nss-card {
  z-index: 1200; display: flex; flex-direction: column; overflow: hidden;
  padding: 4px; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2));
  backdrop-filter: var(--dsw-menu-backdrop-filter, none);
  box-shadow: var(--dsw-elevation-prominent);
  color: var(--dsw-alias-label-primary); font-family: var(--dsw-font-family);
  font-size: 13px; max-height: min(22rem, 70vh);
}
.t3nss-cardHead {
  padding: 6px 8px 4px; color: var(--dsw-alias-label-caption);
  font-size: 11px; font-weight: 600; letter-spacing: 0.02em;
}
.t3nss-list { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
.t3nss-row {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 7px 8px; border: none; border-radius: 8px; background: transparent;
  color: inherit; font-family: inherit; font-size: 13px; line-height: 1.3;
  text-align: left; cursor: pointer;
}
.t3nss-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.t3nss-row:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--dsw-alias-border-l3); }
.t3nss-row:disabled { opacity: 0.55; cursor: default; }
.t3nss-rowOn { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
.t3nss-rowGlyph { flex: 0 0 auto; opacity: 0.75; }
.t3nss-rowMain { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.t3nss-rowName { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t3nss-rowHint { color: var(--dsw-alias-label-caption); font-size: 11px; }
.t3nss-rowTag { flex: 0 0 auto; color: var(--dsw-alias-label-caption); font-size: 10px; opacity: 0.8; }
.t3nss-rowCheck { flex: 0 0 auto; color: var(--dsw-alias-label-primary); }
.t3nss-sep { height: 1px; margin: 4px 2px; background: var(--dsw-alias-border-l1); }
.t3nss-empty { padding: 10px; color: var(--dsw-alias-label-caption); font-size: 12px; }
.t3nss-error {
  margin: 4px; padding: 6px 8px; border-radius: 8px; font-size: 11px; line-height: 1.4;
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  color: var(--dsw-alias-label-secondary);
}
.t3nss-search {
  display: flex; align-items: center; gap: 6px; padding: 6px 8px; margin-bottom: 2px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.t3nss-searchIcon { flex: 0 0 auto; opacity: 0.6; }
.t3nss-searchInput {
  flex: 1 1 auto; min-width: 0; border: none; outline: none; background: transparent;
  color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 13px; padding: 2px 0;
}
.t3nss-searchInput::placeholder { color: var(--dsw-alias-label-caption); }
`

    // ------------------------------------------------------------------- apply

    /** The face a seat with no resolvable model directory reads. */
    const INERT_DIRECTORY = createStore({
      current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
    })

    /**
     * Required client services. `remote` and `remote.session` are load-bearing
     * rather than incidental: `modelDirectories.directoryFor` resolves through
     * the caller-context tracker, so a plugin that reads the model directory
     * must hold the same remote namespace the directory itself is built on —
     * without it the call throws `cannot get property "remote.session" without
     * inject` and the effort control silently disappears.
     */
    const inject = [
      'slots', 'locale', 'sessions', 'modelDirectories', 'remote', 'remote.session',
      'workspaces', 'uiWorkspace',
    ]

    /**
     * The effort seat's data face. `directoryFor` throws for a session with no
     * resolved scope, and a seat must never take the composer down with it.
     * @param ctx - the client context.
     * @param sessionId - the seat's session.
     * @returns the face, or null when the session has no directory.
     */
    function effortFace(ctx, sessionId) {
      try {
        const directory = ctx.modelDirectories.directoryFor(sessionId)
        const available = ctx.sessions.subagentAddress(sessionId) === undefined
        return {
          available,
          directory: directory.store,
          load: () => {
            if (available) directory.load().catch(() => { /* surfaced on the store */ })
          },
          select: selection => (available ? directory.select(selection) : Promise.resolve(undefined)),
        }
      } catch {
        // A session with no resolved scope has no directory and no control; the
        // inert face keeps the seat's hook order intact.
        return {
          available: false,
          directory: INERT_DIRECTORY,
          load: () => {},
          select: () => Promise.resolve(undefined),
        }
      }
    }

    /**
     * The branch strip's face: the session's working directory.
     * @param ctx - the client context.
     * @param sessionId - the seat's session.
     * @returns the face.
     */
    function branchFace(ctx, sessionId) {
      return { cwd: ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd ?? null }
    }

    /**
     * Client plugin body: register the dictionaries and the screen's seats.
     * @param ctx - the plugin's client context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 't3-new-session: dictionaries')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.t3NewSession = ''
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 't3-new-session: styles')

      // The Host's resolved configuration, fetched once. A missing route (the
      // Host half did not load) leaves the defaults seated.
      ctx.effect(() => {
        let live = true
        callApi('config')
          .then((value) => {
            if (!live || value === null || typeof value !== 'object') return
            configStore.set({ ...DEFAULT_CONFIG, ...value })
          })
          .catch(() => { /* defaults already seated */ })
        return () => { live = false }
      }, 't3-new-session: configuration')

      // 1. The headline sentence, in the only additive hole DSH's hero offers.
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
        name: 'conversation.hero.brand.mark',
        locale: NS,
      }, HeroHeadline))

      // 2. The project menu. Priority -1: the same cell as the shipped
      //    WorkspacePicker, one step lower, so this entry is the one that renders.
      ctx.slots.inject('conversation.hero.workspace', () => ctx.slots.register({
        name: 'conversation.hero.workspace',
        priority: -1,
        locale: NS,
        inject: () => ({
          uiWorkspace: ctx.uiWorkspace,
          workspaces: ctx.workspaces,
        }),
      }, ProjectPicker))

      // 3. The reasoning-effort control. Registered on both composer seats; each
      //    occupant renders only on the configured one, so the preference needs
      //    no reload and no re-registration.
      for (const seat of EFFORT_SEATS) {
        ctx.slots.inject(seat, () => ctx.slots.register({
          name: seat,
          id: 't3-new-session-effort',
          order: 20,
          locale: NS,
          inject: sessionId => ({ seat, face: effortFace(ctx, sessionId) }),
        }, EffortPicker))
      }

      // 4. The branch strip, on `conversation.input.dock` for both phases. One
      //    seat is enough: that slot's parent is the composer stack in the hero
      //    AND in an active session, and the strip's `max-width` plus
      //    `margin-inline: auto` centre it on the same axis as the card in both.
      //    Its `order` moves it below the card (see the CSS), which is where T3
      //    keeps its context strip and where DSH's own dock would not fit it.
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 't3-new-session-branch',
        order: 20,
        locale: NS,
        inject: sessionId => branchFace(ctx, sessionId),
      }, BranchPicker))
    }

    // The strip's two seats share one component; `BranchPicker` gates itself on
    // the input-dock owner's session phase (see `props.heroOnly` above).

    return { inject, apply }
  },
})
