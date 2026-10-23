import type { MetadataRoute } from 'next'

/**
 * What lets the phone add the app to its home screen and open it like an app (no browser bars). There is no service
 * worker: it works only with a connection, like the rest of the app. The icons are drawn by app/icon-192.png and
 * app/icon-512.png.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Paquetería',
    short_name: 'Paquetería',
    start_url: '/recepcion',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1d1d1f',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }
}
