import { ImageResponse } from 'next/og'
import { AppIcon } from '@/lib/ui/app-icon'

// What iOS puts on the home screen. It has to be a PNG of 180x180.
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
  return new ImageResponse(<AppIcon size={size.width} />, { ...size })
}
