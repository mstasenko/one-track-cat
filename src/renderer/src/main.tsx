import '@fontsource/anton/400.css'
import '@fontsource/bangers/400.css'
import '@fontsource/bebas-neue/400.css'
import '@fontsource/comic-neue/700.css'
import '@fontsource/lobster/400.css'
import '@fontsource/oswald/600.css'
import '@fontsource/permanent-marker/400.css'
import '@fontsource/roboto/700.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('OneTrackCat root element is missing')

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
