'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tabActiva } from '@/lib/ui/tab-activa'

/** One tab of the bar. `badge` is the number drawn on it; nothing is drawn for 0 or for no number. */
export interface Tab {
  href: string
  label: string
  badge?: number
}

/** From here on the exact number tells nothing more to whoever glances at the bar. */
const BADGE_MAXIMO = 99

/**
 * The tabs of the app. It is the one place that needs to know the pathname, so it is the only part of the shell
 * that is a client component. Where the bar goes (at the bottom on a phone, at the top from 768px) is up to the CSS.
 */
export function NavTabs({ tabs }: { tabs: Tab[] }) {
  const pathname = usePathname()
  const activa = tabActiva(tabs.map((tab) => tab.href), pathname)

  return (
    <nav className="shell-tabs" aria-label="Secciones">
      <ul className="shell-tabs-list">
        {tabs.map(({ href, label, badge }) => (
          <li key={href}>
            <Link href={href} className="shell-tab" aria-current={href === activa ? 'page' : undefined}>
              <span className="shell-tab-label">
                {label}
                {badge ? <span className="shell-tab-badge">{badge > BADGE_MAXIMO ? `${BADGE_MAXIMO}+` : badge}</span> : null}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
