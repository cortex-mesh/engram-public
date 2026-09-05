"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Building2,
  Users,
  AppWindow,
  Flag,
  Shield,
  ClipboardList,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  description: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "Overview",
    href: "/admin",
    icon: LayoutDashboard,
    description: "Hosted platform summary",
  },
  {
    label: "Clients",
    href: "/admin/clients",
    icon: Building2,
    description: "Organizations, members, apps",
  },
  {
    label: "Users",
    href: "/admin/users",
    icon: Users,
    description: "Global user directory",
  },
  {
    label: "Waitlist",
    href: "/admin/waitlist",
    icon: ClipboardList,
    description: "Client-tagged access requests",
  },
  {
    label: "Apps",
    href: "/admin/apps",
    icon: AppWindow,
    description: "Hosted app catalog",
  },
  {
    label: "Feature flags",
    href: "/admin/features",
    icon: Flag,
    description: "Org-level feature rollout",
  },
];

export default function AdminSidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-border bg-card/40">
      <div className="border-b border-border px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <div className="text-sm font-semibold">CORTEX admin</div>
            <div className="text-xs text-muted-foreground">Hosted suite control plane</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-3">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-start gap-3 rounded-xl border px-3 py-3 transition-colors",
                active
                  ? "border-primary/30 bg-primary/10 text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{item.label}</div>
                <div className="text-xs text-muted-foreground">{item.description}</div>
              </div>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
