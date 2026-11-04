// Roost 官网：无依赖交互。
// 1) 滚动后导航变实底；2) 移动端抽屉；3) section 出现动画；4) 复制命令。

const nav = document.getElementById('nav')
const onScroll = () => {
  if (!nav) return
  nav.classList.toggle('is-scrolled', window.scrollY > 12)
}
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

const toggle = document.querySelector('.nav-toggle')
const drawer = document.getElementById('nav-drawer')
if (toggle && drawer) {
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open))
    drawer.hidden = !open
  }
  toggle.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'))
  drawer.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) setOpen(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !drawer.hidden) {
      setOpen(false)
      toggle.focus()
    }
  })
}

const reveals = document.querySelectorAll('.reveal')
if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        }
      }
    },
    { rootMargin: '0px 0px -12% 0px', threshold: 0.08 }
  )
  for (const node of reveals) observer.observe(node)
} else {
  for (const node of reveals) node.classList.add('is-visible')
}

for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const text = button.getAttribute('data-copy') ?? ''
    try {
      await navigator.clipboard.writeText(text)
      button.textContent = '已复制'
    } catch {
      button.textContent = '复制失败'
    }
    setTimeout(() => {
      button.textContent = '复制'
    }, 1800)
  })
}

const year = document.getElementById('year')
if (year) year.textContent = String(new Date().getFullYear())
