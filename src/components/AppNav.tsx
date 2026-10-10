"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "@/components/BrandMark";
import { Icon } from "@/components/icons";
import { APP_NAV, matchesPrefix } from "@/lib/routes";

/**
 * Main navigation. One <nav> element, laid out by CSS as a bottom tab bar on
 * phones and as a sidebar on wide screens.
 */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="app-nav" aria-label="Main">
      <div className="app-nav__brand">
        <BrandMark href="/dashboard" />
      </div>
      <ul className="app-nav__list">
        {APP_NAV.map((item) => {
          const active = matchesPrefix(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`app-nav__link${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <Icon name={item.icon} size={22} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
