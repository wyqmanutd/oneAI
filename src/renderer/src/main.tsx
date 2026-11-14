import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { isMac } from './platform'

if (isMac) document.documentElement.classList.add('platform-mac')

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
