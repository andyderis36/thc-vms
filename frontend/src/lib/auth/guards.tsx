'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { consumeSessionExpiredFlag, useSession } from '@/lib/auth/session';
import { getLoginRedirect } from '@/lib/auth/capabilities';
import type { Role } from '@/lib/api/types';

/**
 * Ranah perlindungan client-side (JWT ada di `localStorage`, tak terbaca
 * server — tidak ada `proxy.ts`/`middleware.ts` by design).
 *
 * Aturan kritis: guard tidak pernah merender `children` terproteksi walau
 * sesaat sebelum redirect. Keputusan redirect dihitung sinkron saat render,
 * navigasi (`router.replace`) dijalankan di `useEffect`.
 */

/**
 * Pilih tujuan login: sesi kedaluwarsa -> `/login?expired=1` (toast sekali),
 * belum pernah login -> `/login` polos (tanpa toast). Flag sekali-pakai
 * dikonsumsi (dihapus) di sini agar toast tidak berulang.
 */
function resolveLoginTarget(): string {
  return consumeSessionExpiredFlag() ? '/login?expired=1' : '/login';
}

function LoadingPlaceholder(): React.JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[40vh] items-center justify-center text-sm text-neutral-500"
    >
      Memuat…
    </div>
  );
}

/**
 * Wajib login. Tanpa sesi -> `/login` polos, sesi kedaluwarsa ->
 * `/login?expired=1` (toast sekali di layar login); render `null`.
 * Dipakai di `/dashboard`, `/visits/new`, `/visits/[id]`, `/gate`.
 */
export function RequireAuth({ children }: { children: ReactNode }): React.JSX.Element | null {
  const { status } = useSession();
  const router = useRouter();

  const unauthenticated = status === 'unauthenticated';

  useEffect(() => {
    if (unauthenticated) {
      // Bedakan sesi kedaluwarsa (?expired=1 -> toast sekali di /login)
      // vs belum pernah login (/login polos tanpa toast).
      router.replace(resolveLoginTarget());
    }
  }, [unauthenticated, router]);

  if (status === 'loading') {
    return <LoadingPlaceholder />;
  }
  if (unauthenticated) {
    return null;
  }
  return <>{children}</>;
}

interface RequireRoleProps {
  allow: readonly Role[];
  children: ReactNode;
}

/**
 * Wajib login + wajib peran. Peran di luar `allow` diarahkan ke home route
 * perannya (`getLoginRedirect` — satu sumber kebenaran) dan render `null`.
 * Contoh: Vendor/Mitra yang membuka `/gate` dipulangkan ke `/dashboard`.
 */
export function RequireRole({ allow, children }: RequireRoleProps): React.JSX.Element | null {
  const { user, status } = useSession();
  const router = useRouter();

  const unauthenticated = status === 'unauthenticated';
  const role: Role | null = user?.role ?? null;
  const denied =
    status === 'authenticated' && role !== null && !allow.includes(role);
  const home: string = role !== null ? getLoginRedirect(role) : '/dashboard';

  useEffect(() => {
    if (unauthenticated) {
      // Sama seperti RequireAuth: expired -> `?expired=1`, baru -> polos.
      router.replace(resolveLoginTarget());
    } else if (denied) {
      router.replace(home);
    }
  }, [unauthenticated, denied, home, router]);

  if (status === 'loading') {
    return <LoadingPlaceholder />;
  }
  if (unauthenticated) {
    return null;
  }
  if (user === null) {
    return null;
  }
  if (denied) {
    return null;
  }
  return <>{children}</>;
}

/**
 * Hook kenyamanan untuk menyembunyikan kontrol per-peran (mis. sembunyikan
 * Approve/Reject dari Vendor/Mitra). Kembalikan peran bila sesi terautentikasi dan
 * peran termasuk `allow`, selain itu `null`. Tidak menavigasi.
 */
export function useRequireRole(allow: readonly Role[]): Role | null {
  const { user, status } = useSession();
  if (status !== 'authenticated' || user === null) {
    return null;
  }
  return allow.includes(user.role) ? user.role : null;
}
