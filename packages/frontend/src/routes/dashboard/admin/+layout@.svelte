<script lang="ts">
    import { page } from "$app/state";
    import {
        LayoutDashboard,
        Users,
        Building2,
        FolderKanban,
        Settings,
        KeyRound,
        HeartPulse,
        BarChart3,
    } from "@lucide/svelte";
    import Menu from "@lucide/svelte/icons/menu";
    import X from "@lucide/svelte/icons/x";
    import { cn } from "$lib/utils";
    import Footer from "$lib/components/Footer.svelte";
    import type { Snippet } from "svelte";

    let { children }: { children: Snippet } = $props();

    const navigation = [
        {
            name: "Dashboard",
            href: "/dashboard/admin",
            icon: LayoutDashboard,
        },
        {
            name: "System Health",
            href: "/dashboard/admin/system-health",
            icon: HeartPulse,
        },
        {
            name: "User Management",
            href: "/dashboard/admin/users",
            icon: Users,
        },
        {
            name: "Organizations",
            href: "/dashboard/admin/organizations",
            icon: Building2,
        },
        {
            name: "Projects",
            href: "/dashboard/admin/projects",
            icon: FolderKanban,
        },
        {
            name: "Auth Providers",
            href: "/dashboard/admin/auth-providers",
            icon: KeyRound,
        },
        {
            name: "Usage",
            href: "/dashboard/admin/usage",
            icon: BarChart3,
        },
        {
            name: "Settings",
            href: "/dashboard/admin/settings",
            icon: Settings,
        },
    ];

    const currentPath = $derived(page.url.pathname);

    function isActive(href: string) {
        if (href === "/dashboard/admin") {
            return currentPath === "/dashboard/admin";
        }
        return currentPath.startsWith(href);
    }

    let mobileMenuOpen = $state(false);

    // Close the drawer whenever navigation happens (pathname change).
    $effect(() => {
        currentPath;
        mobileMenuOpen = false;
    });

    // Lock body scroll while the drawer is open on mobile.
    $effect(() => {
        if (typeof document === 'undefined') return;
        if (mobileMenuOpen) {
            document.body.style.overflow = 'hidden';
        } else {
            document.body.style.overflow = '';
        }
        return () => {
            document.body.style.overflow = '';
        };
    });

    const currentNavItem = $derived(
        navigation.find((n) =>
            n.href === "/dashboard/admin" ? currentPath === n.href : currentPath.startsWith(n.href),
        ),
    );
</script>

<div class="flex h-screen bg-background">
    <!-- Desktop sidebar (always visible on lg+) -->
    <aside class="hidden lg:flex w-64 border-r bg-card">
        <div class="flex h-full w-full flex-col">
            <div class="border-b p-6">
                <h2 class="text-lg font-semibold">Admin Panel</h2>
                <p class="text-sm text-muted-foreground">System Management</p>
            </div>

            <nav class="flex-1 space-y-1 p-4">
                {#each navigation as item}
                    <a
                        href={item.href}
                        class={cn(
                            "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                            isActive(item.href)
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                    >
                        <item.icon class="h-5 w-5" />
                        {item.name}
                    </a>
                {/each}
            </nav>

            <div class="border-t p-4">
                <a
                    href="/dashboard"
                    class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                    <Settings class="h-5 w-5" />
                    Back to Dashboard
                </a>
            </div>
        </div>
    </aside>

    <!-- Mobile drawer backdrop -->
    {#if mobileMenuOpen}
        <button
            type="button"
            aria-label="Close menu"
            class="fixed inset-0 bg-background/80 backdrop-blur-sm z-40 lg:hidden"
            onclick={() => (mobileMenuOpen = false)}
        ></button>
    {/if}

    <!-- Mobile drawer -->
    <aside
        class={cn(
            "fixed left-0 top-0 h-screen w-64 flex flex-col border-r bg-card z-50 lg:hidden transform transition-transform duration-300 ease-in-out",
            mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
        )}
        aria-hidden={!mobileMenuOpen}
    >
        <div class="border-b p-4 flex items-center justify-between">
            <div>
                <h2 class="text-lg font-semibold">Admin Panel</h2>
                <p class="text-xs text-muted-foreground">System Management</p>
            </div>
            <button
                type="button"
                aria-label="Close menu"
                class="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-muted transition-colors"
                onclick={() => (mobileMenuOpen = false)}
            >
                <X class="h-4 w-4" />
            </button>
        </div>
        <nav class="flex-1 space-y-1 p-4 overflow-y-auto">
            {#each navigation as item}
                <a
                    href={item.href}
                    onclick={() => (mobileMenuOpen = false)}
                    class={cn(
                        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        isActive(item.href)
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                >
                    <item.icon class="h-5 w-5" />
                    {item.name}
                </a>
            {/each}
        </nav>
        <div class="border-t p-4">
            <a
                href="/dashboard"
                onclick={() => (mobileMenuOpen = false)}
                class="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Settings class="h-5 w-5" />
                Back to Dashboard
            </a>
        </div>
    </aside>

    <div class="flex-1 overflow-auto flex flex-col min-w-0">
        <!-- Mobile header with hamburger -->
        <header class="lg:hidden sticky top-0 z-30 flex items-center gap-3 border-b bg-card px-4 py-3">
            <button
                type="button"
                aria-label="Open menu"
                class="h-9 w-9 inline-flex items-center justify-center rounded-md border hover:bg-muted transition-colors"
                onclick={() => (mobileMenuOpen = true)}
            >
                <Menu class="h-4 w-4" />
            </button>
            <div class="min-w-0">
                <p class="text-xs text-muted-foreground leading-none">Admin Panel</p>
                <p class="text-sm font-medium truncate">{currentNavItem?.name ?? "Admin"}</p>
            </div>
        </header>

        <main class="flex-1">
            {@render children()}
        </main>
        <Footer />
    </div>
</div>
