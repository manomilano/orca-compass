<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vitepress'

const route = useRoute()
let observer: ResizeObserver | undefined
let stopWatching: (() => void) | undefined
let mounted = false

async function prepareTables() {
  await nextTick()
  if (!mounted) return
  observer?.disconnect()
  const article = document.querySelector('.VPDoc .vp-doc')
  if (!article) return

  observer = new ResizeObserver((entries) => {
    const measurements = entries.map(({ target }) => {
      const box = target as HTMLElement
      return { box, horizontal: box.scrollWidth > box.clientWidth + 1 }
    })
    for (const { box, horizontal } of measurements) {
      if (box.classList.contains('oc-table-scroll')) {
        box.parentElement?.classList.toggle('has-overflow', horizontal)
        const hint = box.parentElement?.querySelector<HTMLElement>('.oc-table-hint')
        if (horizontal && hint) box.setAttribute('aria-describedby', hint.id)
        else box.removeAttribute('aria-describedby')
      }
      if (horizontal) box.tabIndex = 0
      else box.removeAttribute('tabindex')
    }
  })

  article.querySelectorAll<HTMLTableElement>('table').forEach((table, index) => {
    let scroller = table.closest<HTMLElement>('.oc-table-scroll')
    if (!scroller) {
      const frame = document.createElement('div')
      frame.className = 'oc-table-frame'
      const hint = document.createElement('div')
      hint.className = 'oc-table-hint'
      hint.textContent = 'Scroll across to read table'
      hint.id = `oc-table-hint-${index}`
      scroller = document.createElement('div')
      scroller.className = 'oc-table-scroll'
      scroller.setAttribute('role', 'region')
      scroller.setAttribute('aria-label', `Reference table ${index + 1}: ${Array.from(table.querySelectorAll('th')).map((cell) => cell.textContent).join(', ')}`)
      table.before(frame)
      frame.append(hint, scroller)
      scroller.append(table)
    }
    // The wrapper is the one scrollable keyboard stop; keep native table semantics.
    table.removeAttribute('tabindex')
    observer?.observe(scroller)
  })
  article.querySelectorAll<HTMLElement>('div[class*="language-"] pre').forEach((pre) => {
    pre.setAttribute('aria-label', 'Code example, scroll horizontally for long lines')
    observer?.observe(pre)
  })
}

onMounted(() => {
  mounted = true
  prepareTables()
  document.fonts.ready.then(() => { if (mounted) prepareTables() })
  stopWatching = watch(() => route.path, prepareTables, { flush: 'post' })
})
onBeforeUnmount(() => {
  mounted = false
  observer?.disconnect()
  stopWatching?.()
})
</script>

<template><span hidden aria-hidden="true" /></template>
