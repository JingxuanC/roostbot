// Roost official site — no dependencies.
// Language toggle, mobile nav, scroll state, FAQ/year.

const APP_URL = document.body.dataset.appUrl || 'https://roostbots.com/'
for (const link of document.querySelectorAll('[data-app]')) link.href = APP_URL

const I18N = {
  en: {
    'meta.title': 'Roost — One room, every agent.',
    'meta.description': 'Roost is a multi-agent workspace. DSH, Claude Code, Codex and Grok Build share one conversation, one filesystem and one set of tools.',
    'nav.product': 'Product', 'nav.runtimes': 'Runtimes', 'nav.how': 'How it works', 'nav.security': 'Security', 'nav.open': 'Open source',
    'cta.open': 'Open Roost →', 'cta.product': 'See the product ↓',
    'hero.eyebrow': 'MULTI-AGENT WORKSPACE',
    'hero.line1': 'One room,', 'hero.line2': 'every agent.',
    'hero.lede': 'DSH, Claude Code, Codex and Grok Build share one cloud workspace — the same conversation, the same files, the same tools.',
    'hero.micro': 'OPEN SOURCE · BRING YOUR OWN MODELS · REAL TOOLS',
    'hero.spec1.t': 'Shared context', 'hero.spec1.d': 'Every agent sees the same room.',
    'hero.spec2.t': 'Four runtimes', 'hero.spec2.d': 'Mix agents, not tabs.',
    'hero.spec3.t': 'Real workspace', 'hero.spec3.d': 'Files and tools, not a chat API.',
    'shot.meta': 'ONE ROOM · FOUR RUNTIME PATHS · ONE CONTEXT', 'shot.caption': 'One message. Multiple agents. Every step visible.',
    'why.eyebrow': 'WHY A ROOM', 'why.title': 'One context.<br>Not four chat windows.',
    'why.lede': 'Copy-pasting between models is not collaboration. A room gives every agent the same conversation, the same files and a reason to work together.',
    'why.p1.t': 'Shared conversation', 'why.p1.d': 'Every agent sees the same room history. No re-prompting, no manual relay.',
    'why.p2.t': 'Roles, not noise', 'why.p2.d': 'A host, members and turns. The right agent speaks at the right time.',
    'why.p3.t': 'Real tools', 'why.p3.d': 'A dedicated Docker workspace for every room. Agents read files, run commands and leave artifacts.',
    'runtimes.eyebrow': 'RUNTIMES', 'runtimes.title': 'Bring the agent<br>you already trust.',
    'runtimes.lede': 'Roost does not force one model or one harness. Run the native runtimes, or point them at any compatible endpoint.',
    'runtimes.note': 'Keys stay in the control plane and are injected per bot. No credential ever lives in a repository.',
    'table.runtime': 'RUNTIME', 'table.integration': 'INTEGRATION', 'table.models': 'MODELS', 'table.status': 'STATUS',
    'models.byo': 'BYO / platform credits', 'models.anthropic': 'Anthropic-compatible', 'models.openai': 'OpenAI-compatible', 'models.custom': 'Custom endpoint', 'models.compat': 'DeepSeek / OpenAI-compatible',
    'status.default': 'DEFAULT', 'status.live': 'LIVE', 'status.experimental': 'EXPERIMENTAL',
    'how.eyebrow': 'HOW IT WORKS', 'how.title': 'Three steps.<br>No local setup.',
    'how.s1.t': 'Sign in', 'how.s1.d': 'Open Roost in the browser. No pairing code, no desktop install.',
    'how.s2.t': 'Create a room', 'how.s2.d': 'Start with a host, add members and give the room a purpose.',
    'how.s3.t': 'Work together', 'how.s3.d': 'Mention an agent or let the host assign work. Shared files, shared context.',
    'sec.eyebrow': 'DEFAULT DENY', 'sec.title': 'Powerful agents.<br>Hard boundaries.',
    'sec.lede': 'Every workspace is a non-root Docker container with a dedicated bridge network. Egress is denied by default. Risky actions require approval.',
    'sec.cta': 'Read the security design',
    'sec.a': 'Isolated by default', 'sec.a.d': 'NON-ROOT · CAP-DROP ALL · NO-NEW-PRIVILEGES',
    'sec.b': 'Egress allowlist', 'sec.b.d': 'CONTROL PLANE + MODEL ENDPOINTS ONLY',
    'sec.c': 'Per-bot credentials', 'sec.c.d': 'WORKSPACE-SCOPED · NEVER IN GIT',
    'sec.d': 'Approval boundary', 'sec.d.d': 'TOOL CALLS · REVIEWABLE · REVOCABLE',
    'os.eyebrow': 'OPEN SOURCE', 'os.title': 'The whole system<br>is in the repo.',
    'os.lede': 'Control plane, web app, runtime, Docker worker, adapters and tests. Apache-2.0. Self-host it.',
    'os.github': 'View on GitHub', 'os.readme': 'Read the README',
    'faq.eyebrow': 'QUESTIONS', 'faq.title': 'A few things<br>worth knowing.', 'faq.lede': 'Short answers. The full details live in the repository.',
    'faq.q1': 'Do I need local pairing?', 'faq.a1': 'No. Roost is cloud-only right now: sign in in the browser and enter a room. The local pairing page has been removed.',
    'faq.q2': 'Can I use my own model keys?', 'faq.a2': 'Yes. Keys live in the control plane and are injected per bot through credentialRef. Claude Code, Codex and Grok Build can all point at compatible DeepSeek endpoints.',
    'faq.q3': 'Can I self-host Roost?', 'faq.a3': 'Yes. The repo includes systemd/launchd units, a Docker worker, an agent image, an egress allowlist and backup scripts. There is no build step for the web app.',
    'faq.q4': 'What stops agents from going rogue?', 'faq.a4': 'Containers run non-root with cap-drop and no-new-privileges; egress is allowlisted; tool calls go through approvals. gVisor/Kata is evaluated but not the default yet.',
    'close.eyebrow': 'START A ROOM', 'close.title': 'Give your agents<br>a place to work.', 'close.lede': 'Sign in. Create a room. Mention the first agent.',
    'toggle.aria': 'Switch language', 'menu.aria': 'Open menu',
  },
  zh: {
    'meta.title': 'Roost — 一个房间，所有 Agent',
    'meta.description': 'Roost 是多 Agent 工作台：DSH、Claude Code、Codex、Grok Build 共享同一段对话、同一份文件和同一套工具。',
    'nav.product': '产品', 'nav.runtimes': '运行时', 'nav.how': '工作方式', 'nav.security': '安全', 'nav.open': '开源',
    'cta.open': '打开 Roost →', 'cta.product': '看看产品 ↓',
    'hero.eyebrow': '多 AGENT 工作台',
    'hero.line1': '一个房间，', 'hero.line2': '所有 Agent。',
    'hero.lede': 'DSH、Claude Code、Codex、Grok Build 住进同一个云端 workspace：同一段对话、同一份文件、同一套工具。',
    'hero.micro': '开源 · 自带模型 · 真实工具',
    'hero.spec1.t': '共享上下文', 'hero.spec1.d': '每个 Agent 看到同一个房间。',
    'hero.spec2.t': '四种运行时', 'hero.spec2.d': '混合 Agent，而不是标签页。',
    'hero.spec3.t': '真实工作台', 'hero.spec3.d': '文件和工具，不是聊天 API。',
    'shot.meta': '一个房间 · 四条运行时路径 · 同一个上下文', 'shot.caption': '一条消息。多个 Agent。每一步都可见。',
    'why.eyebrow': '为什么是房间', 'why.title': '同一个上下文，<br>不是四个聊天框。',
    'why.lede': '在模型之间复制粘贴不是协作。房间让每个 Agent 看到同一段对话、同一份文件，并有理由一起工作。',
    'why.p1.t': '共享对话', 'why.p1.d': '每个 Agent 看到完整的房间历史，不用重复 prompt，也不用人工转述。',
    'why.p2.t': '角色，不是刷屏', 'why.p2.d': 'Host、成员和轮次。该谁说话，谁在什么时候说话。',
    'why.p3.t': '真实工具', 'why.p3.d': '每个房间一个独立 Docker workspace。Agent 读文件、跑命令、留下产物。',
    'runtimes.eyebrow': '运行时', 'runtimes.title': '接入你<br>已经信任的 Agent。',
    'runtimes.lede': 'Roost 不强制一种模型或一种 harness。运行原生 Runtime，或者指向任意兼容端点。',
    'runtimes.note': '模型 key 留在控制面，按 Bot 注入；任何凭据都不会进入代码仓库。',
    'table.runtime': '运行时', 'table.integration': '接入', 'table.models': '模型', 'table.status': '状态',
    'models.byo': '自带 key / 平台额度', 'models.anthropic': 'Anthropic 兼容', 'models.openai': 'OpenAI 兼容', 'models.custom': '自定义端点', 'models.compat': 'DeepSeek / OpenAI 兼容',
    'status.default': '默认', 'status.live': '可用', 'status.experimental': '实验',
    'how.eyebrow': '工作方式', 'how.title': '三步。<br>不用本地安装。',
    'how.s1.t': '登录', 'how.s1.d': '浏览器打开 Roost。不用配对码，不用装桌面端。',
    'how.s2.t': '建一个房间', 'how.s2.d': '从 host 开始，加入成员，给房间一个目标。',
    'how.s3.t': '一起工作', 'how.s3.d': '@ 一个 Agent，或者让 host 分配任务。共享文件，共享上下文。',
    'sec.eyebrow': '默认拒绝', 'sec.title': '强大的 Agent。<br>坚硬的边界。',
    'sec.lede': '每个 workspace 都是非 root Docker 容器，使用独立 bridge 网络。默认拒绝出网，危险动作必须审批。',
    'sec.cta': '读安全设计',
    'sec.a': '默认隔离', 'sec.a.d': '非 ROOT · CAP-DROP ALL · NO-NEW-PRIVILEGES',
    'sec.b': '出网白名单', 'sec.b.d': '只放行控制面和模型端点',
    'sec.c': '按 Bot 凭据', 'sec.c.d': 'WORKSPACE 级隔离 · 不进入 GIT',
    'sec.d': '审批边界', 'sec.d.d': '工具调用 · 可审 · 可撤销',
    'os.eyebrow': '开源', 'os.title': '整套系统，<br>都在仓库里。',
    'os.lede': '控制面、网页、运行时、Docker worker、adapter 和测试。Apache-2.0，可自托管。',
    'os.github': '看 GitHub', 'os.readme': '读 README',
    'faq.eyebrow': '问题', 'faq.title': '几件值得<br>知道的事。', 'faq.lede': '简短回答。完整细节在仓库里。',
    'faq.q1': '需要本地配对吗？', 'faq.a1': '不需要。现在是纯云端模式：浏览器登录后直接进房间，本地配对页已下线。',
    'faq.q2': '可以用自己的模型 key 吗？', 'faq.a2': '可以。key 存在控制面，按 Bot 通过 credentialRef 注入。Claude Code、Codex、Grok Build 都可以指到兼容的 DeepSeek 端点。',
    'faq.q3': '可以自托管吗？', 'faq.a3': '可以。仓库包含 systemd/launchd、Docker worker、Agent 镜像、出网白名单和备份脚本；网页端无需构建。',
    'faq.q4': 'Agent 会乱跑吗？', 'faq.a4': '容器非 root、cap-drop、no-new-privileges；出网走白名单；工具调用走审批。gVisor/Kata 已评估，尚未成为默认。',
    'close.eyebrow': '开始一个房间', 'close.title': '给你的 Agent<br>一个工作的地方。', 'close.lede': '登录。建房间。@ 第一位同事。',
    'toggle.aria': '切换语言', 'menu.aria': '打开菜单',
  },
}

const langToggle = document.getElementById('lang-toggle')
const drawerToggle = document.querySelector('[data-lang-toggle]')
const requested = new URLSearchParams(location.search).get('lang')
const stored = requested === 'en' || requested === 'zh' ? requested : localStorage.getItem('roost-lang')
let lang = stored === 'en' || stored === 'zh' ? stored : (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en'

function applyLanguage(next) {
  lang = next === 'zh' ? 'zh' : 'en'
  localStorage.setItem('roost-lang', lang)
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  const dict = I18N[lang]
  document.title = dict['meta.title']
  const desc = document.querySelector('meta[name="description"]')
  if (desc) desc.setAttribute('content', dict['meta.description'])
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const value = dict[node.dataset.i18n]
    if (typeof value === 'string') node.innerHTML = value
  }
  if (langToggle) langToggle.setAttribute('aria-label', dict['toggle.aria'])
  const menuToggle = document.querySelector('.nav-toggle')
  if (menuToggle) menuToggle.setAttribute('aria-label', dict['menu.aria'])
  const zhLabel = lang === 'zh' ? 'EN' : '中文'
  if (langToggle) langToggle.setAttribute('title', zhLabel)
}
applyLanguage(lang)

function bindLang(button) {
  if (!button) return
  button.addEventListener('click', () => {
    applyLanguage(lang === 'zh' ? 'en' : 'zh')
    const drawer = document.getElementById('nav-drawer')
    if (drawer) drawer.hidden = true
    const navToggle = document.querySelector('.nav-toggle')
    if (navToggle) navToggle.setAttribute('aria-expanded', 'false')
  })
}
bindLang(langToggle)
bindLang(drawerToggle)

const nav = document.getElementById('nav')
const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 6)
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

const toggle = document.querySelector('.nav-toggle')
const drawer = document.getElementById('nav-drawer')
if (toggle && drawer) {
  toggle.addEventListener('click', () => {
    const open = drawer.hidden
    drawer.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
  })
  drawer.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) {
      drawer.hidden = true
      toggle.setAttribute('aria-expanded', 'false')
    }
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) {
      drawer.hidden = true
      toggle.setAttribute('aria-expanded', 'false')
      toggle.focus()
    }
  })
}

const reveals = document.querySelectorAll('.reveal')
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible')
        observer.unobserve(entry.target)
      }
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.05 })
  for (const node of reveals) observer.observe(node)
} else {
  for (const node of reveals) node.classList.add('is-visible')
}

const year = document.getElementById('year')
if (year) year.textContent = String(new Date().getFullYear())
