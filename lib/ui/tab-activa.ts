/**
 * Which tab of the bar is the page being looked at: the one whose `href` is the longest start of the pathname,
 * counting whole segments only ("/admin" starts "/admin/operarios", not "/administrar"). The longest, because
 * the admin bar has "/admin/operarios" and "/admin" together: the pages of Operarios must not light "Datos de
 * Odoo" too. Null when the page is none of the tabs.
 */
export function tabActiva(hrefs: readonly string[], pathname: string): string | null {
  let activa: string | null = null
  for (const href of hrefs) {
    const esDeEstaPestana = pathname === href || pathname.startsWith(`${href}/`)
    if (esDeEstaPestana && (activa === null || href.length > activa.length)) activa = href
  }
  return activa
}
