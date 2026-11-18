<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

// Progressive fixes for default-theme overlays; retain their native controls and routing.
let observer: MutationObserver | undefined
let sidebarObserver: MutationObserver | undefined
let media: MediaQueryList | undefined
let searchMedia: MediaQueryList | undefined
let drawer: HTMLElement | null = null
let modal: HTMLElement | null = null
let modalKind: 'sidebar' | 'navigation' | undefined
let opener: HTMLElement | null = null
const madeInert = new Set<HTMLElement>()

function syncOverlays() {
  const searchButton = document.querySelector<HTMLElement>('.DocSearch-Button')
  // Let visible text (including the shortcut) name the desktop button naturally.
  // The icon-only phone button retains its translated explicit name.
  if (searchButton) {
    if (searchMedia?.matches) searchButton.removeAttribute('aria-label')
    else searchButton.setAttribute('aria-label', searchButton.querySelector('.DocSearch-Button-Placeholder')?.textContent ?? 'Search')
    searchButton.setAttribute('aria-keyshortcuts', document.documentElement.classList.contains('mac') ? 'Meta+K' : 'Control+K')
  }
  const currentDrawer = document.querySelector<HTMLElement>('.VPSidebar')
  if (currentDrawer !== drawer) {
    sidebarObserver?.disconnect()
    drawer = currentDrawer
    if (drawer) sidebarObserver?.observe(drawer, { attributes: true, attributeFilter: ['class'] })
  }
  const sidebarOpen = !!drawer?.classList.contains('open') && !!media?.matches
  const navigationOpen = window.innerWidth < 768 && !!document.querySelector('.VPNavScreen')
  const nextModal = sidebarOpen ? drawer : navigationOpen ? document.querySelector<HTMLElement>('.VPNav') : null
  const search = document.querySelector<HTMLElement>('.VPLocalSearchBox')
  if (search && search.getAttribute('role') !== 'dialog') {
    search.setAttribute('role', 'dialog')
    search.setAttribute('aria-modal', 'true')
    search.removeAttribute('aria-expanded')
    search.removeAttribute('aria-haspopup')
    search.removeAttribute('aria-owns')
  }
  if (nextModal === modal) return
  const restoreFocus = modal?.contains(document.activeElement) || document.activeElement === document.body
  modal?.removeAttribute('role')
  modal?.removeAttribute('aria-modal')
  modal?.removeAttribute('aria-label')
  madeInert.forEach((region) => { region.inert = false })
  madeInert.clear()
  modal = nextModal
  modalKind = sidebarOpen ? 'sidebar' : navigationOpen ? 'navigation' : undefined
  if (modal) {
    opener = document.querySelector<HTMLElement>(sidebarOpen ? '.VPLocalNav .menu' : '.VPNavBarHamburger')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-label', sidebarOpen ? 'Documentation menu' : 'Main navigation')
    const background = sidebarOpen ? '.VPNav, .VPLocalNav, .VPContent, .VPFooter' : '.VPSidebar, .VPLocalNav, .VPContent, .VPFooter'
    document.querySelectorAll<HTMLElement>(background).forEach((region) => {
      if (!region.inert) {
        region.inert = true
        madeInert.add(region)
      }
    })
    modal.querySelector<HTMLElement>(sidebarOpen ? '.oc-sidebar-close' : '.VPNavScreen a')?.focus({ preventScroll: true })
  } else if (media?.matches && restoreFocus) opener?.focus({ preventScroll: true })
}

function containFocus(event: KeyboardEvent) {
  if (!modal || document.querySelector('.VPLocalSearchBox')) return
  if (event.key === 'Escape' && modalKind === 'navigation') {
    opener?.click()
    return
  }
  if (event.key !== 'Tab') return
  const controls = Array.from(modal.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex="0"]'))
    .filter((control) => control.getClientRects().length > 0 && getComputedStyle(control).visibility !== 'hidden')
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || !last) return
  const active = document.activeElement
  if (!modal.contains(active) || (event.shiftKey ? active === first : active === last)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
  }
}

onMounted(() => {
  media = window.matchMedia('(max-width: 959px)')
  searchMedia = window.matchMedia('(min-width: 768px)')
  sidebarObserver = new MutationObserver(syncOverlays)
  observer = new MutationObserver(syncOverlays)
  observer.observe(document.body, { childList: true, subtree: true })
  media.addEventListener('change', syncOverlays)
  searchMedia.addEventListener('change', syncOverlays)
  document.addEventListener('keydown', containFocus)
  syncOverlays()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  sidebarObserver?.disconnect()
  media?.removeEventListener('change', syncOverlays)
  searchMedia?.removeEventListener('change', syncOverlays)
  document.removeEventListener('keydown', containFocus)
  madeInert.forEach((region) => { region.inert = false })
})
</script>

<template><span hidden aria-hidden="true" /></template>
