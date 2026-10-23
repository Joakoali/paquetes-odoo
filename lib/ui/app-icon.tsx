/**
 * The icon of the app: a parcel with green tape on a dark rounded square. It is drawn with plain divs (no emoji, no
 * font, no image) so that `ImageResponse` turns it into a PNG of any size: the manifest asks for 192 and 512, and iOS
 * takes 180 for the home screen. Every measure is a fraction of `size`, so the three look the same. The colors are
 * the ones of app/globals.css (--text, --surface, --border, --border-strong, --primary), written out because the
 * image renderer does not know CSS variables.
 */
export function AppIcon({ size }: { size: number }) {
  const px = (fraccion: number) => Math.round(size * fraccion)

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        width: size,
        height: size,
        background: '#1d1d1f',
        borderRadius: px(0.22),
      }}
    >
      {/* The body of the box; the lid goes over its top edge. */}
      <div
        style={{
          position: 'absolute',
          left: px(0.22),
          top: px(0.4),
          width: px(0.56),
          height: px(0.36),
          background: '#e5e5ea',
          borderBottomLeftRadius: px(0.035),
          borderBottomRightRadius: px(0.035),
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: px(0.18),
          top: px(0.28),
          width: px(0.64),
          height: px(0.15),
          background: '#ffffff',
          borderRadius: px(0.035),
        }}
      />
      {/* The tape, from the top of the lid to the bottom of the box. */}
      <div
        style={{
          position: 'absolute',
          left: px(0.45),
          top: px(0.28),
          width: px(0.1),
          height: px(0.48),
          background: '#0a7d32',
        }}
      />
      {/* The shipping label. */}
      <div
        style={{
          position: 'absolute',
          left: px(0.58),
          top: px(0.6),
          width: px(0.14),
          height: px(0.08),
          background: '#c7c7cc',
          borderRadius: px(0.01),
        }}
      />
    </div>
  )
}
