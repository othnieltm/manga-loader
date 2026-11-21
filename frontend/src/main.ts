import './style.css'

type Chapter = {
  title: string
  url: string
}

const API_BASE = ''
const DEFAULT_SOURCE = 'https://tcbonepiecechapters.com/'

const state: {
  chapters: Chapter[]
  selectedUrl: string | null
  selectedTitle: string | null
  pages: string[]
  isLoadingChapter: boolean
  isExportingPdf: boolean
} = {
  chapters: [],
  selectedUrl: null,
  selectedTitle: null,
  pages: [],
  isLoadingChapter: false,
  isExportingPdf: false,
}

const app = document.querySelector<HTMLDivElement>('#app')

if (!app) {
  throw new Error('App container not found.')
}

app.innerHTML = `
  <div class="app-shell">
    <header class="site-header">
      <a class="wordmark" href="#" aria-label="Panel Archive home">
        <span class="wordmark-mark" aria-hidden="true">P</span>
        <span>PANEL<span class="wordmark-light">/</span>ARCHIVE</span>
      </a>
      <div class="header-meta">
        <span class="status-dot" aria-hidden="true"></span>
        <span>FIELD NOTES / 001</span>
      </div>
      <span class="header-location">INDEPENDENT MANGA INDEX</span>
    </header>

    <main>
      <section class="intro">
        <p class="eyebrow"><span>01</span> / THE READING ROOM</p>
        <div class="intro-grid">
          <h1>Stories in<br /><span>sequence.</span></h1>
          <div class="intro-aside">
            <p>A considered space to find a chapter, follow the frames, and keep a record of what you read.</p>
            <span class="intro-index">LATEST RELEASES <span id="intro-count">00</span></span>
          </div>
        </div>
        <div class="source-row">
          <div class="source-control">
            <span class="source-label">SOURCE</span>
            <label class="sr-only" for="site-url">Source URL</label>
            <input id="site-url" type="url" value="${DEFAULT_SOURCE}" aria-label="TCB source URL" />
          </div>
          <div class="header-tools">
            <button id="load-latest" class="primary-button" type="button">
              <span>Load latest</span><span class="button-arrow" aria-hidden="true">↗</span>
            </button>
            <button id="download-pdf" class="secondary-button" type="button" disabled>
              <span class="download-icon" aria-hidden="true">↓</span><span>Download PDF</span>
            </button>
            <p id="export-status" class="export-status" role="status" aria-live="polite"></p>
          </div>
        </div>
      </section>

      <section class="layout" aria-label="Chapter archive and reader">
        <aside class="sidebar panel">
          <div class="panel-header">
            <div>
              <p class="section-kicker">01 / THE INDEX</p>
              <h2>Latest chapters</h2>
            </div>
            <span id="chapter-count" class="count-pill">0</span>
          </div>
          <ul id="chapter-list" class="chapter-list"></ul>
          <div class="sidebar-foot">
            <span class="status-dot" aria-hidden="true"></span>
            <span>LIVE FROM SOURCE</span>
          </div>
        </aside>

        <section class="reader panel" aria-label="Selected chapter">
          <div class="reader-heading">
            <p class="section-kicker">02 / THE READER</p>
            <div class="reader-heading-actions">
              <span class="reader-note">SCROLL TO EXPLORE <span aria-hidden="true">↓</span></span>
              <button id="open-fullscreen-reader" class="fullscreen-reader-button" type="button" disabled>
                Fullscreen
              </button>
            </div>
          </div>
          <div id="chapter-details" class="chapter-details empty">
            <div class="empty-mark" aria-hidden="true">P/</div>
            <p>Select a chapter<br />to begin reading.</p>
          </div>
          <div id="page-grid" class="page-grid"></div>
        </section>
      </section>

      <footer class="site-footer">
        <span>PANEL / ARCHIVE</span>
        <span>AN INDEX OF SEQUENTIAL ART</span>
        <span>EST. MMXXVI</span>
      </footer>
  </div>
`

const chapterList = document.querySelector<HTMLUListElement>('#chapter-list')!
const chapterCount = document.querySelector<HTMLSpanElement>('#chapter-count')!
const introCount = document.querySelector<HTMLSpanElement>('#intro-count')!
const chapterDetails = document.querySelector<HTMLDivElement>('#chapter-details')!
const pageGrid = document.querySelector<HTMLDivElement>('#page-grid')!
const siteUrlInput = document.querySelector<HTMLInputElement>('#site-url')!
const loadLatestButton = document.querySelector<HTMLButtonElement>('#load-latest')!
const downloadPdfButton = document.querySelector<HTMLButtonElement>('#download-pdf')!
const exportStatus = document.querySelector<HTMLParagraphElement>('#export-status')!
const openFullscreenReaderButton = document.querySelector<HTMLButtonElement>('#open-fullscreen-reader')!

let isLoadingNewest = false
let chapterRequestId = 0
let fullscreenCleanup: (() => void) | null = null

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`)

  if (!response.ok) {
    if (response.headers.get('content-type')?.includes('application/json')) {
      const payload = await response.json() as { error?: string }
      if (payload.error) throw new Error(payload.error)
    }
    throw new Error(`Request failed with status ${response.status}`)
  }

  return (await response.json()) as T
}

function renderChapterList() {
  chapterList.innerHTML = ''
  chapterCount.textContent = String(state.chapters.length)
  introCount.textContent = String(state.chapters.length).padStart(2, '0')

  if (!state.chapters.length) {
    const emptyItem = document.createElement('li')
    emptyItem.className = 'empty-state'
    emptyItem.textContent = 'No chapters found.'
    chapterList.append(emptyItem)
    return
  }

  for (const chapter of state.chapters) {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'chapter-button'

    if (state.selectedUrl === chapter.url) {
      button.classList.add('selected')
    }

    button.innerHTML = `<span class="chapter-title">${escapeHtml(chapter.title)}</span>`
    button.addEventListener('click', () => void selectChapter(chapter))
    button.setAttribute('aria-pressed', String(state.selectedUrl === chapter.url))
    item.append(button)
    chapterList.append(item)
  }
}

function renderDetails(title: string, pageCount: number) {
  chapterDetails.classList.remove('empty')
  chapterDetails.innerHTML = `
    <div class="detail-header">
      <h2>${escapeHtml(title)}</h2>
      <span class="count-pill">${pageCount} pages</span>
    </div>
  `
}

function updatePdfButton() {
  downloadPdfButton.disabled =
    state.isLoadingChapter || state.isExportingPdf || !state.selectedUrl || state.pages.length === 0
  openFullscreenReaderButton.disabled =
    state.isLoadingChapter || !state.selectedUrl || state.pages.length === 0
}

function openFullscreenReader(initialMode: 'vertical' | 'side' = 'vertical') {
  if (!state.pages.length) return

  if (fullscreenCleanup) {
    fullscreenCleanup()
  }

  let mode = initialMode
  let currentIndex = 0
  let wheelLocked = false
  let touchStartX = 0
  let touchStartY = 0
  let controlsTimer = 0

  const overlay = document.createElement('div')
  overlay.className = 'fullscreen-reader'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.setAttribute('aria-label', 'Fullscreen manga reader')
  overlay.innerHTML = `
    <div class="fullscreen-controls" id="fullscreen-controls">
      <button id="fullscreen-prev" type="button" aria-label="Previous page">←</button>
      <div class="fullscreen-mode-switch" aria-label="Reading mode">
        <button id="fullscreen-vertical" type="button" class="${mode === 'vertical' ? 'active' : ''}">Vertical</button>
        <button id="fullscreen-side" type="button" class="${mode === 'side' ? 'active' : ''}">Side by side</button>
      </div>
      <span id="fullscreen-counter" class="fullscreen-counter">1 / ${state.pages.length}</span>
      <button id="fullscreen-next" type="button" aria-label="Next page">→</button>
      <button id="fullscreen-close" type="button" aria-label="Exit fullscreen">×</button>
    </div>
    <div id="fullscreen-pages" class="fullscreen-pages vertical"></div>
  `

  document.body.append(overlay)
  document.body.classList.add('fullscreen-open')

  const pagesElement = overlay.querySelector<HTMLDivElement>('#fullscreen-pages')!
  const controls = overlay.querySelector<HTMLDivElement>('#fullscreen-controls')!
  const counter = overlay.querySelector<HTMLSpanElement>('#fullscreen-counter')!
  const prevButton = overlay.querySelector<HTMLButtonElement>('#fullscreen-prev')!
  const nextButton = overlay.querySelector<HTMLButtonElement>('#fullscreen-next')!
  const verticalButton = overlay.querySelector<HTMLButtonElement>('#fullscreen-vertical')!
  const sideButton = overlay.querySelector<HTMLButtonElement>('#fullscreen-side')!
  const closeButton = overlay.querySelector<HTMLButtonElement>('#fullscreen-close')!

  function renderMode() {
    pagesElement.className = `fullscreen-pages ${mode}`
    pagesElement.innerHTML = ''

    state.pages.forEach((pageUrl, index) => {
      const page = document.createElement('div')
      page.className = 'fullscreen-page'
      page.dataset.index = String(index)

      const image = document.createElement('img')
      image.src = pageUrl
      image.alt = `Page ${index + 1}`
      image.draggable = false
      page.append(image)
      pagesElement.append(page)
    })

    verticalButton.classList.toggle('active', mode === 'vertical')
    sideButton.classList.toggle('active', mode === 'side')
    currentIndex = Math.min(currentIndex, state.pages.length - 1)
    updatePosition(false)
  }

  function updatePosition(animateTurn: boolean, direction: 1 | -1 = 1) {
    counter.textContent =
      mode === 'side'
        ? `${currentIndex + 1}${currentIndex + 2 <= state.pages.length ? `–${currentIndex + 2}` : ''} / ${state.pages.length}`
        : `${currentIndex + 1} / ${state.pages.length}`

    prevButton.disabled = currentIndex <= 0
    nextButton.disabled = currentIndex >= state.pages.length - 1

    if (mode === 'vertical') {
      const target = pagesElement.querySelector<HTMLElement>(`.fullscreen-page[data-index="${currentIndex}"]`)
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }

    const target = pagesElement.querySelector<HTMLElement>(`.fullscreen-page[data-index="${currentIndex}"]`)
    if (target) {
      pagesElement.scrollTo({ left: target.offsetLeft, behavior: 'smooth' })
    }

    if (animateTurn) {
      target?.classList.remove('turn-next', 'turn-prev')
      void target?.offsetWidth
      target?.classList.add(direction === 1 ? 'turn-next' : 'turn-prev')
    }
  }

  function goTo(index: number, direction?: 1 | -1) {
    const bounded = Math.max(0, Math.min(state.pages.length - 1, index))
    if (bounded === currentIndex) return
    const resolvedDirection = direction ?? (bounded > currentIndex ? 1 : -1)
    currentIndex = bounded
    updatePosition(true, resolvedDirection)
  }

  function goNext() {
    goTo(currentIndex + (mode === 'side' ? 2 : 1))
  }

  function goPrev() {
    goTo(currentIndex - (mode === 'side' ? 2 : 1))
  }

  function showControls() {
    controls.classList.add('visible')
    window.clearTimeout(controlsTimer)
    controlsTimer = window.setTimeout(() => controls.classList.remove('visible'), 2200)
  }

  function exit() {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else if (fullscreenCleanup) {
      fullscreenCleanup()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault()
      goNext()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault()
      goPrev()
    } else if (event.key === 'Escape') {
      exit()
    }
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (wheelLocked || Math.abs(event.deltaY) + Math.abs(event.deltaX) < 8) return
    wheelLocked = true
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY
    if (delta > 0) goNext()
    else goPrev()
    window.setTimeout(() => { wheelLocked = false }, 550)
  }

  const onTouchStart = (event: TouchEvent) => {
    touchStartX = event.changedTouches[0].clientX
    touchStartY = event.changedTouches[0].clientY
  }

  const onTouchEnd = (event: TouchEvent) => {
    const deltaX = event.changedTouches[0].clientX - touchStartX
    const deltaY = event.changedTouches[0].clientY - touchStartY
    if (Math.abs(deltaX) > 45 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) goNext()
      else goPrev()
    } else if (mode === 'vertical' && Math.abs(deltaY) > 55) {
      if (deltaY < 0) goNext()
      else goPrev()
    }
  }

  const onScroll = () => {
    const pageElements = Array.from(pagesElement.querySelectorAll<HTMLElement>('.fullscreen-page'))
    let nearestIndex = 0
    let nearestDistance = Number.POSITIVE_INFINITY

    pageElements.forEach((page, index) => {
      const distance =
        mode === 'side'
          ? Math.abs(page.offsetLeft - pagesElement.scrollLeft)
          : Math.abs(page.offsetTop - pagesElement.scrollTop)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    })

    if (mode === 'side') {
      const spreadIndex = Math.floor(nearestIndex / 2) * 2
      currentIndex = Math.max(0, Math.min(state.pages.length - 1, spreadIndex))
      counter.textContent =
        `${currentIndex + 1}${currentIndex + 2 <= state.pages.length ? `–${currentIndex + 2}` : ''} / ${state.pages.length}`
    } else {
      currentIndex = Math.max(0, Math.min(state.pages.length - 1, nearestIndex))
      counter.textContent = `${currentIndex + 1} / ${state.pages.length}`
    }
  }

  const onFullscreenChange = () => {
    if (!document.fullscreenElement && fullscreenCleanup) {
      fullscreenCleanup()
    }
  }

  prevButton.addEventListener('click', goPrev)
  nextButton.addEventListener('click', goNext)
  closeButton.addEventListener('click', exit)
  verticalButton.addEventListener('click', () => { mode = 'vertical'; renderMode(); showControls() })
  sideButton.addEventListener('click', () => { mode = 'side'; renderMode(); showControls() })
  overlay.addEventListener('mousemove', showControls)
  overlay.addEventListener('touchstart', onTouchStart, { passive: true })
  overlay.addEventListener('touchend', onTouchEnd, { passive: true })
  overlay.addEventListener('wheel', onWheel, { passive: false })
  pagesElement.addEventListener('scroll', onScroll, { passive: true })
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('fullscreenchange', onFullscreenChange)

  renderMode()
  showControls()

  void overlay.requestFullscreen?.().catch(() => undefined)

  fullscreenCleanup = () => {
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('fullscreenchange', onFullscreenChange)
    window.clearTimeout(controlsTimer)
    overlay.remove()
    document.body.classList.remove('fullscreen-open')
    fullscreenCleanup = null
  }
}

function renderPages() {
  pageGrid.innerHTML = ''

  if (!state.pages.length) {
    pageGrid.innerHTML = '<p class="empty-pages">No pages available.</p>'
    return
  }

  for (let index = 0; index < state.pages.length; index += 1) {
    const pageUrl = state.pages[index]
    const card = document.createElement('figure')
    card.className = 'page-card'

    const image = document.createElement('img')
    image.src = pageUrl
    image.alt = `Page ${index + 1}`
    image.loading = 'lazy'

    const caption = document.createElement('figcaption')
    caption.textContent = `Page ${index + 1}`

    const actions = document.createElement('div')
    actions.className = 'page-actions'

    const openLink = document.createElement('a')
    openLink.href = pageUrl
    openLink.target = '_blank'
    openLink.rel = 'noreferrer'
    openLink.textContent = 'Open'

    const downloadLink = document.createElement('a')
    downloadLink.href = pageUrl
    downloadLink.target = '_blank'
    downloadLink.rel = 'noreferrer'
    downloadLink.download = `page-${index + 1}.png`
    downloadLink.textContent = 'Download'

    actions.append(openLink, downloadLink)
    card.append(image, caption, actions)
    pageGrid.append(card)
  }
}

async function loadLatestChapters() {
  const site = siteUrlInput.value.trim() || DEFAULT_SOURCE

  if (isLoadingNewest) {
    return
  }

  isLoadingNewest = true
  loadLatestButton.disabled = true
  loadLatestButton.textContent = 'Loading...'
  exportStatus.textContent = ''

  try {
    const payload = await fetchJson<{ chapters: Chapter[]; source: string }>(`/api/latest?site=${encodeURIComponent(site)}`)
    state.chapters = payload.chapters
    state.selectedUrl = payload.chapters[0]?.url ?? null

    if (state.chapters.length) {
      await selectChapter(state.chapters[0])
    } else {
      chapterRequestId += 1
      state.selectedUrl = null
      state.selectedTitle = null
      state.isLoadingChapter = false
      chapterDetails.classList.add('empty')
      chapterDetails.innerHTML = '<p>No chapters were found for this source.</p>'
      state.pages = []
      updatePdfButton()
      renderPages()
    }

    renderChapterList()
  } catch (error) {
    chapterRequestId += 1
    chapterDetails.classList.add('empty')
    chapterDetails.innerHTML = `<p>${escapeHtml((error as Error).message || 'Unable to load chapters.')}</p>`
    state.chapters = []
    state.selectedUrl = null
    state.selectedTitle = null
    state.isLoadingChapter = false
    state.pages = []
    updatePdfButton()
    renderPages()
    renderChapterList()
  } finally {
    isLoadingNewest = false
    loadLatestButton.disabled = false
    loadLatestButton.textContent = 'Load latest'
  }
}

async function selectChapter(chapter: Chapter) {
  const requestId = ++chapterRequestId
  state.selectedUrl = chapter.url
  state.selectedTitle = chapter.title
  state.pages = []
  state.isLoadingChapter = true
  exportStatus.textContent = ''
  renderChapterList()
  renderDetails(`Loading ${chapter.title}`, 0)
  pageGrid.innerHTML = '<p class="empty-pages">Loading chapter pages…</p>'
  updatePdfButton()

  try {
    const payload = await fetchJson<{ title: string; pages: string[] }>(`/api/chapter?url=${encodeURIComponent(chapter.url)}`)
    if (requestId !== chapterRequestId) return
    state.pages = payload.pages
    state.selectedTitle = payload.title || chapter.title
    state.isLoadingChapter = false
    renderDetails(state.selectedTitle, payload.pages.length)
    renderPages()
    updatePdfButton()
  } catch (error) {
    if (requestId !== chapterRequestId) return
    state.pages = []
    state.isLoadingChapter = false
    renderDetails(chapter.title, 0)
    chapterDetails.innerHTML += `<p class="error-message">${escapeHtml((error as Error).message || 'Unable to load pages.')}</p>`
    renderPages()
    updatePdfButton()
  }
}

async function downloadChapterPdf() {
  if (!state.selectedUrl || !state.selectedTitle || !state.pages.length || state.isExportingPdf) return

  const chapterUrl = state.selectedUrl
  const chapterTitle = state.selectedTitle
  state.isExportingPdf = true
  downloadPdfButton.textContent = 'Creating PDF…'
  exportStatus.textContent = 'Preparing the selected chapter for download.'
  updatePdfButton()

  try {
    const response = await fetch(`${API_BASE}/api/chapter.pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chapterUrl, title: chapterTitle }),
    })
    if (!response.ok) {
      const payload = await response.json() as { error?: string }
      throw new Error(payload.error || `PDF export failed (${response.status}).`)
    }

    const pdf = await response.blob()
    const signature = new TextDecoder().decode(await pdf.slice(0, 5).arrayBuffer())
    if (signature !== '%PDF-') throw new Error('The server returned an invalid PDF file.')

    const objectUrl = URL.createObjectURL(pdf)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = `${chapterTitle.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'chapter'}.pdf`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
    exportStatus.textContent = 'PDF download started.'
  } catch (error) {
    exportStatus.textContent = (error as Error).message || 'Unable to create the chapter PDF.'
  } finally {
    state.isExportingPdf = false
    downloadPdfButton.textContent = 'Download PDF'
    updatePdfButton()
  }
}

loadLatestButton.addEventListener('click', () => {
  void loadLatestChapters()
})

downloadPdfButton.addEventListener('click', () => {
  void downloadChapterPdf()
})

openFullscreenReaderButton.addEventListener('click', () => {
  openFullscreenReader('side')
})

siteUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void loadLatestChapters()
  }
})

void loadLatestChapters()
