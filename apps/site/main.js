// Roost official site: no dependencies. Nav, mobile drawer, reveal, year.
// Set the app URL once here or override with <body data-app-url="...">.
const APP_URL = document.body.dataset.appUrl || 'https://roostbots.com/'
for (const link of document.querySelectorAll('[data-app]')) link.href = APP_URL

const nav = document.getElementById('nav')
const onScroll = () => nav && nav.classList.toggle('is-scrolled', window.scrollY > 8)
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
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('is-visible')
      observer.unobserve(entry.target)
    }
  }, { rootMargin: '0px 0px -10% 0px', threshold: 0.06 })
  for (const node of reveals) observer.observe(node)
} else {
  for (const node of reveals) node.classList.add('is-visible')
}

const year = document.getElementById('year')
if (year) year.textContent = String(new Date().getFullYear())
