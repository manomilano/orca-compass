import type { Theme } from 'vitepress'
// The default theme without its bundled Inter font: OrcaCompass ships its own faces.
import DefaultTheme from 'vitepress/theme-without-fonts'

import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/docs.css'

import Layout from './Layout.vue'

import CaptionBox from './components/ui/CaptionBox.vue'
import ComicPanel from './components/ui/ComicPanel.vue'
import CompassButton from './components/ui/CompassButton.vue'
import CompassMark from './components/ui/CompassMark.vue'
import PanelGrid from './components/ui/PanelGrid.vue'
import RouteLine from './components/ui/RouteLine.vue'
import SectionHeading from './components/ui/SectionHeading.vue'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    // Global primitives: usable in any .vue file or Markdown page without an import.
    app.component('CaptionBox', CaptionBox)
    app.component('ComicPanel', ComicPanel)
    app.component('CompassButton', CompassButton)
    app.component('CompassMark', CompassMark)
    app.component('PanelGrid', PanelGrid)
    app.component('RouteLine', RouteLine)
    app.component('SectionHeading', SectionHeading)
  },
} satisfies Theme
