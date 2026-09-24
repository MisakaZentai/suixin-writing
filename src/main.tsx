import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/components.css'
import { App } from './App'
import { customTitlebar } from './lib/platform'
import { applyTypography } from './store/uiStore'

if (customTitlebar) document.documentElement.classList.add('custom-titlebar')
applyTypography()

createRoot(document.getElementById('root')!).render(<App />)
